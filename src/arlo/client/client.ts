import { Logger } from '../logging';
import type { ArloProvider } from '../provider';
import { Deferred, abortable, ErrorManager, sleep, TaskManager, UnauthorizedRestartException } from '../util';
import { MQTTEventStream } from './mqtt_stream';
import { BROWSER, Request } from './request';
import { ActionSpec, ArloEvent, EventDispatcher } from './stream';

export const USER_AGENTS = {
    arlo: '(iPhone15,2 18_1_1) iOS Arlo 5.4.3',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
    firefox: 'Mozilla/5.0 (X11; Linux i686; rv:135.0) Gecko/20100101 Firefox/135.0',
    linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    android: 'Mozilla/5.0 (Linux; U; Android 8.1.0; zh-cn; PACM00 Build/O11019) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/8.8 Mobile Safari/537.36',
};

const VALID_DEVICE_STATES = ['provisioned', 'synced'];

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

export interface StreamSipInfo {
    sipCallInfo: any;
    iceServers: { data: any[] };
}

export interface CloudStream {
    url: string;
    sipInfo?: StreamSipInfo;
}

class TtlCache<T> {
    private entries = new Map<string, { time: number, value: Promise<T> }>();

    constructor(private ttl: number) {
    }

    get(key: string, load: () => Promise<T>): Promise<T> {
        const entry = this.entries.get(key);
        if (entry && Date.now() - entry.time < this.ttl)
            return entry.value;
        const value = load();
        this.entries.set(key, { time: Date.now(), value });
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

export class ArloClient {
    arloUrl = 'my.arlo.com';
    arloApiUrl = 'myapi.arlo.com';
    authUrl = 'ocapi-app.arlo.com';

    logger: Logger;
    events: EventDispatcher;
    taskManager: TaskManager;
    errorManager: ErrorManager;
    heartbeatDevices: ArloDevice[] = [];
    cookies?: string;
    userId: string;
    browserAuthenticated?: Deferred<boolean>;
    eventStream?: MQTTEventStream;
    finalizedLogin = false;
    headers: Record<string, string> = {};
    loggedIn = false;
    mfaCodeFuture?: Deferred<string>;
    mfaLoopFuture?: Deferred<void>;
    mfaStateFuture?: Deferred<string>;
    mqttUrl = 'mqtt-cluster.arloxcld.com';
    mqttPort = 443;
    mqttTransport: 'tcp' | 'websockets' = 'tcp';
    request?: Request;
    token?: string;
    private heartbeatGeneration = 0;
    private devicesCache = new TtlCache<ArloDevice[]>(60_000);
    private deviceCapabilitiesCache = new TtlCache<any>(60_000);
    private smartFeaturesCache = new TtlCache<any>(60_000);
    private libraryCache = new TtlCache<any[]>(10_000);

    constructor(public provider: ArloProvider) {
        this.logger = new Logger('Arlo Client', provider.console);
        this.events = new EventDispatcher(this);
        this.taskManager = provider.taskManager;
        this.errorManager = provider.errorManager;
        this.cookies = this.checkCookies(provider.storage.getItem('arlo_cookies'));
        this.userId = provider.storage.getItem('arlo_user_id') ?? '';
    }

    private checkCookies(cookies: string | null): string | undefined {
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
            this.provider.storage.removeItem('arlo_cookies');
            return undefined;
        }
    }

    private async ignoreUnauthorized<T>(name: string, empty: T, call: () => Promise<T>): Promise<T> {
        try {
            return await call();
        }
        catch (e) {
            if (!(e instanceof UnauthorizedRestartException))
                throw e;
            this.logger.warn(`Session expired (401) in ${name}.`);
            return empty;
        }
    }

    async login(signal?: AbortSignal): Promise<void> {
        try {
            this.logger.info('Starting Arlo Cloud login...');
            this.headers = this.getHeaders();
            if (this.request)
                await this.request.renew();
            else
                this.request = await Request.create(this.provider, this.logger);
            if (this.cookies)
                this.request.loadsCookies(this.cookies);
            this.logger.debug(`Sending authentication request to ${this.authUrl}`);
            await this.request.options(`https://${this.authUrl}/api/auth`, { headers: this.headers, signal });
            const authResponse = await this.request.post(`https://${this.authUrl}/api/auth`, {
                params: {
                    EnvSource: 'prod',
                    email: this.provider.arloUsername,
                    language: 'en',
                    password: Buffer.from(this.provider.arloPassword, 'utf8').toString('base64'),
                },
                headers: this.headers,
                skipEventId: true,
                signal,
            });
            if (!authResponse)
                throw new Error('Arlo Cloud login failed, no auth response returned.');
            const authResponseData = 'data' in authResponse ? authResponse.data : authResponse;
            if (!authResponseData)
                throw new Error('Arlo Cloud login failed, no auth response data returned.');
            if (!this.userId) {
                this.userId = authResponseData.userId;
                this.provider.storage.setItem('arlo_user_id', this.userId);
            }
            this.token = authResponseData.token;
            this.headers = this.getHeaders();
            const mfaState: string = authResponseData.MFA_State;
            this.mfaStateFuture?.resolve(mfaState);
            if (mfaState === 'ENABLED') {
                this.logger.debug('MFA enabled, starting MFA flow...');
                await this.handleMfaFlow(authResponseData.issued, signal);
            }
            else if (mfaState === 'DISABLED') {
                this.logger.debug('MFA disabled, continuing login...');
                await this.completeLogin(signal);
            }
        }
        catch (e) {
            this.logger.debug(`Arlo Cloud login stopped: ${e}`);
            throw e;
        }
    }

    private getHeaders(): Record<string, string> {
        if (this.finalizedLogin) {
            return {
                'Auth-Version': '2',
                'Authorization': this.token ?? '',
                'User-Agent': BROWSER.userAgent,
                'Content-Type': 'application/json; charset=UTF-8',
            };
        }
        const headers: Record<string, string> = {
            'DNT': '1',
            'schemaVersion': '1',
            'Auth-Version': '2',
            'Content-Type': 'application/json; charset=UTF-8',
            'Origin': `https://${this.arloUrl}`,
            'Referer': `https://${this.arloUrl}/`,
            'Source': 'arloCamWeb',
            'TE': 'Trailers',
            'x-user-device-id': this.provider.arloDeviceId,
            'x-user-device-automation-name': 'QlJPV1NFUg==',
            'x-user-device-type': 'BROWSER',
            'X-Service-Version': '3',
            'Priority': 'u=1, i',
            'Host': this.authUrl,
            'User-Agent': BROWSER.userAgent,
        };
        if (this.token)
            headers.Authorization = Buffer.from(this.token, 'utf8').toString('base64');
        return headers;
    }

    private async handleMfaFlow(issued: unknown, signal?: AbortSignal): Promise<void> {
        const getFactorIdResponse = await this.getFactorId(signal);
        if (!getFactorIdResponse)
            throw new Error('No factor ID response returned.');
        const browserTrusted = getFactorIdResponse.meta?.code === 200;
        this.browserAuthenticated?.resolve(browserTrusted);
        if (!browserTrusted) {
            this.logger.debug('Browser not authenticated, starting browser authentication...');
            const getFactorsResponse = await this.getFactors(issued, signal);
            if (!getFactorsResponse)
                throw new Error('No factors response returned.');
            const items: any[] = getFactorsResponse.data?.items ?? [];
            this.logger.debug(`factorTypes: ${JSON.stringify(items.map(item => item.factorType))}`);
            this.logger.debug(`factorRoles: ${JSON.stringify(items.map(item => item.factorRole))}`);
            const factorId = items.find(item => (item.factorType === 'EMAIL' || item.factorType === 'SMS') && item.factorRole === 'PRIMARY')?.factorId;
            if (!factorId)
                throw new Error('Could not find valid 2FA method - is the primary 2FA set to either Email or SMS?');
            const startAuthResponse = await this.startAuth(factorId, signal);
            if (!startAuthResponse?.data)
                throw new Error('No start authentication response data returned.');
            const factorAuthCode = startAuthResponse.data.factorAuthCode;
            this.mfaLoopFuture?.resolve();
            const mfaCode = await this.waitForMfaCode(signal);
            const finishAuthResponse = await this.finishAuth(factorAuthCode, mfaCode, signal);
            if (!finishAuthResponse?.data)
                throw new Error('No finish authentication response data returned.');
            this.token = finishAuthResponse.data.token;
            this.headers = this.getHeaders();
            await this.validateAccessToken(signal);
            const startPairingFactorResponse = await this.startPairingFactor(finishAuthResponse.data.browserAuthCode, signal);
            if (!startPairingFactorResponse)
                throw new Error('No start pairing factor response returned.');
            await this.completeLogin(signal);
        }
        else {
            this.logger.debug('Browser authenticated, continuing login...');
            const startAuthResponse = await this.startAuth(getFactorIdResponse.data?.factorId, signal);
            if (!startAuthResponse?.data)
                throw new Error('No start authentication response data returned.');
            this.token = startAuthResponse.data.accessToken?.token;
            this.headers = this.getHeaders();
            await this.validateAccessToken(signal);
            await this.completeLogin(signal);
        }
    }

    private async getFactorId(signal?: AbortSignal): Promise<any> {
        this.logger.debug('Requesting MFA factor ID...');
        return this.request.post(`https://${this.authUrl}/api/getFactorId`, {
            params: { factorData: '', factorType: 'BROWSER', userId: this.userId },
            headers: this.headers,
            raw: true,
            skipEventId: true,
            signal,
        });
    }

    private async getFactors(data: unknown, signal?: AbortSignal): Promise<any> {
        this.logger.debug('Requesting MFA factors...');
        return this.request.get(`https://${this.authUrl}/api/getFactors`, {
            params: { data },
            headers: this.headers,
            raw: true,
            skipEventId: true,
            signal,
        });
    }

    private async startAuth(factorId: string, signal?: AbortSignal): Promise<any> {
        this.logger.debug('Starting MFA authentication...');
        return this.request.post(`https://${this.authUrl}/api/startAuth`, {
            params: { factorId, factorType: 'BROWSER', userId: this.userId },
            headers: this.headers,
            raw: true,
            skipEventId: true,
            signal,
        });
    }

    private async waitForMfaCode(signal?: AbortSignal): Promise<string> {
        this.logger.info('Waiting for MFA code from provider...');
        if (!this.mfaCodeFuture)
            throw new Error('No MFA code source was set up.');
        return abortable(this.mfaCodeFuture.promise, signal);
    }

    private async finishAuth(factorAuthCode: string, mfaCode: string, signal?: AbortSignal): Promise<any> {
        this.logger.debug('Finishing MFA authentication...');
        return this.request.post(`https://${this.authUrl}/api/finishAuth`, {
            params: { factorAuthCode, isBrowserTrusted: true, otp: mfaCode },
            headers: this.headers,
            raw: true,
            skipEventId: true,
            signal,
        });
    }

    private async validateAccessToken(signal?: AbortSignal): Promise<void> {
        this.logger.debug('Validating access token...');
        await this.request.get(`https://${this.authUrl}/api/validateAccessToken?data=${Math.floor(Date.now() / 1000)}`, {
            headers: this.headers,
            raw: true,
            skipEventId: true,
            signal,
        });
    }

    private async startPairingFactor(factorAuthCode: string, signal?: AbortSignal): Promise<any> {
        this.logger.debug('Starting pairing factor...');
        return this.request.post(`https://${this.authUrl}/api/startPairingFactor`, {
            params: { factorAuthCode, factorData: '', factorType: 'BROWSER' },
            headers: this.headers,
            raw: true,
            skipEventId: true,
            signal,
        });
    }

    private async completeLogin(signal?: AbortSignal): Promise<void> {
        await this.finalizeLogin();
        await this.userSession(signal);
        this.loggedIn = true;
        this.logger.info('Arlo Cloud login successful.');
    }

    private async finalizeLogin(): Promise<void> {
        this.cookies = this.request.dumpsCookies();
        await this.request.renew();
        this.request.loadsCookies(this.cookies);
        this.provider.storage.setItem('arlo_cookies', this.cookies);
        this.finalizedLogin = true;
        this.headers = this.getHeaders();
        for (const [name, value] of Object.entries(this.headers))
            this.request.session.headers.set(name, value);
    }

    async userSession(signal?: AbortSignal): Promise<void> {
        const sessionResponse = await this.request.get(`https://${this.arloApiUrl}/hmsweb/users/session/v3`, { headers: this.headers, raw: true, signal });
        if (sessionResponse?.success !== true) {
            this.logger.warn('Failed to fetch session details.');
            return;
        }
        const mqttUrl: string | undefined = sessionResponse.data?.mqttUrl;
        if (mqttUrl) {
            const parsedUrl = new URL(mqttUrl);
            this.mqttUrl = parsedUrl.hostname;
            this.mqttPort = Number(parsedUrl.port) || (parsedUrl.protocol === 'ws:' ? 80 : 443);
            this.mqttTransport = this.mqttPort === 443 ? 'tcp' : 'websockets';
        }
        this.logger.debug('User session established successfully.');
    }

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
                await this.request.put(`https://${this.arloApiUrl}/hmsweb/logout`, { suppressRestartOn401: true });
            }
            catch (e) {
                this.logger.warn(`Error during logout request: ${e}`);
            }
            await this.request.close().catch(() => { });
            this.request = undefined;
        }
        this.logger.debug('Arlo client logged out.');
    }

    resetSession(): void {
        this.finalizedLogin = false;
        this.token = undefined;
        this.loggedIn = false;
    }

    async getDevices(deviceType?: string[], deviceState = false): Promise<ArloDevice[]> {
        return this.ignoreUnauthorized('getDevices', [], async () => {
            let devices = await this.devicesCache.get('devices', () => this.request.get(`https://${this.arloApiUrl}/hmsweb/v2/users/devices`));
            if (deviceType)
                devices = devices.filter(device => deviceType.includes(device.deviceType));
            if (deviceState)
                devices = devices.filter(device => VALID_DEVICE_STATES.includes(device.state));
            return devices;
        });
    }

    async getDeviceCapabilities(device: ArloDevice): Promise<any> {
        const modelId = device.modelId.toLowerCase();
        return this.ignoreUnauthorized('getDeviceCapabilities', {}, () => this.deviceCapabilitiesCache.get(`${modelId}|${device.interfaceVersion}`,
            () => this.request.get(`https://${this.arloApiUrl}/resources/capabilities/${modelId}/${modelId}_${device.interfaceVersion}.json`, { raw: true })));
    }

    async getDeviceSmartFeatures(device: ArloDevice): Promise<any> {
        return this.ignoreUnauthorized('getDeviceSmartFeatures', {}, async () => {
            const smartFeatures = await this.smartFeaturesCache.get('features', () => this.request.get(`https://${this.arloApiUrl}/hmsweb/users/subscription/smart/features`));
            return smartFeatures?.features?.[`${device.owner.ownerId}_${device.deviceId}`] ?? {};
        });
    }

    async triggerProperties(basestation: ArloDevice, camera?: ArloDevice, { timeout, signal }: { timeout?: number, signal?: AbortSignal } = {}): Promise<Record<string, any>> {
        return this.ignoreUnauthorized('triggerProperties', {}, async () => {
            const deadline = timeout === undefined ? undefined : Date.now() + timeout;
            const resources = camera ? [`cameras/${camera.deviceId}`] : ['basestation'];
            if (camera && camera.deviceId === camera.parentId)
                resources.push('basestation');
            const properties: Record<string, any> = {};
            for (const resource of resources) {
                const trigger = () => this.notify(basestation, { action: 'get', resource, publishResponse: false }, signal);
                const callback = (event: ArloEvent) => {
                    if ('error' in event)
                        return undefined;
                    Object.assign(properties, event.properties ?? {});
                    return event.properties ?? {};
                };
                await this.triggerAndHandleEvents(resource, [['is', 'interfaceVersion']], trigger, callback, {
                    fromId: basestation.deviceId,
                    timeout: deadline && Math.max(0, deadline - Date.now()),
                    signal,
                });
            }
            return properties;
        });
    }

    async getLocations(): Promise<Record<string, string>> {
        return this.ignoreUnauthorized('getLocations', {}, async () => {
            const locations: Record<string, any[]> = await this.request.get(`https://${this.arloApiUrl}/hmsdevicemanagement/users/${this.userId}/locations`);
            return Object.fromEntries(Object.values(locations ?? {}).flat().map(location => [location.locationId, location.locationName]));
        });
    }

    async getModeAndRevision(): Promise<any> {
        return this.ignoreUnauthorized('getModeAndRevision', {}, () => this.request.get(`https://${this.arloApiUrl}/hmsweb/automation/v3/activeMode?locationId=all`, {
            headers: {
                'Origin': `https://${this.arloUrl}`,
                'Referer': `https://${this.arloUrl}/`,
                'x-user-device-id': this.userId,
                'x-forwarded-user': this.userId,
            },
        }));
    }

    async setMode(mode: string, location: string, nextRevision: string): Promise<void> {
        await this.ignoreUnauthorized('setMode', undefined, () => this.request.put(
            `https://${this.arloApiUrl}/hmsweb/automation/v3/activeMode?locationId=${location}&revision=${nextRevision}`, {
                params: { mode },
                headers: {
                    'Origin': `https://${this.arloUrl}`,
                    'Referer': `https://${this.arloUrl}/`,
                    'x-user-device-id': this.provider.arloDeviceId,
                    'x-forwarded-user': this.userId,
                },
            }));
    }

    async subscribe(basestationCameraTuples: [ArloDevice, ArloDevice][] = [], { startHeartbeat = true }: { startHeartbeat?: boolean } = {}): Promise<void> {
        await this.ignoreUnauthorized('subscribe', undefined, async () => {
            await this.errorManager.waitForAuthReady('event stream subscribe');
            let stream = this.eventStream;
            if (!stream || (!stream.initializing && !stream.connected)) {
                stream = this.eventStream = new MQTTEventStream(this);
                await stream.start();
            }
            await stream.waitConnected(10_000);
            if (!stream.connected || this.eventStream !== stream)
                throw new Error('Event stream failed to initialize or connect.');
            if (!basestationCameraTuples.length)
                return;
            const hardwiredModels = [
                'vmc3040', 'vmc3040s', 'vmc2060', 'vmc3060',
                'vmc2040', 'abc1000', 'avd1001', 'flw2001',
                'ac1001', 'ac2001',
                'vmb3010', 'vmb3500', 'vmb4000', 'vmb4500',
                'vmb4540', 'vmb5000', 'sh1001',
            ];
            const allDevices = new Map<string, ArloDevice>();
            for (const [basestation, camera] of basestationCameraTuples) {
                allDevices.set(basestation.deviceId, basestation);
                allDevices.set(camera.deviceId, camera);
            }
            this.heartbeatDevices = [...allDevices.values()].filter(device =>
                hardwiredModels.some(model => device.modelId?.toLowerCase().startsWith(model)));
            const topics = new Set<string>();
            for (const [basestation, camera] of basestationCameraTuples) {
                basestation.allowedMqttTopics?.forEach(topic => topics.add(topic));
                camera.allowedMqttTopics?.forEach(topic => topics.add(topic));
            }
            stream.subscribe([...topics]);
            if (startHeartbeat)
                await this.startHeartbeat();
            else if (this.provider.setupInProgress)
                await this.pingDevices(this.heartbeatDevices);
        });
    }

    async startHeartbeat(devices?: ArloDevice[], interval = 30_000): Promise<void> {
        if (devices)
            this.heartbeatDevices = devices;
        if (!this.heartbeatDevices.length)
            return;
        if (!this.eventStream?.active)
            return;
        this.logger.debug(`Will send heartbeat to the following devices: ${JSON.stringify(this.heartbeatDevices.map(device => device.deviceId))}`);
        const generation = ++this.heartbeatGeneration;
        await this.cancelHeartbeat();
        if (generation !== this.heartbeatGeneration)
            return;
        const heartbeatDevices = [...this.heartbeatDevices];
        this.taskManager.createTask(async signal => {
            while (this.eventStream?.active) {
                if (this.provider.setupInProgress) {
                    await sleep(1_000, signal);
                    continue;
                }
                await this.pingDevices(heartbeatDevices, signal);
                await sleep(interval, signal);
            }
        }, { tag: 'heartbeat', owner: this });
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
        await this.request.post(`https://${this.arloApiUrl}/hmsweb/users/devices/notify/${basestation.deviceId}`, {
            params: { ...body, transId: this.genTransId(), from: `${this.userId}_web`, to: basestation.deviceId },
            headers: { xcloudId: basestation.xCloudId ?? '' },
            signal,
        });
    }

    private genTransId(type = 'web'): string {
        return `${type}!${float2hex(Math.random() * 2 ** 32).toLowerCase()}!${Date.now()}`;
    }

    async unsubscribe(): Promise<void> {
        const stream = this.eventStream;
        this.eventStream = undefined;
        try {
            if (stream?.connected)
                await this.request.get(`https://${this.arloApiUrl}/hmsweb/client/unsubscribe`, { suppressRestartOn401: true });
        }
        catch (e) {
            this.logger.debug(`Error unsubscribing from Arlo events: ${e}`);
        }
        finally {
            await stream?.close();
        }
    }

    async cancelHeartbeat(): Promise<void> {
        await this.taskManager.cancelAndAwaitByTag('heartbeat', this);
    }

    subscribeToErrorEvents(camera: ArloDevice, callback: (code: unknown, message: unknown) => void): Unsubscribe {
        return this.events.listen(`cameras/${camera.deviceId}`, ['error', ['is', 'stateChangeReason']], event => {
            const error = 'error' in event ? event.error : event.properties?.stateChangeReason;
            if (error && Object.keys(error).length)
                callback(error.code, error.message);
        });
    }

    subscribeToMotionEvents(camera: ArloDevice, callback: (detected: boolean) => void, logger: Logger): Unsubscribe {
        return this.subscribeToMotionOrAudioEvents(camera, callback, logger, 'motionDetected');
    }

    subscribeToAudioEvents(camera: ArloDevice, callback: (detected: boolean) => void, logger: Logger): Unsubscribe {
        return this.subscribeToMotionOrAudioEvents(camera, callback, logger, 'audioDetected');
    }

    private subscribeToMotionOrAudioEvents(camera: ArloDevice, callback: (detected: boolean) => void, logger: Logger, eventKey: 'motionDetected' | 'audioDetected'): Unsubscribe {
        let resetTimer: NodeJS.Timeout | undefined;
        const resetAfter = (ms: number) => {
            clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
                logger.debug(`${eventKey}: false`);
                resetTimer = undefined;
                callback(false);
            }, ms);
        };
        const unsubscribe = this.events.listen(`cameras/${camera.deviceId}`, [['is', eventKey]], event => {
            const properties = event.properties ?? {};
            const keys = Object.keys(properties);
            if (keys.length !== 1 || keys[0] !== eventKey)
                return;
            const detected = properties[eventKey];
            logger.debug(`${eventKey}: ${detected}`);
            logger.debug(`${eventKey}: ${detected ? 'will force reset after 60s' : 'will delay delivery by 10s'}`);
            if (detected) {
                callback(detected);
                resetAfter(60_000);
            }
            else {
                resetAfter(10_000);
            }
        });
        return () => {
            unsubscribe();
            clearTimeout(resetTimer);
        };
    }

    subscribeToSmartMotionEvents(camera: ArloDevice, callback: (event: ArloEvent) => void): Unsubscribe {
        const uniqueId = `${this.userId}_${camera.deviceId}`;
        return this.events.listen('feedNotification', [null], event => {
            if (event.uniqueId === uniqueId)
                callback(event);
        });
    }

    subscribeToPropertyEvents(camera: ArloDevice, property: string, callback: (value: any) => void): Unsubscribe {
        return this.events.listen(`cameras/${camera.deviceId}`, [['is', property]], event => {
            if (event.properties && property in event.properties)
                callback(event.properties[property]);
        });
    }

    subscribeToDoorbellEvents(doorbell: ArloDevice, callback: (pressed: boolean) => void): Unsubscribe {
        let releaseTimer: NodeJS.Timeout | undefined;
        const unsubscribe = this.events.listen(`doorbells/${doorbell.deviceId}`, [['is', 'buttonPressed']], event => {
            if (!event.properties || !('buttonPressed' in event.properties))
                return;
            clearTimeout(releaseTimer);
            releaseTimer = setTimeout(() => callback(false), 1_000);
            callback(event.properties.buttonPressed);
        });
        return () => {
            unsubscribe();
            clearTimeout(releaseTimer);
        };
    }

    subscribeToActiveModeEvents(locationId: string, callback: (properties: any) => void): Unsubscribe {
        return this.events.listen('automation/activeMode', ['is'], event => {
            if (event.locationId === locationId && event.properties != null)
                callback(event.properties);
        });
    }

    subscribeToDeviceStateEvents(device: ArloDevice, callback: (state: 'available' | 'unavailable') => void): Unsubscribe {
        const deviceId = device.deviceId;
        const isWifiCamera = deviceId === device.parentId;
        const resources = isWifiCamera ? [`cameras/${deviceId}`, 'basestation'] : ['basestation', `subscriptions/${this.userId}_web`];
        const callbackWrapper = (event: ArloEvent) => {
            const properties = event.properties ?? {};
            const resource = event.resource ?? '';
            if (isWifiCamera) {
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
        const getAction = (resource: string): ActionSpec => {
            if (resource.startsWith('subscriptions/'))
                return 'is';
            return resource !== 'basestation' || isWifiCamera ? ['is', 'connectionState'] : ['is', 'state'];
        };
        const unsubscribes = resources.map(resource => this.events.listen(resource, [getAction(resource)], callbackWrapper, { fromId: deviceId }));
        return () => unsubscribes.forEach(unsubscribe => unsubscribe());
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

    async triggerFullFrameSnapshot(camera: ArloDevice, { timeout, signal }: { timeout?: number, signal?: AbortSignal } = {}): Promise<string> {
        const resource = `cameras/${camera.deviceId}`;
        const actions: ActionSpec[] = [];
        for (const action of ['fullFrameSnapshotAvailable', 'lastImageSnapshotAvailable', 'is'])
            for (const property of ['presignedFullFrameSnapshotUrl', 'presignedLastImageUrl'])
                actions.push([action, property]);
        const trigger = () => this.request.post(`https://${this.arloApiUrl}/hmsweb/users/devices/fullFrameSnapshot`, {
            params: {
                to: camera.parentId,
                from: `${this.userId}_web`,
                resource,
                action: 'set',
                publishResponse: true,
                transId: this.genTransId(),
                properties: { activityState: 'fullFrameSnapshot' },
            },
            headers: { xcloudId: camera.xCloudId ?? '' },
            signal,
        });
        const callback = (event: ArloEvent) => {
            if ('error' in event)
                return undefined;
            return event.properties?.presignedFullFrameSnapshotUrl || event.properties?.presignedLastImageUrl || undefined;
        };
        return this.triggerAndHandleEvents(resource, actions, trigger, callback, { timeout, signal });
    }

    async startStream(camera: ArloDevice, eager = true, { timeout, signal }: { timeout?: number, signal?: AbortSignal } = {}): Promise<CloudStream> {
        const resource = `cameras/${camera.deviceId}`;
        const stream: CloudStream = { url: '' };
        const trigger = async () => {
            const response = await this.request.post(`https://${this.arloApiUrl}/hmsweb/users/devices/startStream`, {
                params: {
                    to: camera.parentId,
                    from: `${this.userId}_web`,
                    resource,
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
        const callback = (event: ArloEvent) => {
            if ('error' in event)
                return undefined;
            return event.properties?.activityState === 'userStreamActive' && stream.url ? stream : undefined;
        };
        return this.triggerAndHandleEvents(resource, [['is', 'activityState']], trigger, callback, { timeout, signal });
    }

    subscribeToPushToTalkEvents(camera: ArloDevice, type: 'answerSdp' | 'answerCandidate', callback: (data: any) => void): Unsubscribe {
        return this.events.listen(`cameras/${camera.deviceId}`, ['pushToTalk'], event => {
            if (event.properties?.type === type)
                callback(event.properties.data);
        }, { replay: false });
    }

    private async triggerAndHandleEvents<T>(resource: string, actions: ActionSpec[], trigger: () => Promise<unknown>, callback: (event: ArloEvent) => T | undefined,
        { fromId, timeout, signal }: { fromId?: string, timeout?: number, signal?: AbortSignal } = {}): Promise<T> {
        await this.subscribe();
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const result = this.events.waitFor(resource, actions, callback, { fromId, replay: false, timeout, signal: controller.signal });
        result.catch(() => { });
        try {
            await trigger();
            return await result;
        }
        finally {
            controller.abort();
            signal?.removeEventListener('abort', onAbort);
        }
    }

    async getSipInfoV2(camera: ArloDevice): Promise<any> {
        const url = `https://${this.arloApiUrl}/hmsweb/users/devices/sipInfo/v2?cameraId=${camera.deviceId}`
            + `&modelId=${camera.modelId.toUpperCase()}&uniqueId=${camera.uniqueId}`;
        return this.ignoreUnauthorized('getSipInfoV2', undefined, () => this.request.get(url, {
            headers: { xcloudId: camera.xCloudId ?? '', cameraId: camera.deviceId },
        }));
    }

    async startPushToTalk(camera: ArloDevice): Promise<[sessionId: string, iceServers: any[]] | undefined> {
        return this.ignoreUnauthorized('startPushToTalk', undefined, async () => {
            const response = await this.request.get(`https://${this.arloApiUrl}/hmsweb/users/devices/${this.userId}_${camera.deviceId}/pushtotalk`);
            return [response.uSessionId, response.data];
        });
    }

    async notifyPushToTalkOfferSdp(basestation: ArloDevice, camera: ArloDevice, sessionId: string, sdp: string): Promise<void> {
        await this.ignoreUnauthorized('notifyPushToTalkOfferSdp', undefined,
            () => this.notifyPushToTalk(basestation, camera, sessionId, sdp, 'offerSdp', true));
    }

    async notifyPushToTalkOfferCandidate(basestation: ArloDevice, camera: ArloDevice, sessionId: string, candidate: string): Promise<void> {
        await this.ignoreUnauthorized('notifyPushToTalkOfferCandidate', undefined,
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

    async setSiren(basestation: ArloDevice, camera: ArloDevice | undefined, on: boolean): Promise<void> {
        await this.ignoreUnauthorized('setSiren', undefined, () => this.notify(basestation, {
            action: 'set',
            resource: camera ? `siren/${camera.deviceId}` : 'siren',
            publishResponse: true,
            properties: { sirenState: on ? 'on' : 'off', duration: 300, volume: 8, pattern: 'alarm' },
        }));
    }

    async setSpotlight(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setChildDevice('setSpotlight', basestation, camera.deviceId, { spotlight: { enabled: on } });
    }

    async setFloodlight(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setChildDevice('setFloodlight', basestation, camera.deviceId, { floodlight: { on } });
    }

    async setNightlight(basestation: ArloDevice, on: boolean): Promise<void> {
        await this.setChildDevice('setNightlight', basestation, basestation.deviceId, { nightLight: { enabled: on } });
    }

    async setChargeNotificationLed(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setChildDevice('setChargeNotificationLed', basestation, camera.deviceId, { chargeNotificationLedEnable: on });
    }

    async setStatusLight(basestation: ArloDevice, camera: ArloDevice, on: boolean): Promise<void> {
        await this.setChildDevice('setStatusLight', basestation, camera.deviceId, { idleLedEnable: on });
    }

    async setBrightness(basestation: ArloDevice, camera: ArloDevice, brightness: number): Promise<void> {
        await this.setChildDevice('setBrightness', basestation, camera.deviceId, { brightness });
    }

    private async setChildDevice(name: string, basestation: ArloDevice, deviceId: string, properties: Record<string, unknown>): Promise<void> {
        await this.ignoreUnauthorized(name, undefined, () => this.notify(basestation, {
            action: 'set',
            resource: `cameras/${deviceId}`,
            publishResponse: true,
            properties,
        }));
    }

    async restartDevice(deviceId: string): Promise<void> {
        await this.ignoreUnauthorized('restartDevice', undefined, () => this.request.post(`https://${this.arloApiUrl}/hmsweb/users/devices/restart`, {
            params: { deviceId },
            headers: this.deviceManagementHeaders(),
        }));
    }

    async createCertificates(basestation: ArloDevice, publicKey: string): Promise<any> {
        return this.ignoreUnauthorized('createCertificates', undefined, () => this.request.post(`https://${this.arloApiUrl}/hmsweb/users/devices/v2/security/cert/create`, {
            params: { uuid: this.provider.arloDeviceId, publicKey, uniqueIds: [basestation.uniqueId] },
            headers: this.deviceManagementHeaders(),
        }));
    }

    private deviceManagementHeaders(): Record<string, string> {
        return {
            'Origin': `https://${this.arloApiUrl}`,
            'Referer': `https://${this.arloApiUrl}/`,
            'x-user-device-id': this.provider.arloDeviceId,
            'x-forwarded-user': this.userId,
        };
    }

    async getLibrary(device: ArloDevice, from: Date, to: Date, noCache = false): Promise<any[]> {
        return this.ignoreUnauthorized('getLibrary', [], async () => {
            const dateFrom = formatDate(new Date(from.getTime() - 86_400_000));
            const dateTo = formatDate(new Date(to.getTime() + 86_400_000));
            const getLibrary = () => this.request.post(`https://${this.arloApiUrl}/hmsweb/users/library`, { params: { dateFrom, dateTo } });
            const results: any[] = noCache ? await getLibrary() : await this.libraryCache.get(`${dateFrom}|${dateTo}`, getLibrary);
            return results.filter(result => {
                const time = Number(result.name);
                return result.deviceId === device.deviceId && time >= from.getTime() && time <= to.getTime();
            });
        });
    }
}
