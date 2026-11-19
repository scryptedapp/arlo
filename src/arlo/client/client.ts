import { Logger } from '../logging';
import { Deferred, abortable, ErrorManager, sleep, TaskManager, UnauthorizedError } from '../util';
import { MQTTEventStream } from './mqtt_stream';
import { Request, RequestOptions } from './request';
import { ActionSpec, ArloEvent, DispatcherHost, EventDispatcher } from './stream';

export const USER_AGENTS = {
    arlo: '(iPhone15,2 18_1_1) iOS Arlo 5.4.3',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
    firefox: 'Mozilla/5.0 (X11; Linux i686; rv:135.0) Gecko/20100101 Firefox/135.0',
    linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    android: 'Mozilla/5.0 (Linux; U; Android 8.1.0; zh-cn; PACM00 Build/O11019) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/8.8 Mobile Safari/537.36',
};

const ARLO_URL = 'my.arlo.com';
const API_URL = 'myapi.arlo.com';
const AUTH_URL = 'ocapi-app.arlo.com';

const VALID_DEVICE_STATES = ['provisioned', 'synced'];

// Wired models that only send events while they are pinged.
const HARDWIRED_MODELS = [
    'vmc3040', 'vmc3040s', 'vmc2060', 'vmc3060',
    'vmc2040', 'abc1000', 'avd1001', 'flw2001',
    'ac1001', 'ac2001',
    'vmb3010', 'vmb3500', 'vmb4000', 'vmb4500',
    'vmb4540', 'vmb5000', 'sh1001',
];

const HEARTBEAT_INTERVAL = 30_000;

// An Arlo device as the devices API returns it.
export interface ArloDevice {
    deviceId: string;
    deviceName: string;
    deviceType: string;
    parentId: string;
    modelId: string;
    uniqueId?: string;
    xCloudId?: string;
    state?: string;
    interfaceVersion?: string;
    firmwareVersion?: string;
    owner: { ownerId: string };
    allowedMqttTopics?: string[];
    properties?: Record<string, any>;
    [key: string]: any;
}

export type Unsubscribe = () => void;

// The SIP session Arlo hands out with a cloud stream, shaped as the sipInfo
// request returns it.
export interface StreamSipInfo {
    sipCallInfo: any;
    iceServers: { data: any[] };
}

export interface CloudStream {
    url: string;
    sipInfo?: StreamSipInfo;
}

// What the client needs from the provider.
export interface ArloClientHost extends DispatcherHost {
    readonly console: Console;
    readonly storage: Storage;
    readonly taskManager: TaskManager;
    readonly errorManager: ErrorManager;
    readonly arloUsername: string;
    readonly arloPassword: string;
    readonly arloDeviceId: string;
    readonly mvssEnabled: boolean;
    requestRestart(scope: 'event_stream'): void;
}

// Caches a value per key for ttl milliseconds. Callers asking at the same time
// share one request, and failures are not cached.
class TtlCache<T> {
    private readonly entries = new Map<string, { time: number, value: Promise<T> }>();

    constructor(private readonly ttl: number) {
    }

    get(key: string, load: () => Promise<T>): Promise<T> {
        const entry = this.entries.get(key);
        if (entry && Date.now() - entry.time < this.ttl)
            return entry.value;
        const value = load();
        this.entries.set(key, { time: Date.now(), value });
        // Not a newer entry made after this one expired.
        value.catch(() => this.entries.get(key)?.value === value && this.entries.delete(key));
        return value;
    }
}

function float2hex(value: number, maxHexadecimals = 15): string {
    const whole = Math.trunc(value);
    let fraction = value - whole;
    let result = whole.toString(16);
    if (fraction === 0)
        return result;
    result += '.';
    for (let count = 0; fraction && count < maxHexadecimals; count++) {
        fraction *= 16;
        const digit = Math.trunc(fraction);
        result += digit.toString(16).toUpperCase();
        fraction -= digit;
    }
    return result;
}

function formatDate(date: Date): string {
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

// The Arlo Cloud API: login with multi-factor authentication, device and
// account requests, the event stream, and the commands devices send.
export class ArloClient {
    readonly logger: Logger;
    readonly events: EventDispatcher;
    private request?: Request;
    private cookies?: string;
    private token?: string;
    private headers: Record<string, string> = {};
    private finalizedLogin = false;
    loggedIn = false;
    userId: string;
    mqttUrl = 'mqtt-cluster.arloxcld.com';
    mqttPort = 443;
    mqttTransport: 'tcp' | 'websockets' = 'tcp';
    eventStream?: MQTTEventStream;
    private heartbeatDevices: ArloDevice[] = [];
    private heartbeatGeneration = 0;
    private readonly devicesCache = new TtlCache<ArloDevice[]>(60_000);
    private readonly capabilitiesCache = new TtlCache<any>(60_000);
    private readonly smartFeaturesCache = new TtlCache<any>(60_000);
    private readonly libraryCache = new TtlCache<any[]>(10_000);

    // Set by the provider before login, to follow the MFA steps.
    mfaState?: Deferred<string>;
    browserAuthenticated?: Deferred<boolean>;
    mfaLoop?: Deferred<void>;
    mfaCode?: Deferred<string>;

    constructor(private readonly host: ArloClientHost) {
        this.logger = new Logger('Arlo Client', host.console);
        this.events = new EventDispatcher(host, this.logger);
        this.userId = host.storage.getItem('arlo_user_id') ?? '';
        this.cookies = this.loadStoredCookies();
    }

    private get taskManager(): TaskManager {
        return this.host.taskManager;
    }

    private get errorManager(): ErrorManager {
        return this.host.errorManager;
    }

    get mvssEnabled(): boolean {
        return this.host.mvssEnabled;
    }

    get authorization(): string {
        return this.headers.Authorization ?? '';
    }

    private get api(): Request {
        if (!this.request)
            throw new Error('Arlo Cloud client is not logged in.');
        return this.request;
    }

    private loadStoredCookies(): string | undefined {
        const cookies = this.host.storage.getItem('arlo_cookies');
        if (!cookies)
            return undefined;
        try {
            const parsed = JSON.parse(cookies);
            if (!parsed || typeof parsed !== 'object' || Object.values(parsed).some(value => typeof value !== 'string'))
                throw new Error('cookies are not a map of strings');
            return cookies;
        }
        catch (e) {
            this.logger.debug(`Invalid stored cookies, discarding them: ${e}`);
            this.host.storage.removeItem('arlo_cookies');
            return undefined;
        }
    }

    // Session expiry is handled by the ErrorManager's recovery, so API calls
    // return an empty result for it instead of failing.
    private async ignoreUnauthorized<T>(name: string, empty: T, call: () => Promise<T>): Promise<T> {
        try {
            return await call();
        }
        catch (e) {
            if (!(e instanceof UnauthorizedError))
                throw e;
            this.logger.warn(`Session expired (401) in ${name}.`);
            return empty;
        }
    }

    // Login.

    async login(signal?: AbortSignal): Promise<void> {
        try {
            this.logger.info('Starting Arlo Cloud login...');
            this.headers = this.getHeaders();
            if (this.request)
                await this.request.renew();
            else
                this.request = await Request.create(this.errorManager, this.logger);
            if (this.cookies)
                this.request.loadCookies(this.cookies);
            this.logger.debug(`Sending authentication request to ${AUTH_URL}`);
            await this.request.options(`https://${AUTH_URL}/api/auth`, { headers: this.headers, signal });
            const response = await this.request.post(`https://${AUTH_URL}/api/auth`, {
                params: {
                    EnvSource: 'prod',
                    email: this.host.arloUsername,
                    language: 'en',
                    password: Buffer.from(this.host.arloPassword, 'utf8').toString('base64'),
                },
                headers: this.headers,
                skipEventId: true,
                signal,
            });
            if (!response)
                throw new Error('Arlo Cloud login failed, no auth response returned.');
            const data = 'data' in response ? response.data : response;
            if (!data)
                throw new Error('Arlo Cloud login failed, no auth response data returned.');
            if (!this.userId) {
                this.userId = data.userId;
                this.host.storage.setItem('arlo_user_id', this.userId);
            }
            this.token = data.token;
            this.headers = this.getHeaders();
            const mfaState: string = data.MFA_State;
            this.mfaState?.resolve(mfaState);
            if (mfaState === 'ENABLED') {
                this.logger.debug('MFA enabled, starting MFA flow...');
                await this.handleMfaFlow(data.issued, signal);
            }
            else if (mfaState === 'DISABLED') {
                this.logger.debug('MFA disabled, continuing login...');
                await this.completeLogin(signal);
            }
        }
        catch (e) {
            this.logger.error('Arlo Cloud login failed:', e);
            throw e;
        }
    }

    private getHeaders(): Record<string, string> {
        if (this.finalizedLogin) {
            return {
                'Auth-Version': '2',
                'Authorization': this.token ?? '',
                'User-Agent': USER_AGENTS.linux,
                'Content-Type': 'application/json; charset=UTF-8',
            };
        }
        const headers: Record<string, string> = {
            'DNT': '1',
            'schemaVersion': '1',
            'Auth-Version': '2',
            'Content-Type': 'application/json; charset=UTF-8',
            'Origin': `https://${ARLO_URL}`,
            'Referer': `https://${ARLO_URL}/`,
            'Source': 'arloCamWeb',
            'TE': 'Trailers',
            'x-user-device-id': this.host.arloDeviceId,
            'x-user-device-automation-name': 'QlJPV1NFUg==',
            'x-user-device-type': 'BROWSER',
            'X-Service-Version': '3',
            'Priority': 'u=1, i',
            'Host': AUTH_URL,
            'User-Agent': USER_AGENTS.linux,
        };
        if (this.token)
            headers.Authorization = Buffer.from(this.token, 'utf8').toString('base64');
        return headers;
    }

    // An untrusted browser is sent a code by email or SMS, which the provider
    // supplies through mfaCode; a trusted browser goes straight through.
    private async handleMfaFlow(issued: unknown, signal?: AbortSignal): Promise<void> {
        const authOptions = (params: Record<string, unknown>): RequestOptions => ({ params, headers: this.headers, raw: true, skipEventId: true, signal });
        const factorIdResponse = await this.api.post(`https://${AUTH_URL}/api/getFactorId`,
            authOptions({ factorData: '', factorType: 'BROWSER', userId: this.userId }));
        if (!factorIdResponse)
            throw new Error('No factor ID response returned.');
        const browserTrusted = factorIdResponse.meta?.code === 200;
        this.browserAuthenticated?.resolve(browserTrusted);
        if (browserTrusted) {
            this.logger.debug('Browser authenticated, continuing login...');
            const startAuth = await this.api.post(`https://${AUTH_URL}/api/startAuth`,
                authOptions({ factorId: factorIdResponse.data?.factorId, factorType: 'BROWSER', userId: this.userId }));
            if (!startAuth?.data)
                throw new Error('No start authentication response data returned.');
            this.token = startAuth.data.accessToken?.token;
            this.headers = this.getHeaders();
            await this.validateAccessToken(signal);
            await this.completeLogin(signal);
            return;
        }

        this.logger.debug('Browser not authenticated, starting browser authentication...');
        const factors = await this.api.get(`https://${AUTH_URL}/api/getFactors`, authOptions({ data: issued }));
        if (!factors)
            throw new Error('No factors response returned.');
        const items: any[] = factors.data?.items ?? [];
        this.logger.debug(`factorTypes: ${JSON.stringify(items.map(item => item.factorType))}`);
        this.logger.debug(`factorRoles: ${JSON.stringify(items.map(item => item.factorRole))}`);
        const factorId = items.find(item => (item.factorType === 'EMAIL' || item.factorType === 'SMS') && item.factorRole === 'PRIMARY')?.factorId;
        if (!factorId)
            throw new Error('Could not find valid 2FA method - is the primary 2FA set to either Email or SMS?');
        const startAuth = await this.api.post(`https://${AUTH_URL}/api/startAuth`,
            authOptions({ factorId, factorType: 'BROWSER', userId: this.userId }));
        if (!startAuth?.data)
            throw new Error('No start authentication response data returned.');
        const factorAuthCode = startAuth.data.factorAuthCode;
        this.mfaLoop?.resolve();
        this.logger.info('Waiting for MFA code from provider...');
        if (!this.mfaCode)
            throw new Error('No MFA code source was set up.');
        const otp = await abortable(this.mfaCode.promise, signal);
        const finishAuth = await this.api.post(`https://${AUTH_URL}/api/finishAuth`,
            authOptions({ factorAuthCode, isBrowserTrusted: true, otp }));
        if (!finishAuth?.data)
            throw new Error('No finish authentication response data returned.');
        this.token = finishAuth.data.token;
        this.headers = this.getHeaders();
        await this.validateAccessToken(signal);
        const pairing = await this.api.post(`https://${AUTH_URL}/api/startPairingFactor`,
            authOptions({ factorAuthCode: finishAuth.data.browserAuthCode, factorData: '', factorType: 'BROWSER' }));
        if (!pairing)
            throw new Error('No start pairing factor response returned.');
        await this.completeLogin(signal);
    }

    private async validateAccessToken(signal?: AbortSignal): Promise<void> {
        this.logger.debug('Validating access token...');
        await this.api.get(`https://${AUTH_URL}/api/validateAccessToken?data=${Math.floor(Date.now() / 1000)}`,
            { headers: this.headers, raw: true, skipEventId: true, signal });
    }

    private async completeLogin(signal?: AbortSignal): Promise<void> {
        await this.finalizeLogin();
        await this.userSession(signal);
        this.loggedIn = true;
        this.logger.info('Arlo Cloud login successful.');
    }

    // Keeps the login cookies in storage and moves to a fresh session that
    // sends the session token with every request.
    private async finalizeLogin(): Promise<void> {
        this.cookies = this.api.dumpCookies();
        await this.api.renew();
        this.api.loadCookies(this.cookies);
        this.host.storage.setItem('arlo_cookies', this.cookies);
        this.finalizedLogin = true;
        this.headers = this.getHeaders();
        this.api.setHeaders(this.headers);
    }

    private async userSession(signal?: AbortSignal): Promise<void> {
        const session = await this.api.get(`https://${API_URL}/hmsweb/users/session/v3`, { headers: this.headers, raw: true, signal });
        if (session?.success !== true) {
            this.logger.warn('Failed to fetch session details.');
            return;
        }
        const mqttUrl: string | undefined = session.data?.mqttUrl;
        if (mqttUrl) {
            const parsed = new URL(mqttUrl);
            this.mqttUrl = parsed.hostname;
            this.mqttPort = Number(parsed.port) || (parsed.protocol === 'ws:' ? 80 : 443);
            this.mqttTransport = this.mqttPort === 443 ? 'tcp' : 'websockets';
        }
        this.logger.debug('User session established successfully.');
    }

    // Ends the session: stops the client's tasks and event stream and logs out.
    async restart(): Promise<void> {
        this.logger.debug('Restarting Arlo client: performing full logout and reset and preparing for new login.');
        await this.taskManager.cancelAndAwaitByOwner(this);
        try {
            await this.unsubscribe();
        }
        catch (e) {
            this.logger.warn(`Error during unsubscribe: ${e}`);
        }
        if (this.request) {
            try {
                await this.request.put(`https://${API_URL}/hmsweb/logout`, { suppressRestartOn401: true });
            }
            catch (e) {
                this.logger.warn(`Error during logout request: ${e}`);
            }
            await this.request.close().catch(() => { });
            this.request = undefined;
        }
        this.logger.debug('Arlo client logged out.');
    }

    // Marks the session ended so the next login starts afresh, keeping the
    // event listeners.
    resetSession(): void {
        this.finalizedLogin = false;
        this.token = undefined;
        this.loggedIn = false;
    }

    // Devices and account.

    async getDevices(deviceTypes?: string[], validStateOnly = false): Promise<ArloDevice[]> {
        return this.ignoreUnauthorized('get_devices', [], async () => {
            let devices = await this.devicesCache.get('devices', () => this.api.get(`https://${API_URL}/hmsweb/v2/users/devices`));
            if (deviceTypes)
                devices = devices.filter(device => deviceTypes.includes(device.deviceType));
            if (validStateOnly)
                devices = devices.filter(device => VALID_DEVICE_STATES.includes(device.state ?? ''));
            return devices;
        });
    }

    async getDeviceCapabilities(device: ArloDevice): Promise<any> {
        const modelId = String(device.modelId).toLowerCase();
        return this.ignoreUnauthorized('get_device_capabilities', {}, () => this.capabilitiesCache.get(`${modelId}|${device.interfaceVersion}`,
            () => this.api.get(`https://${API_URL}/resources/capabilities/${modelId}/${modelId}_${device.interfaceVersion}.json`, { raw: true })));
    }

    async getDeviceSmartFeatures(device: ArloDevice): Promise<any> {
        return this.ignoreUnauthorized('get_device_smart_features', {}, async () => {
            const smartFeatures = await this.smartFeaturesCache.get('features', () => this.api.get(`https://${API_URL}/hmsweb/users/subscription/smart/features`));
            return smartFeatures?.features?.[`${device.owner.ownerId}_${device.deviceId}`] ?? {};
        });
    }

    // Asks the basestation for a device's properties, which arrive as events.
    // A camera on its own (Wi-Fi) also reports the basestation resource.
    async triggerProperties(basestation: ArloDevice, camera?: ArloDevice, { timeout, signal }: { timeout?: number, signal?: AbortSignal } = {}): Promise<Record<string, any>> {
        return this.ignoreUnauthorized('trigger_properties', {}, async () => {
            const deadline = timeout === undefined ? undefined : Date.now() + timeout;
            const resources = camera ? [`cameras/${camera.deviceId}`] : ['basestation'];
            if (camera && camera.deviceId === camera.parentId)
                resources.push('basestation');
            const properties: Record<string, any> = {};
            await this.subscribe();
            for (const resource of resources) {
                await this.triggerAndWait(waitSignal => this.events.waitFor(resource, [['is', 'interfaceVersion']], event => {
                    if ('error' in event)
                        return undefined;
                    Object.assign(properties, event.properties ?? {});
                    return event.properties ?? {};
                }, { fromId: basestation.deviceId, replay: false, timeout: deadline && Math.max(0, deadline - Date.now()), signal: waitSignal }),
                () => this.notify(basestation, { action: 'get', resource, publishResponse: false }, signal), signal);
            }
            return properties;
        });
    }

    async getLocations(): Promise<Record<string, string>> {
        return this.ignoreUnauthorized('get_locations', {}, async () => {
            const locations = await this.api.get(`https://${API_URL}/hmsdevicemanagement/users/${this.userId}/locations`);
            const result: Record<string, string> = {};
            for (const list of Object.values(locations ?? {}) as any[][])
                list.forEach(location => result[location.locationId] = location.locationName);
            return result;
        });
    }

    async getModeAndRevision(): Promise<any> {
        return this.ignoreUnauthorized('get_mode_and_revision', {}, () => this.api.get(`https://${API_URL}/hmsweb/automation/v3/activeMode?locationId=all`, {
            headers: {
                'Origin': `https://${ARLO_URL}`,
                'Referer': `https://${ARLO_URL}/`,
                'x-user-device-id': this.userId,
                'x-forwarded-user': this.userId,
            },
        }));
    }

    async setMode(mode: string, location: string, nextRevision: string): Promise<void> {
        await this.ignoreUnauthorized('set_mode', undefined, () => this.api.put(
            `https://${API_URL}/hmsweb/automation/v3/activeMode?locationId=${location}&revision=${nextRevision}`, {
                params: { mode },
                headers: {
                    'Origin': `https://${ARLO_URL}`,
                    'Referer': `https://${ARLO_URL}/`,
                    'x-user-device-id': this.host.arloDeviceId,
                    'x-forwarded-user': this.userId,
                },
            }));
    }

    async restartDevice(deviceId: string): Promise<void> {
        await this.ignoreUnauthorized('restart_device', undefined, () => this.api.post(`https://${API_URL}/hmsweb/users/devices/restart`, {
            params: { deviceId },
            headers: this.deviceManagementHeaders(),
        }));
    }

    async createCertificates(basestation: ArloDevice, publicKey: string): Promise<any> {
        return this.ignoreUnauthorized('create_certificates', undefined, () => this.api.post(`https://${API_URL}/hmsweb/users/devices/v2/security/cert/create`, {
            params: { uuid: this.host.arloDeviceId, publicKey, uniqueIds: [basestation.uniqueId] },
            headers: this.deviceManagementHeaders(),
        }));
    }

    private deviceManagementHeaders(): Record<string, string> {
        return {
            'Origin': `https://${API_URL}`,
            'Referer': `https://${API_URL}/`,
            'x-user-device-id': this.host.arloDeviceId,
            'x-forwarded-user': this.userId,
        };
    }

    // Recordings of device between from and to. The library is requested for
    // whole days, a day either side, and filtered here.
    async getLibrary(device: ArloDevice, from: Date, to: Date, noCache = false): Promise<any[]> {
        return this.ignoreUnauthorized('get_library', [], async () => {
            const dateFrom = formatDate(new Date(from.getTime() - 86_400_000));
            const dateTo = formatDate(new Date(to.getTime() + 86_400_000));
            const load = () => this.api.post(`https://${API_URL}/hmsweb/users/library`, { params: { dateFrom, dateTo } });
            const results: any[] = noCache ? await load() : await this.libraryCache.get(`${dateFrom}|${dateTo}`, load);
            return results.filter(result => {
                const time = Number(result.name);
                return result.deviceId === device.deviceId && time >= from.getTime() && time <= to.getTime();
            });
        });
    }

    // Registers for the event a request will cause, sends the request, and
    // returns what wait resolves with. The listener is removed however this
    // ends, including when the request fails.
    private async triggerAndWait<T>(wait: (signal: AbortSignal) => Promise<T>, trigger: () => Promise<void>, signal?: AbortSignal): Promise<T> {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const waiting = wait(controller.signal);
        waiting.catch(() => { });
        try {
            await trigger();
            return await waiting;
        }
        finally {
            controller.abort();
            signal?.removeEventListener('abort', onAbort);
        }
    }

    // Event stream.

    // Starts the event stream if it is not running, then subscribes to the
    // MQTT topics of the given devices and pings the hardwired ones.
    async subscribe(basestationCameraPairs: [ArloDevice, ArloDevice][] = [], { startHeartbeat = true }: { startHeartbeat?: boolean } = {}): Promise<void> {
        await this.ignoreUnauthorized('subscribe', undefined, async () => {
            await this.errorManager.waitForAuthReady('event stream subscribe');
            let stream = this.eventStream;
            if (!stream || (!stream.initializing && !stream.connected)) {
                stream = this.eventStream = new MQTTEventStream(this, this.events, this);
                await stream.start();
            }
            await stream.waitConnected(10_000);
            if (!stream.connected || this.eventStream !== stream)
                throw new Error('Event stream failed to initialize or connect.');
            if (!basestationCameraPairs.length)
                return;
            const devices = new Map<string, ArloDevice>();
            basestationCameraPairs.forEach(([basestation, camera]) => {
                devices.set(basestation.deviceId, basestation);
                devices.set(camera.deviceId, camera);
            });
            this.heartbeatDevices = [...devices.values()].filter(device =>
                HARDWIRED_MODELS.some(model => String(device.modelId ?? '').toLowerCase().startsWith(model)));
            const topics = new Set<string>();
            for (const [basestation, camera] of basestationCameraPairs) {
                basestation.allowedMqttTopics?.forEach(topic => topics.add(topic));
                camera.allowedMqttTopics?.forEach(topic => topics.add(topic));
            }
            this.eventStream.subscribe([...topics]);
            if (startHeartbeat)
                await this.startHeartbeat();
            else if (this.host.setupInProgress)
                await this.pingDevices(this.heartbeatDevices);
        });
    }

    async unsubscribe(): Promise<void> {
        const stream = this.eventStream;
        this.eventStream = undefined;
        try {
            if (stream?.connected)
                await this.api.get(`https://${API_URL}/hmsweb/client/unsubscribe`, { suppressRestartOn401: true });
        }
        catch (e) {
            this.logger.debug(`Error unsubscribing from Arlo events: ${e}`);
        }
        finally {
            await stream?.close();
        }
    }

    // Hooks for the event stream.

    waitForAuthReady(reason: string): Promise<void> {
        return this.errorManager.waitForAuthReady(reason);
    }

    requestRestart(scope: 'event_stream'): void {
        this.host.requestRestart(scope);
    }

    requestAuthRecovery(reason: string): void {
        this.errorManager.requestAuthRecovery(reason);
    }

    // Pings the hardwired devices every 30 seconds while the event stream is
    // up, outside device setup.
    async startHeartbeat(devices?: ArloDevice[]): Promise<void> {
        if (devices)
            this.heartbeatDevices = devices;
        if (!this.heartbeatDevices.length)
            return;
        if (!this.eventStream?.active)
            return;
        this.logger.debug(`Will send heartbeat to the following devices: ${JSON.stringify(this.heartbeatDevices.map(device => device.deviceId))}`);
        // Of two starts at once, only the later one runs a heartbeat.
        const generation = ++this.heartbeatGeneration;
        await this.cancelHeartbeat();
        if (generation !== this.heartbeatGeneration)
            return;
        const heartbeatDevices = [...this.heartbeatDevices];
        this.taskManager.createTask(async signal => {
            while (this.eventStream?.active) {
                if (this.host.setupInProgress) {
                    await sleep(1_000, signal);
                    continue;
                }
                await this.pingDevices(heartbeatDevices, signal);
                await sleep(HEARTBEAT_INTERVAL, signal);
            }
        }, { tag: 'heartbeat', owner: this });
    }

    async cancelHeartbeat(): Promise<void> {
        await this.taskManager.cancelAndAwaitByTag('heartbeat', this);
    }

    private async pingDevices(devices: ArloDevice[], signal?: AbortSignal): Promise<void> {
        for (const device of devices) {
            try {
                await this.notify(device, {
                    action: 'set',
                    resource: `subscriptions/${this.userId}_web`,
                    publishResponse: false,
                    properties: { devices: [device.deviceId] },
                }, signal);
            }
            catch (e) {
                if (signal?.aborted)
                    throw e;
            }
        }
    }

    private async notify(basestation: ArloDevice, body: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
        await this.api.post(`https://${API_URL}/hmsweb/users/devices/notify/${basestation.deviceId}`, {
            params: { ...body, transId: this.genTransId(), from: `${this.userId}_web`, to: basestation.deviceId },
            headers: { xcloudId: basestation.xCloudId ?? '' },
            signal,
        });
    }

    private genTransId(type = 'web'): string {
        return `${type}!${float2hex(Math.random() * 2 ** 32).toLowerCase()}!${Date.now()}`;
    }

    // Event subscriptions. Each returns a function that ends it.

    subscribeToErrorEvents(camera: ArloDevice, callback: (code: unknown, message: unknown) => void): Unsubscribe {
        return this.events.listen(`cameras/${camera.deviceId}`, ['error', ['is', 'stateChangeReason']], event => {
            const error = 'error' in event ? event.error : event.properties?.stateChangeReason;
            if (error && Object.keys(error).length)
                callback(error.code, error.message);
        });
    }

    subscribeToMotionEvents(camera: ArloDevice, callback: (detected: boolean) => void, logger: Logger): Unsubscribe {
        return this.subscribeToDetection(camera, callback, logger, 'motionDetected');
    }

    subscribeToAudioEvents(camera: ArloDevice, callback: (detected: boolean) => void, logger: Logger): Unsubscribe {
        return this.subscribeToDetection(camera, callback, logger, 'audioDetected');
    }

    // A detection is reported at once and cleared after 60 seconds at most; its
    // end is delivered 10 seconds late, in case it starts again.
    private subscribeToDetection(camera: ArloDevice, callback: (detected: boolean) => void, logger: Logger, key: 'motionDetected' | 'audioDetected'): Unsubscribe {
        let reset: NodeJS.Timeout | undefined;
        const resetAfter = (ms: number) => {
            clearTimeout(reset);
            reset = setTimeout(() => {
                logger.debug(`${key}: false`);
                reset = undefined;
                callback(false);
            }, ms);
        };
        const stop = this.events.listen(`cameras/${camera.deviceId}`, [['is', key]], event => {
            const properties = event.properties ?? {};
            const keys = Object.keys(properties);
            if (keys.length !== 1 || keys[0] !== key)
                return;
            const detected = properties[key];
            logger.debug(`${key}: ${detected}`);
            logger.debug(`${key}: ${detected ? 'will force reset after 60s' : 'will delay delivery by 10s'}`);
            if (detected) {
                callback(detected);
                resetAfter(60_000);
            }
            else {
                resetAfter(10_000);
            }
        });
        return () => {
            stop();
            clearTimeout(reset);
        };
    }

    subscribeToSmartMotionEvents(camera: ArloDevice, callback: (event: ArloEvent) => void): Unsubscribe {
        const uniqueId = `${this.userId}_${camera.deviceId}`;
        return this.events.listen('feedNotification', [null], event => {
            if (event.uniqueId === uniqueId)
                callback(event);
        });
    }

    // Battery level, charge notification LED, brightness and other camera
    // properties reported on their own.
    subscribeToPropertyEvents(camera: ArloDevice, property: string, callback: (value: any) => void): Unsubscribe {
        return this.events.listen(`cameras/${camera.deviceId}`, [['is', property]], event => {
            if (event.properties && property in event.properties)
                callback(event.properties[property]);
        });
    }

    subscribeToDoorbellEvents(doorbell: ArloDevice, callback: (pressed: boolean) => void): Unsubscribe {
        let release: NodeJS.Timeout | undefined;
        const stop = this.events.listen(`doorbells/${doorbell.deviceId}`, [['is', 'buttonPressed']], event => {
            if (!event.properties || !('buttonPressed' in event.properties))
                return;
            clearTimeout(release);
            release = setTimeout(() => callback(false), 1_000);
            callback(event.properties.buttonPressed);
        });
        return () => {
            stop();
            clearTimeout(release);
        };
    }

    subscribeToActiveModeEvents(locationId: string, callback: (properties: any) => void): Unsubscribe {
        return this.events.listen('automation/activeMode', ['is'], event => {
            if (event.locationId === locationId && event.properties != null)
                callback(event.properties);
        });
    }

    // Reports 'available' and 'unavailable'. A camera on its own (Wi-Fi) is
    // followed through its own and the basestation resource; a camera on a
    // basestation through the basestation's state and the web subscription.
    subscribeToDeviceStateEvents(device: ArloDevice, callback: (state: 'available' | 'unavailable') => void): Unsubscribe {
        const deviceId = device.deviceId;
        const wifi = deviceId === device.parentId;
        const subscriptions = `subscriptions/${this.userId}_web`;
        const resources = wifi ? [`cameras/${deviceId}`, 'basestation'] : ['basestation', subscriptions];
        const handle = (event: ArloEvent) => {
            const properties = event.properties ?? {};
            const resource = event.resource ?? '';
            if (wifi) {
                if (resource.startsWith('cameras/') && properties.connectionState === 'unavailable')
                    callback('unavailable');
                else if (resource === 'basestation' && properties.connectionState === 'available')
                    callback('available');
            }
            else {
                if (resource === 'basestation' && properties.state === 'rebooting')
                    callback('unavailable');
                else if (resource.startsWith('subscriptions/') && properties.devices?.includes(deviceId))
                    callback('available');
            }
        };
        const stops = resources.map(resource => {
            const action: ActionSpec = resource === subscriptions ? 'is'
                : resource !== 'basestation' || wifi ? ['is', 'connectionState'] : ['is', 'state'];
            return this.events.listen(resource, [action], handle, { fromId: deviceId });
        });
        return () => stops.forEach(stop => stop());
    }

    subscribeToActivityStateEvents(camera: ArloDevice, callback: (state: string) => void): Unsubscribe {
        const fromId = camera.deviceId === camera.parentId ? camera.deviceId : camera.parentId;
        return this.events.listen(`cameras/${camera.deviceId}`, [['is', 'activityState']], event => {
            if (!('to' in event) && event.properties && 'activityState' in event.properties)
                callback(event.properties.activityState);
        }, { fromId });
    }

    subscribeToSnapshotEvents(camera: ArloDevice, callback: (url: string) => void): Unsubscribe {
        return this.events.listen(`cameras/${camera.deviceId}`, [
            ['fullFrameSnapshotAvailable', 'presignedFullFrameSnapshotUrl'],
            ['lastImageSnapshotAvailable', 'presignedLastImageUrl'],
        ], event => {
            if ('to' in event || 'error' in event)
                return;
            const url = event.properties?.presignedFullFrameSnapshotUrl || event.properties?.presignedLastImageUrl;
            if (url)
                callback(url);
        });
    }

    // WebRTC push-to-talk answers, by type: 'answerSdp' or 'answerCandidate'.
    // An earlier session's answer is not replayed to a new one.
    subscribeToPushToTalkEvents(camera: ArloDevice, type: 'answerSdp' | 'answerCandidate', callback: (data: any) => void): Unsubscribe {
        return this.events.listen(`cameras/${camera.deviceId}`, ['pushToTalk'], event => {
            if (event.properties?.type === type)
                callback(event.properties.data);
        }, { replay: false });
    }

    // Snapshots and streams.

    async triggerFullFrameSnapshot(camera: ArloDevice, { timeout, signal }: { timeout?: number, signal?: AbortSignal } = {}): Promise<string> {
        const actions: ActionSpec[] = [];
        for (const action of ['fullFrameSnapshotAvailable', 'lastImageSnapshotAvailable', 'is'])
            for (const property of ['presignedFullFrameSnapshotUrl', 'presignedLastImageUrl'])
                actions.push([action, property]);
        await this.subscribe();
        return this.triggerAndWait(waitSignal => this.events.waitFor(`cameras/${camera.deviceId}`, actions, event => {
            if ('error' in event)
                return undefined;
            return event.properties?.presignedFullFrameSnapshotUrl || event.properties?.presignedLastImageUrl || undefined;
        }, { replay: false, timeout, signal: waitSignal }), () => this.api.post(`https://${API_URL}/hmsweb/users/devices/fullFrameSnapshot`, {
            params: {
                to: camera.parentId,
                from: `${this.userId}_web`,
                resource: `cameras/${camera.deviceId}`,
                action: 'set',
                publishResponse: true,
                transId: this.genTransId(),
                properties: { activityState: 'fullFrameSnapshot' },
            },
            headers: { xcloudId: camera.xCloudId ?? '' },
            signal,
        }), signal);
    }

    // Starts a cloud RTSP stream and returns its URL. With eager off, waits for
    // the camera to report the stream active first. For cameras whose intercom
    // talks over SIP, Arlo answers with the SIP session for talking during this
    // stream as well.
    async startStream(camera: ArloDevice, eager = true, { timeout, signal }: { timeout?: number, signal?: AbortSignal } = {}): Promise<CloudStream> {
        const stream: CloudStream = { url: '' };
        const trigger = async () => {
            const response = await this.api.post(`https://${API_URL}/hmsweb/users/devices/startStream`, {
                params: {
                    to: camera.parentId,
                    from: `${this.userId}_web`,
                    resource: `cameras/${camera.deviceId}`,
                    action: 'set',
                    responseUrl: '',
                    publishResponse: true,
                    transId: this.genTransId(),
                    properties: { activityState: 'startUserStream', cameraId: camera.deviceId },
                },
                headers: { xcloudId: camera.xCloudId ?? '', 'User-Agent': USER_AGENTS.android },
                signal,
            });
            if (!response?.url)
                throw new Error('Arlo did not return a stream URL.');
            stream.url = String(response.url).replace('rtsp://', 'rtsps://');
            if (response.sipCallInfo && response.iceServers)
                stream.sipInfo = { sipCallInfo: response.sipCallInfo, iceServers: response.iceServers };
        };
        if (eager) {
            await trigger();
            return stream;
        }
        await this.subscribe();
        return this.triggerAndWait(waitSignal => this.events.waitFor(`cameras/${camera.deviceId}`, [['is', 'activityState']], event => {
            if ('error' in event)
                return undefined;
            return event.properties?.activityState === 'userStreamActive' && stream.url ? stream : undefined;
        }, { replay: false, timeout, signal: waitSignal }), trigger, signal);
    }

    // SIP streaming and push to talk. The SIP-only intercom takes its SIP
    // session from the cloud stream instead of a sipInfo request.

    async getSipInfoV2(camera: ArloDevice): Promise<any> {
        const url = `https://${API_URL}/hmsweb/users/devices/sipInfo/v2?cameraId=${camera.deviceId}`
            + `&modelId=${String(camera.modelId ?? '').toUpperCase()}&uniqueId=${camera.uniqueId}`;
        return this.ignoreUnauthorized('get_sip_info_v2', undefined, () => this.api.get(url, {
            headers: { xcloudId: camera.xCloudId ?? '', cameraId: camera.deviceId },
        }));
    }

    async startPushToTalk(camera: ArloDevice): Promise<[sessionId: string, iceServers: any[]] | undefined> {
        return this.ignoreUnauthorized('start_push_to_talk', undefined, async () => {
            const response = await this.api.get(`https://${API_URL}/hmsweb/users/devices/${this.userId}_${camera.deviceId}/pushtotalk`);
            return [response.uSessionId, response.data];
        });
    }

    async notifyPushToTalkOfferSdp(basestation: ArloDevice, camera: ArloDevice, sessionId: string, sdp: string): Promise<void> {
        await this.ignoreUnauthorized('notify_push_to_talk_offer_sdp', undefined,
            () => this.notifyPushToTalk(basestation, camera, sessionId, sdp, 'offerSdp', true));
    }

    async notifyPushToTalkOfferCandidate(basestation: ArloDevice, camera: ArloDevice, sessionId: string, candidate: string): Promise<void> {
        await this.ignoreUnauthorized('notify_push_to_talk_offer_candidate', undefined,
            () => this.notifyPushToTalk(basestation, camera, sessionId, candidate, 'offerCandidate', false));
    }

    private async notifyPushToTalk(basestation: ArloDevice, camera: ArloDevice, sessionId: string, data: string, type: string, publishResponse: boolean): Promise<void> {
        await this.notify(basestation, {
            action: 'pushToTalk',
            resource: `cameras/${camera.deviceId}`,
            publishResponse,
            properties: { data, type, uSessionId: sessionId },
        });
    }

    // Lights, sirens and camera settings.

    // Sounds or silences the basestation's siren, or a camera's when camera is
    // given.
    async setSiren(basestation: ArloDevice, camera: ArloDevice | undefined, on: boolean): Promise<void> {
        await this.ignoreUnauthorized('set_siren', undefined, () => this.notify(basestation, {
            action: 'set',
            resource: camera ? `siren/${camera.deviceId}` : 'siren',
            publishResponse: true,
            properties: { sirenState: on ? 'on' : 'off', duration: 300, volume: 8, pattern: 'alarm' },
        }));
    }

    async setSpotlight(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setCameraProperties('set_spotlight', basestation, camera.deviceId, { spotlight: { enabled: on } });
    }

    async setFloodlight(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setCameraProperties('set_floodlight', basestation, camera.deviceId, { floodlight: { on } });
    }

    async setNightlight(basestation: ArloDevice, on: boolean): Promise<void> {
        await this.setCameraProperties('set_nightlight', basestation, basestation.deviceId, { nightLight: { enabled: on } });
    }

    async setChargeNotificationLed(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setCameraProperties('set_charge_notification_led', basestation, camera.deviceId, { chargeNotificationLedEnable: on });
    }

    async setStatusLight(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setCameraProperties('set_status_light', basestation, camera.deviceId, { idleLedEnable: on });
    }

    // Arlo brightness runs from -2 to 2.
    async setBrightness(basestation: ArloDevice, camera: ArloDevice, brightness: number): Promise<void> {
        await this.setCameraProperties('set_brightness', basestation, camera.deviceId, { brightness });
    }

    private async setCameraProperties(name: string, basestation: ArloDevice, deviceId: string, properties: Record<string, unknown>): Promise<void> {
        await this.ignoreUnauthorized(name, undefined, () => this.notify(basestation, {
            action: 'set',
            resource: `cameras/${deviceId}`,
            publishResponse: true,
            properties,
        }));
    }
}
