import crypto from 'node:crypto';

import sdk, { Device, DeviceProvider, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { ImapFlow, MessageStructureObject } from 'imapflow';

import { ArloDeviceBase } from './base';
import { ArloBasestation } from './basestation';
import { ArloCamera } from './camera';
import { ArloClient, ArloClientHost, ArloDevice, browseArloServices } from './client';
import { initImpers } from './client/request';
import { ArloDoorbell } from './doorbell';
import { LOG_LEVELS, Logger, LogLevel, setLogLevel } from './logging';
import {
    abortable,
    AsyncEvent,
    AsyncLock,
    CancelledError,
    Deferred,
    ErrorManager,
    RateLimitedError,
    sleep,
    Task,
    TaskManager,
    TimeoutError,
    TransientRequestError,
    UnauthorizedError,
    withTimeout,
} from './util';
import { ArloModeVirtualSecuritySystem } from './vss';

const DEVICE_TYPE_BASESTATION = 'basestation';
const DEVICE_TYPE_SIREN = 'siren';
const DEVICE_TYPE_CAMERA = 'camera';
const DEVICE_TYPE_ARLOQ = 'arloq';
const DEVICE_TYPE_ARLOQS = 'arloqs';
const DEVICE_TYPE_DOORBELL = 'doorbell';

const MFA_STRATEGIES = ['Manual', 'IMAP'];
const LOGIN_COOLDOWN = 60_000;
// The longest Scrypted's request for a device waits while the plugin builds
// its devices after loading.
const BUILD_WAIT = 60_000;
// A failed login is not retried, so that Arlo and Cloudflare see no repeated
// attempts.
const LOGIN_AGAIN = 'The plugin does not retry; restart it, or turn on Force Re-Authentication, to log in again.';
const MANUAL_MFA_TIMEOUT = 278_000;
// Browser authentication is refreshed every 14 days to avoid MFA churn.
const HARD_LOGIN_INTERVAL = 14 * 24 * 60 * 60_000;

export type RestartScope = 'plugin' | 'restart' | 'relogin' | 'refresh_login_loop' | 'event_stream';

export interface ModeVirtualSecuritySystemInfo {
    location_name: string;
    deviceName: string;
}

function byName<T extends { deviceName: string }>(a: T, b: T): number {
    return String(a.deviceName).toLowerCase().localeCompare(String(b.deviceName).toLowerCase());
}

function sortedMap<T>(map: Map<string, T>, key: (value: T) => string): Map<string, T> {
    return new Map([...map].sort(([, a], [, b]) => key(a).toLowerCase().localeCompare(key(b).toLowerCase())));
}

function minuteFloor(time: number): number {
    return Math.floor(time / 60_000) * 60_000;
}

function extractMfaCode(text: string): string | undefined {
    return /\b(\d{6})\b/.exec(text)?.[1];
}

function htmlToText(html: string): string {
    return html
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&amp;/gi, '&');
}

// The plugin itself: settings, Arlo Cloud login with multi-factor
// authentication, device discovery, and the periodic and on-demand restarts
// that keep the session and event stream fresh.
export class ArloProvider extends ScryptedDeviceBase implements DeviceProvider, Settings, ArloClientHost {
    readonly logger = new Logger('Arlo Provider', this.console);
    readonly taskManager = new TaskManager(this.logger);
    readonly errorManager: ErrorManager;

    readonly storageSettings = new StorageSettings(this, {
        arlo_username: {
            group: 'General',
            title: 'Arlo Username',
        },
        arlo_password: {
            group: 'General',
            title: 'Arlo Password',
            type: 'password',
        },
        mfa_strategy: {
            group: 'General',
            title: 'Multi-Factor Strategy',
            description: 'Mechanism to fetch the multi-factor code for Arlo login. Save after changing this field for more settings.',
            choices: MFA_STRATEGIES,
            defaultValue: 'Manual',
        },
        force_mfa_reauthentication: {
            group: 'General',
            title: 'Force Re-Authentication',
            description: 'Forces the plugin to re-authenticate with Arlo, this resets the plugin and forces new multi-factor authentication.',
            type: 'boolean',
            noStore: true,
            defaultValue: false,
        },
        arlo_mfa_code: {
            group: 'Manual MFA',
            title: 'Multi-Factor Authentication Code',
            description: 'Enter the code sent by Arlo to your e-mail or phone number.',
            noStore: true,
        },
        imap_mfa_host: {
            group: 'IMAP MFA',
            title: 'IMAP Hostname',
        },
        imap_mfa_port: {
            group: 'IMAP MFA',
            title: 'IMAP Port',
            type: 'number',
            defaultValue: 993,
        },
        imap_mfa_username: {
            group: 'IMAP MFA',
            title: 'IMAP Username',
        },
        imap_mfa_password: {
            group: 'IMAP MFA',
            title: 'IMAP Password',
            type: 'password',
        },
        imap_mfa_sender: {
            group: 'IMAP MFA',
            title: 'IMAP Email Sender',
            description: 'The sender email address to search for when loading MFA codes. See plugin README for more details.',
            defaultValue: 'do_not_reply@arlo.com',
        },
        event_stream_refresh_interval: {
            group: 'General',
            title: 'Refresh Event Stream Interval',
            description: 'Interval, in minutes, to refresh the underlying event stream connection to Arlo Cloud. A value of 0 disables this feature.',
            type: 'number',
            defaultValue: 90,
        },
        device_discovery_interval: {
            group: 'General',
            title: 'Device Discovery Interval',
            description: 'Interval, in minutes, to periodically discover and update devices from the Arlo Cloud. A value of 0 disables this feature.',
            type: 'number',
            defaultValue: 15,
        },
        device_refresh_interval: {
            group: 'General',
            title: 'Device Refresh Interval',
            description: 'Interval, in minutes, to refresh all device properties from the Arlo Cloud. A value of 0 disables this feature.',
            type: 'number',
            defaultValue: 240,
        },
        plugin_log_level: {
            group: 'General',
            title: 'Logging Level',
            description: 'Choose the logging level for the plugin. This will affect the amount of information logged to the console.',
            choices: [...LOG_LEVELS],
            defaultValue: 'Info',
        },
        hidden_devices: {
            group: 'General',
            title: 'Hidden Devices',
            description: 'Select the Arlo devices to hide in this plugin. Hidden devices will be removed from Scrypted and will not be re-added when the plugin reloads.',
            multiple: true,
            defaultValue: [],
            onGet: async () => ({ choices: this.allDeviceIds }),
        },
        mvss_enabled: {
            group: 'General',
            title: 'Control Arlo Security Modes',
            description: 'Allow Scrypted to handle changing Security Modes in the Arlo App.',
            type: 'boolean',
            defaultValue: false,
        },
        auto_snapshot_generation: {
            group: 'General',
            title: 'Automatic Snapshot Generation',
            description: 'Allow Scrypted to automatically refresh snapshots for faster downstream plugins.',
            type: 'boolean',
            defaultValue: false,
        },
        disable_plugin: {
            group: 'General',
            title: 'Disable Arlo Plugin',
            description: 'Disables the Arlo Plugin.',
            type: 'boolean',
            defaultValue: false,
        },
    });

    arlo?: ArloClient;
    arloBasestations = new Map<string, ArloDevice>();
    arloCameras = new Map<string, ArloDevice>();
    arloMvss = new Map<string, ModeVirtualSecuritySystemInfo>();
    allDeviceIds: string[] = [];
    readonly scryptedDevices = new Map<string, ArloDeviceBase>();
    // Scrypted asks for every device it knows as soon as the plugin loads,
    // before login, discovery and creation. Until that first build ends, a
    // request waits for its device instead of finding none, which would leave
    // the device and its children unavailable.
    private building = true;
    private readonly deviceWaiters = new Map<string, Deferred<ArloDeviceBase | undefined>>();
    // The object Scrypted was last given for each device. Scrypted keeps using
    // it until told to fetch the device again, so a device rebuilt after an
    // internal restart is reported with refresh.
    private readonly handedOut = new Map<string, ArloDeviceBase>();
    setupInProgress = false;
    fullResetNeeded = false;

    private readonly initializeLock = new AsyncLock();
    private readonly restartLock = new AsyncLock();
    private readonly periodicLock = new AsyncLock();
    readonly deviceLock = new AsyncLock();
    private readonly imapReady = new AsyncEvent();
    private activeLogin?: Deferred<boolean>;
    private lastLoginAttempt = 0;
    private manualMfaCode?: Deferred<string>;
    private mfaState?: Deferred<string>;
    private browserAuthenticated?: Deferred<boolean>;
    private mfaLoop?: Deferred<void>;
    private mfaCode?: Deferred<string>;

    constructor(nativeId?: string) {
        super(nativeId);
        this.errorManager = new ErrorManager(this, {
            recoverAuth: (reason, signal) => this.recoverAuth(reason, signal),
            restartPlugin: () => this.requestRestart('plugin'),
        });
        this.storageSettings.options = {
            hide: {
                arlo_mfa_code: async () => this.mfaStrategy !== 'Manual',
                imap_mfa_host: async () => this.mfaStrategy !== 'IMAP',
                imap_mfa_port: async () => this.mfaStrategy !== 'IMAP',
                imap_mfa_username: async () => this.mfaStrategy !== 'IMAP',
                imap_mfa_password: async () => this.mfaStrategy !== 'IMAP',
                imap_mfa_sender: async () => this.mfaStrategy !== 'IMAP',
            },
        };
        this.propagateLogLevel();
        this.taskManager.createTask(() => initImpers(this.logger), { tag: 'impers', owner: this });
        this.taskManager.createTask(signal => this.initializePlugin(signal), { tag: 'initialize_plugin', owner: this });
    }

    // Settings the client and devices read.

    get arloUsername(): string {
        return this.storageSettings.values.arlo_username ?? '';
    }

    get arloPassword(): string {
        return this.storageSettings.values.arlo_password ?? '';
    }

    get arloDeviceId(): string {
        let deviceId = this.storage.getItem('arlo_device_id');
        if (!deviceId) {
            deviceId = crypto.randomUUID();
            this.storage.setItem('arlo_device_id', deviceId);
        }
        return deviceId;
    }

    get mvssEnabled(): boolean {
        return !!this.storageSettings.values.mvss_enabled;
    }

    get autoSnapshotGeneration(): boolean {
        return !!this.storageSettings.values.auto_snapshot_generation;
    }

    get oneLocation(): boolean {
        return this.storage.getItem('one_location') === 'true';
    }

    get mdnsServices(): Record<string, { server: string, address: string, deviceId: string }> {
        try {
            return JSON.parse(this.storage.getItem('mdns_services') ?? '{}');
        }
        catch {
            return {};
        }
    }

    get hiddenDeviceIds(): string[] {
        return (this.storageSettings.values.hidden_devices as string[] ?? [])
            .map(entry => /.*\((.*)\)$/.exec(entry)?.[1])
            .filter((id): id is string => !!id);
    }

    private get mfaStrategy(): string {
        return this.storageSettings.values.mfa_strategy;
    }

    private get disablePlugin(): boolean {
        return !!this.storageSettings.values.disable_plugin;
    }

    private get eventStreamRefreshInterval(): number {
        return this.storageSettings.values.event_stream_refresh_interval;
    }

    private get deviceDiscoveryInterval(): number {
        return this.storageSettings.values.device_discovery_interval;
    }

    private get deviceRefreshInterval(): number {
        return this.storageSettings.values.device_refresh_interval;
    }

    // The RSA key pair basestations issue local streaming certificates for.
    get arloPublicKey(): string {
        if (!this.storage.getItem('arlo_public_key'))
            this.generateArloKeypair();
        return this.storage.getItem('arlo_public_key')!;
    }

    get arloPrivateKey(): string {
        if (!this.storage.getItem('arlo_private_key'))
            this.generateArloKeypair();
        return this.storage.getItem('arlo_private_key')!;
    }

    generateArloKeypair(): void {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        this.storage.setItem('arlo_public_key', publicKey);
        this.storage.setItem('arlo_private_key', privateKey);
    }

    private propagateLogLevel(): void {
        const level = this.storageSettings.values.plugin_log_level as LogLevel;
        setLogLevel(LOG_LEVELS.includes(level) ? level : 'Info');
        this.logger.info(`Setting plugin log level to ${level}`);
    }

    private settingsChanged(): void {
        this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => { });
    }

    // Startup.

    private async initializePlugin(signal?: AbortSignal, { awaitLogin = false }: { awaitLogin?: boolean } = {}): Promise<void> {
        if (this.initializeLock.locked) {
            this.logger.debug('Plugin initialization already in progress, waiting for it to complete.');
            return;
        }
        await this.initializeLock.run(async () => {
            if (this.errorManager.handleRateLimitStartup()) {
                this.endBuild();
                return;
            }
            if (this.disablePlugin) {
                this.logger.info('Plugin has been disabled. Will not initialize Arlo client.');
                this.logger.info('To re-enable the plugin, uncheck the "Disable Arlo Plugin" setting.');
                this.endBuild();
                return;
            }
            try {
                this.fullResetNeeded = true;
                this.settingsChanged();
                this.logger.debug(`Using Device ID: ${this.arloDeviceId}`);
                if (!this.arloUsername || !this.arloPassword) {
                    this.logger.info('Arlo Cloud username or password not set. Waiting for user to enter credentials.');
                    this.endBuild();
                    return;
                }
                this.taskManager.cancelAllExcept('initialize_plugin', this);
                this.logger.info('Initializing Arlo plugin...');
                if (awaitLogin)
                    await this.login(signal);
                else
                    this.taskManager.createTask(loginSignal => this.login(loginSignal), { tag: 'login', owner: this });
                this.taskManager.createTask(periodicSignal => this.periodicDiscovery(periodicSignal), { tag: 'periodic_discovery', owner: this });
                this.taskManager.createTask(periodicSignal => this.periodicRefresh(periodicSignal), { tag: 'periodic_refresh', owner: this });
                this.settingsChanged();
            }
            catch (e) {
                this.endBuild();
                if (!(e instanceof CancelledError))
                    this.logger.error('Error during plugin initialization:', e);
            }
        }, signal);
    }

    private async periodicDiscovery(signal: AbortSignal): Promise<void> {
        if (this.deviceDiscoveryInterval <= 0) {
            this.logger.debug('Device discovery interval is 0; periodic discovery will not run.');
            return;
        }
        while (true) {
            await sleep(this.deviceDiscoveryInterval * 60_000, signal);
            try {
                await this.periodicLock.run(async () => {
                    this.setupInProgress = true;
                    this.logger.info('Running periodic device discovery...');
                    await this.deviceHandler(true, signal);
                }, signal);
            }
            catch (e) {
                if (signal.aborted)
                    throw e;
                this.logger.error('Error during periodic device discovery:', e);
            }
            finally {
                this.setupInProgress = false;
                this.arlo?.events.releaseHeld();
                if (this.arlo?.loggedIn)
                    await this.arlo.startHeartbeat();
            }
        }
    }

    private async periodicRefresh(signal: AbortSignal): Promise<void> {
        if (this.deviceRefreshInterval <= 0) {
            this.logger.debug('Device refresh interval is 0; periodic refresh will not run.');
            return;
        }
        while (true) {
            await sleep(this.deviceRefreshInterval * 60_000, signal);
            try {
                const devices = await this.periodicLock.run(async () => {
                    this.logger.info('Running periodic device refresh...');
                    return this.deviceLock.run(async () => [...this.scryptedDevices.values()], signal);
                }, signal);
                for (const device of devices) {
                    if (device instanceof ArloModeVirtualSecuritySystem)
                        continue;
                    try {
                        await device.refreshDevice();
                    }
                    catch (e) {
                        this.logger.error(`Error refreshing ${device.arloDevice.deviceName}:`, e);
                    }
                }
            }
            catch (e) {
                if (signal.aborted)
                    throw e;
                this.logger.error('Error during periodic device refresh:', e);
            }
        }
    }

    // Login.

    private async login(signal?: AbortSignal): Promise<void> {
        if (this.activeLogin && !this.activeLogin.done) {
            this.logger.debug('Login already in progress, waiting for it to complete.');
            await abortable(this.activeLogin.promise, signal);
            return;
        }
        const result = new Deferred<boolean>();
        this.activeLogin = result;
        this.errorManager.beginAuthTransition('Arlo Cloud login');
        let transitionOpen = true;
        let loginTask: Task<void> | undefined;
        try {
            const cooldown = LOGIN_COOLDOWN - (Date.now() - this.lastLoginAttempt);
            if (cooldown > 0) {
                this.logger.info(`Login attempt delayed: waiting ${Math.floor(cooldown / 1000)} seconds due to cooldown.`);
                await sleep(cooldown, signal);
            }
            this.lastLoginAttempt = Date.now();
            let arlo: ArloClient;
            if (this.fullResetNeeded) {
                await this.resetArloClient();
                arlo = new ArloClient(this);
            }
            else {
                arlo = this.arlo ?? new ArloClient(this);
            }
            this.mfaState = arlo.mfaState = new Deferred();
            this.browserAuthenticated = arlo.browserAuthenticated = new Deferred();
            this.mfaLoop = arlo.mfaLoop = new Deferred();
            this.mfaCode = arlo.mfaCode = new Deferred();
            this.logger.debug('Setup ArloClient and MFA futures.');
            const task = loginTask = this.taskManager.createTask(loginSignal => arlo.login(loginSignal), { tag: 'login-arlo', owner: this });

            // Waits for a step of the login, failing if the login ends first.
            const loginStep = async <T>(step: Deferred<T>, description: string): Promise<T> => {
                const ended = task.promise.then(() => false, () => false);
                const reached = step.promise.then(() => true);
                if (!await abortable(Promise.race([reached, ended]), signal) && !step.done) {
                    await task.promise;
                    throw new Error(`Arlo Cloud login ended before ${description} was available.`);
                }
                return step.promise;
            };

            this.logger.debug('Waiting for MFA state from Arlo Cloud...');
            const mfaState = await loginStep(this.mfaState, 'MFA state');
            const browserAuthenticated = mfaState === 'ENABLED'
                ? await loginStep(this.browserAuthenticated, 'browser authentication state')
                : true;
            if (mfaState === 'ENABLED' && !browserAuthenticated) {
                const mfaStartTime = Date.now();
                await loginStep(this.mfaLoop, 'MFA challenge');
                if (this.mfaStrategy === 'IMAP') {
                    this.logger.debug('Using IMAP strategy for MFA code retrieval.');
                    this.taskManager.createTask(mfaSignal => this.imapMfaLoop(arlo, mfaStartTime, mfaSignal), { tag: 'mfa', owner: this });
                }
                else {
                    this.logger.debug('Using Manual strategy for MFA code retrieval.');
                    this.taskManager.createTask(mfaSignal => this.manualMfaLoop(mfaSignal), { tag: 'mfa', owner: this });
                }
            }
            await abortable(task.promise, signal);
            if (arlo.loggedIn) {
                this.errorManager.endAuthTransition(true);
                transitionOpen = false;
                await this.onLoginSuccess(arlo, signal);
                result.resolve(true);
                return;
            }
            this.logger.error(`Arlo Cloud login failed. ${LOGIN_AGAIN}`);
        }
        catch (e) {
            if (e instanceof CancelledError || signal?.aborted) {
                if (loginTask && !loginTask.done) {
                    loginTask.controller.abort();
                    await Promise.allSettled([loginTask.promise]);
                }
                throw e;
            }
            if (e instanceof RateLimitedError) {
                this.logger.warn(`Arlo Cloud login paused by rate limit for ${Math.floor((e.retryAfter ?? this.errorManager.rateLimitRemaining()) / 1000)} seconds.`);
            }
            else if (e instanceof TransientRequestError) {
                this.logger.error(`Arlo Cloud login failed with a temporary error: ${e.message}. ${LOGIN_AGAIN}`);
            }
            else {
                this.logger.error(`Arlo Cloud login failed. ${LOGIN_AGAIN}`, e);
            }
        }
        finally {
            result.resolve(false);
            if (transitionOpen)
                this.errorManager.endAuthTransition(false);
            if (!this.arlo?.loggedIn)
                this.endBuild();
        }
    }

    private async resetArloClient(): Promise<void> {
        const arlo = this.arlo;
        this.arlo = undefined;
        if (!arlo)
            return;
        try {
            await arlo.restart();
        }
        catch (e) {
            this.logger.warn(`Error restarting Arlo client: ${e}`);
        }
    }

    private async cleanUpLoginTasks(): Promise<void> {
        this.logger.debug('Cleaning up login and MFA tasks.');
        await this.taskManager.cancelAndAwaitByTag('mfa', this);
        await this.taskManager.cancelAndAwaitByTag('login-arlo', this);
        await this.taskManager.cancelAndAwaitByTag('login', this);
    }

    private async manualMfaLoop(signal: AbortSignal): Promise<void> {
        this.manualMfaCode = new Deferred();
        this.logger.info('Waiting for manual MFA code input.');
        try {
            const code = await withTimeout(abortable(this.manualMfaCode.promise, signal), MANUAL_MFA_TIMEOUT);
            if (code) {
                this.mfaCode?.resolve(code);
                this.logger.debug('Manual MFA code sent to Arlo client.');
                return;
            }
            this.logger.error('Manual MFA code was not provided. Restarting plugin.');
        }
        catch (e) {
            if (!(e instanceof TimeoutError))
                throw e;
            this.logger.error('Manual MFA code not entered within 5 minutes. Restarting plugin.');
        }
        finally {
            this.manualMfaCode = undefined;
        }
        if (!signal.aborted)
            this.requestRestart('plugin');
    }

    private imapSettingsReady(): boolean {
        const values = this.storageSettings.values;
        const ready = !!(values.imap_mfa_host && values.imap_mfa_port && values.imap_mfa_username && values.imap_mfa_password && values.imap_mfa_sender);
        if (ready)
            this.imapReady.set();
        else
            this.imapReady.clear();
        return ready;
    }

    private async imapMfaLoop(arlo: ArloClient, mfaStartTime: number, signal: AbortSignal): Promise<void> {
        if (!this.imapSettingsReady()) {
            this.logger.info('IMAP MFA settings not ready, waiting for user input.');
            await this.imapReady.wait(signal);
        }
        this.logger.debug('IMAP MFA Loop started.');
        const code = await this.pollImapForMfaCode(mfaStartTime, signal);
        if (code) {
            this.mfaCode?.resolve(code);
            this.logger.debug('IMAP MFA code sent to Arlo client.');
            return;
        }
        if (!arlo.loggedIn && !signal.aborted) {
            this.logger.error('IMAP MFA Loop failed. Restarting plugin.');
            this.requestRestart('plugin');
        }
    }

    // Looks for the Arlo code in mail from the configured sender received since
    // the code was requested, for about four and a half minutes. Mailboxes
    // whose server-side search finds nothing are searched message by message.
    private async pollImapForMfaCode(mfaStartTime: number, signal: AbortSignal): Promise<string | undefined> {
        const values = this.storageSettings.values;
        const sender = String(values.imap_mfa_sender).toLowerCase();
        const start = minuteFloor(mfaStartTime);
        const client = new ImapFlow({
            host: values.imap_mfa_host,
            port: Number(values.imap_mfa_port),
            secure: true,
            auth: { user: values.imap_mfa_username, pass: values.imap_mfa_password },
            logger: false,
        });
        this.logger.debug('Starting IMAP polling for MFA code.');
        try {
            await client.connect();
            for (let attempt = 1; attempt <= 24; attempt++) {
                const wait = Math.min(2 ** (Math.floor((attempt - 1) / 5) + 1), 60) * 1000;
                this.logger.debug(`IMAP search attempt ${attempt}/24`);
                const code = await this.searchMailbox(client, sender, start);
                if (code) {
                    this.logger.debug('Found MFA code.');
                    return code;
                }
                this.logger.debug(`No email found yet, will retry after ${wait / 1000}s.`);
                await sleep(wait, signal);
            }
            this.logger.debug('IMAP polling finished. No MFA code found.');
        }
        catch (e) {
            if (signal.aborted)
                throw e;
            this.logger.warn('IMAP polling error:', e);
        }
        finally {
            await client.logout().catch(() => { });
        }
        return undefined;
    }

    private async searchMailbox(client: ImapFlow, sender: string, start: number): Promise<string | undefined> {
        const lock = await client.getMailboxLock('INBOX');
        try {
            let uids = await client.search({ from: sender }, { uid: true }) || [];
            const checkSender = !uids.length;
            if (checkSender)
                uids = await client.search({ all: true }, { uid: true }) || [];
            for (const uid of [...uids].sort((a, b) => b - a)) {
                const message = await client.fetchOne(String(uid), { envelope: true, bodyStructure: true }, { uid: true });
                if (!message)
                    continue;
                const date = message.envelope?.date;
                if (date && minuteFloor(new Date(date).getTime()) < start)
                    break;
                if (checkSender && !message.envelope?.from?.some(address => address.address?.toLowerCase().includes(sender)))
                    continue;
                const code = message.bodyStructure && await this.findMfaCode(client, uid, message.bodyStructure);
                if (code)
                    return code;
            }
        }
        finally {
            lock.release();
        }
        return undefined;
    }

    private async findMfaCode(client: ImapFlow, uid: number, node: MessageStructureObject): Promise<string | undefined> {
        if (node.childNodes?.length) {
            for (const child of node.childNodes) {
                const code = await this.findMfaCode(client, uid, child);
                if (code)
                    return code;
            }
            return undefined;
        }
        const type = node.type?.toLowerCase();
        if (type !== 'text/plain' && type !== 'text/html')
            return undefined;
        const download = await client.download(String(uid), node.part ?? '1', { uid: true });
        if (!download.content)
            return undefined;
        const chunks: Buffer[] = [];
        for await (const chunk of download.content)
            chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (type === 'text/plain')
            return extractMfaCode(text);
        for (const line of htmlToText(text).split(/\r?\n/)) {
            const code = extractMfaCode(line);
            if (code)
                return code;
        }
        return undefined;
    }

    private async onLoginSuccess(arlo: ArloClient, signal?: AbortSignal): Promise<void> {
        this.arlo = arlo;
        if (!this.fullResetNeeded)
            return;
        await this.taskManager.cancelAndAwaitByTag('refresh', this);
        this.taskManager.createTask(refreshSignal => this.refreshLoginLoop(refreshSignal), { tag: 'refresh', owner: this });
        await this.doArloSetup(signal);
        this.fullResetNeeded = false;
    }

    // Logs in again every event-stream refresh interval (90 minutes by
    // default, give or take five), and from scratch every 14 days.
    private async refreshLoginLoop(signal: AbortSignal): Promise<void> {
        let elapsed = 0;
        while (true) {
            const minutes = this.eventStreamRefreshInterval > 0 ? this.eventStreamRefreshInterval : 90;
            const interval = Math.max(60_000, minutes * 60_000 + Math.round((Math.random() * 600 - 300) * 1000));
            const wait = Math.min(interval, HARD_LOGIN_INTERVAL - elapsed);
            await sleep(wait, signal);
            elapsed += wait;
            try {
                if (elapsed >= HARD_LOGIN_INTERVAL) {
                    this.logger.debug('Hard MFA refresh interval reached, refreshing Arlo login.');
                    await this.periodicLock.run(() => this.deviceLock.run(() => this.errorManager.authTransition('hard MFA refresh cleanup', async () => {
                        await this.arlo?.unsubscribe();
                        await this.arlo?.cancelHeartbeat();
                        this.fullResetNeeded = true;
                    }), signal), signal);
                    await this.login(signal);
                    return;
                }
                this.logger.debug('Session refresh interval reached, re-logging in.');
                await this.periodicLock.run(() => this.deviceLock.run(() => this.errorManager.authTransition('scheduled session refresh cleanup', async () => {
                    await this.arlo?.unsubscribe();
                    await this.arlo?.cancelHeartbeat();
                    this.arlo?.resetSession();
                }), signal), signal);
                await this.login(signal);
                if (this.arlo?.loggedIn) {
                    await this.periodicLock.run(() => this.deviceLock.run(async () => {
                        if (this.arlo?.loggedIn) {
                            await this.subscribeToEventStream();
                            this.settingsChanged();
                        }
                    }, signal), signal);
                }
            }
            catch (e) {
                if (signal.aborted)
                    throw e;
                if (e instanceof RateLimitedError) {
                    const remaining = e.retryAfter ?? this.errorManager.rateLimitRemaining();
                    this.logger.warn(`Session refresh paused by rate limit for ${Math.floor(remaining / 1000)} seconds.`);
                    await sleep(Math.max(60_000, remaining), signal);
                }
                else if (e instanceof TransientRequestError) {
                    this.logger.warn(`Session refresh hit a temporary Arlo error: ${e.message}`);
                    if (elapsed >= HARD_LOGIN_INTERVAL)
                        elapsed = Math.max(0, elapsed - interval);
                }
                else {
                    // Any other failure ends this refresh, not the schedule.
                    this.logger.error('Session refresh failed; trying again at the next refresh:', e);
                }
            }
        }
    }

    // A 401 outside a login: log in again without rebuilding the devices.
    private async recoverAuth(reason: string, signal: AbortSignal): Promise<void> {
        try {
            if (this.errorManager.rateLimitRemaining() > 0)
                return;
            if (!this.arlo) {
                this.fullResetNeeded = true;
                await this.login(signal);
                return;
            }
            this.logger.info(`Attempting Arlo soft relogin after auth error: ${reason}`);
            const arlo = this.arlo;
            await this.restartLock.run(() => this.periodicLock.run(() => this.deviceLock.run(() => this.errorManager.authTransition(`auth recovery cleanup: ${reason}`, async () => {
                await arlo.unsubscribe().catch(e => this.logger.debug(`Error stopping event stream during auth recovery: ${e}`));
                await arlo.cancelHeartbeat().catch(e => this.logger.debug(`Error stopping heartbeat during auth recovery: ${e}`));
                if (this.errorManager.rateLimitRemaining() > 0)
                    return;
                this.arlo?.resetSession();
                this.fullResetNeeded = false;
            }), signal), signal), signal);
            await this.login(signal);
            if (this.arlo?.loggedIn) {
                await this.periodicLock.run(() => this.deviceLock.run(async () => {
                    if (this.arlo?.loggedIn) {
                        await this.subscribeToEventStream();
                        this.settingsChanged();
                    }
                }, signal), signal);
            }
        }
        catch (e) {
            if (signal.aborted)
                throw e;
            if (e instanceof RateLimitedError)
                this.logger.warn(`Auth recovery paused by Arlo rate limit for ${Math.floor((e.retryAfter ?? this.errorManager.rateLimitRemaining()) / 1000)} seconds.`);
            else if (e instanceof TransientRequestError)
                this.logger.warn(`Auth recovery hit a temporary Arlo error and will retry later: ${e.message}`);
            else
                this.logger.error('Auth recovery failed:', e);
        }
    }

    // Device setup after a full login.

    private async doArloSetup(signal?: AbortSignal): Promise<void> {
        this.setupInProgress = true;
        let cancelled = false;
        try {
            await this.errorManager.waitForAuthReady('Arlo setup', { signal });
            await this.periodicLock.run(async () => {
                this.arloCameras = new Map();
                this.arloBasestations = new Map();
                this.arloMvss = new Map();
                this.allDeviceIds = [];
                // A rebuild without a shutdown first (the 14-day login) still
                // has the previous devices running.
                await this.deviceLock.run(async () => {
                    const previous = [...this.scryptedDevices.values()];
                    this.scryptedDevices.clear();
                    for (const device of previous)
                        await device.close().catch(e => this.logger.debug(`Error closing ${device.arloDevice.deviceName} before setup: ${e}`));
                }, signal);
                await this.arlo!.subscribe();
                await this.deviceLock.run(() => this.mdns(), signal);
                await this.deviceHandler(false, signal);
            }, signal);
        }
        catch (e) {
            if (e instanceof CancelledError || signal?.aborted) {
                cancelled = true;
                throw e;
            }
            if (e instanceof UnauthorizedError) {
                this.logger.warn(`Arlo setup saw an expired session and queued auth recovery: ${e.message}`);
                this.errorManager.requestAuthRecovery(e.message);
            }
            else if (e instanceof RateLimitedError) {
                this.logger.warn(`Arlo setup paused by rate limit for ${Math.floor((e.retryAfter ?? this.errorManager.rateLimitRemaining()) / 1000)} seconds.`);
            }
            else if (e instanceof TransientRequestError) {
                this.logger.warn(`Temporary HTTP error during Arlo setup; will retry later: ${e.message}`);
            }
            else {
                this.logger.error('Unexpected error during Arlo setup:', e);
            }
        }
        finally {
            this.setupInProgress = false;
            this.endBuild();
            this.arlo?.events.releaseHeld();
            if (!cancelled) {
                if (this.arlo?.loggedIn)
                    await this.arlo.startHeartbeat();
                this.logger.info('Arlo plugin initialized.');
            }
        }
    }

    private async mdns(): Promise<void> {
        this.logger.debug('Initializing mDNS Discovery for basestation(s).');
        try {
            const services = await browseArloServices(this.logger);
            this.storage.setItem('mdns_services', JSON.stringify(services));
            if (Object.keys(services).length)
                this.logger.debug('Basestation(s) found in mDNS.');
        }
        catch (e) {
            this.logger.error('Basestation(s) not found in mDNS, manual input needed under basestation(s) settings.');
        }
    }

    private async deviceHandler(periodicDiscovery = false, signal?: AbortSignal): Promise<void> {
        await this.errorManager.waitForAuthReady('device discovery', { signal });
        await this.deviceLock.run(async () => {
            await this.discoverDevices();
            await this.subscribeToEventStream(periodicDiscovery);
            await this.createDevices();
        }, signal);
    }

    private async discoverDevices(): Promise<void> {
        const arlo = this.arlo;
        if (!arlo?.loggedIn)
            throw new Error('Arlo client not connected, cannot discover devices');
        this.logger.info('Discovering devices...');
        const basestationEntries: string[] = [];
        const cameraEntries: string[] = [];
        const mvssEntries: string[] = [];
        const seen = new Set<string>();
        const addEntry = (list: string[], entry: string) => {
            if (!seen.has(entry)) {
                seen.add(entry);
                list.push(entry);
            }
        };

        const basestations = await arlo.getDevices([DEVICE_TYPE_BASESTATION, DEVICE_TYPE_SIREN], true);
        for (const basestation of [...basestations].sort(byName)) {
            addEntry(basestationEntries, `${basestation.deviceName} (${basestation.deviceId})`);
            this.logger.debug(`Found basestation ${basestation.deviceName}`);
            if (!this.arloBasestations.has(basestation.deviceId))
                this.arloBasestations.set(basestation.deviceId, basestation);
        }
        this.arloBasestations = sortedMap(this.arloBasestations, device => device.deviceName);
        const basestationCount = this.arloBasestations.size;
        this.logger.debug(`Found ${basestationCount} basestation${basestationCount === 1 ? '' : 's'}.`);

        const cameras = await arlo.getDevices([DEVICE_TYPE_CAMERA, DEVICE_TYPE_ARLOQ, DEVICE_TYPE_ARLOQS, DEVICE_TYPE_DOORBELL], true);
        for (const camera of [...cameras].sort(byName)) {
            addEntry(cameraEntries, `${camera.deviceName} (${camera.deviceId})`);
            this.logger.debug(`Found camera ${camera.deviceName}`);
            if (camera.deviceId !== camera.parentId && !this.arloBasestations.has(camera.parentId)) {
                this.logger.debug(`Skipping camera ${camera.deviceName} because its basestation was not found.`);
                continue;
            }
            if (this.arloCameras.has(camera.deviceId))
                continue;
            // A camera on its own (Wi-Fi) is also its own basestation.
            if (camera.deviceId === camera.parentId)
                this.arloBasestations.set(camera.deviceId, camera);
            this.arloCameras.set(camera.deviceId, camera);
        }
        this.arloBasestations = sortedMap(this.arloBasestations, device => device.deviceName);
        this.arloCameras = sortedMap(this.arloCameras, device => device.deviceName);
        const cameraCount = this.arloCameras.size;
        this.logger.debug(`Found ${cameraCount} camera${cameraCount === 1 ? '' : 's'}.`);

        if (this.mvssEnabled) {
            const locations = await arlo.getLocations();
            this.storage.setItem('one_location', String(Object.keys(locations).length <= 1));
            const sorted = Object.entries(locations).sort(([, a], [, b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
            for (const [location, name] of sorted) {
                const nativeId = `${location}.mvss`;
                const deviceName = `Arlo Mode Virtual Security System ${name}`;
                addEntry(mvssEntries, `${deviceName} (${nativeId})`);
                this.logger.debug(`Found mode virtual security system ${deviceName}`);
                if (!this.arloMvss.has(nativeId))
                    this.arloMvss.set(nativeId, { location_name: name, deviceName });
            }
            this.arloMvss = sortedMap(this.arloMvss, info => info.location_name);
            this.logger.debug(`Found ${this.arloMvss.size} mode virtual security system${this.arloMvss.size === 1 ? '' : 's'}.`);
        }

        const sortEntries = (list: string[]) => [...list].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        this.allDeviceIds = [...sortEntries(basestationEntries), ...sortEntries(cameraEntries), ...sortEntries(mvssEntries)];
        this.logger.info('Done discovering devices.');
    }

    private async subscribeToEventStream(periodicDiscovery = false): Promise<void> {
        const arlo = this.arlo;
        if (!arlo?.loggedIn) {
            this.logger.warn('Arlo client not logged in, cannot subscribe to event stream.');
            return;
        }
        this.logger.info('Subscribing to Arlo event stream...');
        const pairs = [...this.arloCameras.values()]
            .map(camera => [this.arloBasestations.get(camera.parentId)!, camera] as [ArloDevice, ArloDevice]);
        for (let attempt = 1; ; attempt++) {
            try {
                await arlo.subscribe(pairs, { startHeartbeat: !this.setupInProgress });
                break;
            }
            catch (e) {
                const retryable = e instanceof TransientRequestError || e instanceof TimeoutError
                    || (e instanceof Error && e.constructor === Error);
                if (!retryable || attempt === 2) {
                    if (retryable)
                        this.logger.error('Stream still failed to connect after retry.');
                    throw e;
                }
                this.logger.warn(`Event stream failed to connect: ${e}`);
                this.logger.debug('Retrying stream setup after short delay...');
                await sleep(5_000);
            }
        }
        if (arlo.eventStream && !periodicDiscovery)
            arlo.eventStream.setRefreshInterval(this.eventStreamRefreshInterval);
        this.logger.info('Subscribed to Arlo event stream successfully.');
    }

    // Registers the discovered devices and their children with Scrypted.
    private async createDevices(): Promise<void> {
        if (!this.arlo?.loggedIn)
            throw new Error('Arlo client not connected, cannot create devices');
        this.logger.info('Creating devices...');
        const manifests = new Map<string | undefined, Device[]>();
        let basestations = 0;
        for (const [nativeId, basestation] of this.arloBasestations) {
            if (this.arloCameras.has(nativeId))
                continue;
            try {
                if (await this.registerDevice(nativeId, basestation, manifests))
                    basestations++;
            }
            catch (e) {
                this.logger.error(`Exception registering basestation ${basestation.deviceName}:`, e);
            }
        }
        this.logCreationMismatch('basestations', [...this.arloBasestations.keys()].filter(id => !this.arloCameras.has(id)).length, basestations);
        let cameras = 0;
        for (const [nativeId, camera] of this.arloCameras) {
            try {
                if (await this.registerDevice(nativeId, camera, manifests, camera.parentId))
                    cameras++;
            }
            catch (e) {
                this.logger.error(`Exception registering camera ${camera.deviceName}:`, e);
            }
        }
        this.logCreationMismatch('cameras', this.arloCameras.size, cameras);
        if (this.mvssEnabled) {
            let mvss = 0;
            for (const [nativeId, info] of this.arloMvss) {
                try {
                    if (await this.registerDevice(nativeId, info as unknown as ArloDevice, manifests, undefined, info.location_name))
                        mvss++;
                }
                catch (e) {
                    this.logger.error(`Exception registering mvss ${info.deviceName}:`, e);
                }
            }
            this.logCreationMismatch('mode virtual security systems', this.arloMvss.size, mvss);
        }
        await this.sendDevicesToScrypted(manifests);
        this.logger.info('Done creating devices.');
        this.settingsChanged();
    }

    // Creates the device if it is new and adds its manifest, and its
    // children's, to manifests by provider. Returns false for hidden devices.
    private async registerDevice(nativeId: string, deviceDict: ArloDevice, manifests: Map<string | undefined, Device[]>,
        parentId?: string, locationName?: string): Promise<boolean> {
        if (this.hiddenDeviceIds.includes(nativeId)) {
            this.logger.debug(`Skipping ${deviceDict.deviceName} as it is hidden.`);
            return false;
        }
        let device = this.scryptedDevices.get(nativeId);
        if (device) {
            this.logger.debug(`Device ${deviceDict.deviceName} already exists, skipping re-registration.`);
        }
        else {
            let properties: Record<string, any> = {};
            if (!nativeId.endsWith('mvss')) {
                properties = deviceDict.properties ?? {};
                if (!Object.keys(properties).length)
                    properties = parentId
                        ? await this.getDeviceProperties(this.arloBasestations.get(parentId)!, deviceDict)
                        : await this.getDeviceProperties(deviceDict);
            }
            device = this.getOrCreateDevice(nativeId, properties);
            if (!device) {
                this.logger.warn(`Failed to create device for ${deviceDict.deviceName}, skipping registration.`);
                return false;
            }
            try {
                await withTimeout(device.waitForReady(), 15_000);
            }
            catch {
                this.logger.warn(`Timed out waiting for ${deviceDict.deviceName} to finish startup initialization; continuing device registration.`);
            }
        }
        this.deviceReady(nativeId, device);
        if (device instanceof ArloModeVirtualSecuritySystem)
            device.completeInit();
        const manifest = nativeId.endsWith('mvss') && locationName
            ? device.getDeviceManifest({
                name: `Arlo Mode Virtual Security System ${locationName}`,
                infoOverrides: { model: 'Arlo Mode Virtual Security System', manufacturer: 'Arlo', firmware: '1.0', serialNumber: '000' },
                nativeId,
            })
            : device.getDeviceManifest();
        this.logger.debug(`Interfaces for ${deviceDict.deviceName}: ${JSON.stringify(device.getApplicableInterfaces())}`);
        const provider = !parentId || this.hiddenDeviceIds.includes(parentId) || nativeId === parentId ? undefined : parentId;
        this.appendManifest(manifests, provider, manifest);
        // A device rebuilt after an internal restart, and its children with it.
        const given = this.handedOut.get(nativeId);
        const refresh = !!given && given !== device;
        if (refresh)
            this.logger.debug(`Asking Scrypted to fetch the rebuilt ${deviceDict.deviceName} and its children again.`);
        await sdk.deviceManager.onDeviceDiscovered(refresh ? { ...manifest, refresh } : manifest);
        for (const child of device.getBuiltinChildDeviceManifests()) {
            await sdk.deviceManager.onDeviceDiscovered(refresh ? { ...child, refresh } : child);
            this.appendManifest(manifests, child.providerNativeId, child);
        }
        return true;
    }

    private appendManifest(manifests: Map<string | undefined, Device[]>, provider: string | undefined, manifest: Device): void {
        const list = manifests.get(provider) ?? [];
        if (!list.some(entry => entry.nativeId === manifest.nativeId))
            list.push(manifest);
        manifests.set(provider, list);
    }

    private logCreationMismatch(kind: string, total: number, shown: number): void {
        const singular = kind.slice(0, -1);
        if (total === shown) {
            this.logger.info(`Created ${shown} ${shown === 1 ? singular : kind}.`);
            return;
        }
        const wifi = singular === 'camera' ? ' or is a Wi-Fi Camera' : '';
        this.logger.info(`Created ${total} ${total === 1 ? singular : kind}, but${shown === 0 ? ' ' : ' only '}${shown} ${shown === 1 ? 'is' : 'are'} shown.`);
        this.logger.info(`This could be because a ${singular} is hidden${wifi}.`);
        this.logger.info(`If a ${singular} is not hidden${wifi} but is still missing, ensure all ${kind} are added correctly in the Arlo App.`);
    }

    // Each provider's list is complete, so Scrypted removes the devices left
    // out of it, such as newly hidden ones.
    private async sendDevicesToScrypted(manifests: Map<string | undefined, Device[]>): Promise<void> {
        for (const [provider, devices] of manifests) {
            if (provider === undefined)
                continue;
            const name = this.arloBasestations.get(provider)?.deviceName ?? this.arloCameras.get(provider)?.deviceName ?? provider;
            this.logger.debug(`Sending ${name} and children to scrypted server`);
            await sdk.deviceManager.onDevicesChanged({ devices, providerNativeId: provider });
        }
        const root = manifests.get(undefined);
        if (root?.length)
            await sdk.deviceManager.onDevicesChanged({ devices: root });
    }

    // Asks for a device's properties, trying a second time after 5 seconds.
    async getDeviceProperties(basestation: ArloDevice, camera?: ArloDevice): Promise<Record<string, any>> {
        const id = camera?.deviceId ?? basestation.deviceId;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                return await this.arlo!.triggerProperties(basestation, camera, { timeout: 5_000 });
            }
            catch (e) {
                if (!(e instanceof TimeoutError)) {
                    this.logger.error(`Error while fetching properties for ${id}: ${e}`);
                    return {};
                }
            }
        }
        this.logger.error(`Timeout while fetching properties for ${id}`);
        return {};
    }

    private getOrCreateDevice(nativeId: string, properties: Record<string, any>): ArloDeviceBase | undefined {
        let device = this.scryptedDevices.get(nativeId);
        if (device)
            return device;
        this.logger.debug(`Device ${nativeId} not found, creating new device.`);
        device = this.createDevice(nativeId, properties);
        if (device)
            this.scryptedDevices.set(nativeId, device);
        return device;
    }

    private createDevice(nativeId: string, properties: Record<string, any>): ArloDeviceBase | undefined {
        if (nativeId.endsWith('mvss')) {
            const info = this.arloMvss.get(nativeId);
            if (!info)
                return undefined;
            const device = info as unknown as ArloDevice;
            return new ArloModeVirtualSecuritySystem(nativeId, device, device, properties, this);
        }
        const camera = this.arloCameras.get(nativeId);
        if (!camera) {
            const basestation = this.arloBasestations.get(nativeId);
            if (!basestation) {
                this.logger.warn(`Device ${nativeId} not created, it has not been discovered yet.`);
                return undefined;
            }
            return new ArloBasestation(nativeId, basestation, properties, this);
        }
        const basestation = this.arloBasestations.get(camera.parentId);
        if (!basestation) {
            this.logger.warn(`Cannot create camera with nativeId ${nativeId} when ${camera.parentId} is not a valid basestation`);
            return undefined;
        }
        return camera.deviceType === DEVICE_TYPE_DOORBELL
            ? new ArloDoorbell(nativeId, camera, basestation, properties, this)
            : new ArloCamera(nativeId, camera, basestation, properties, this);
    }

    // Restarts.

    requestRestart(scope: RestartScope): void {
        const run = scope === 'plugin'
            ? this.requestPluginRestart(false)
            : this.handleRestart(scope);
        run.catch(e => this.logger.error(`Failed to request restart for scope ${scope}:`, e));
    }

    private async requestPluginRestart(clearCookies: boolean): Promise<void> {
        await this.restartLock.run(async () => {
            try {
                await this.shutdown(clearCookies);
            }
            catch (e) {
                this.logger.warn('Error during internal shutdown before requestRestart:', e);
            }
            try {
                await sdk.deviceManager.requestRestart();
            }
            catch (e) {
                this.logger.warn('Error requesting plugin restart:', e);
            }
        });
    }

    private async handleRestart(scope: Exclude<RestartScope, 'plugin'>): Promise<void> {
        await this.restartLock.run(async () => {
            if (scope === 'refresh_login_loop') {
                await this.periodicLock.run(async () => {
                    await this.taskManager.cancelAndAwaitByTag('refresh', this);
                    if (this.arlo?.loggedIn)
                        this.taskManager.createTask(signal => this.refreshLoginLoop(signal), { tag: 'refresh', owner: this });
                });
            }
            else if (scope === 'restart' || scope === 'relogin') {
                this.logger.info(scope === 'relogin' ? 'Forcing account relogin.' : 'Forcing full restart.');
                await this.periodicLock.run(() => this.deviceLock.run(() => this.shutdownLocked(scope === 'restart')));
                await this.initializePlugin(undefined, { awaitLogin: true });
            }
            else if (scope === 'event_stream') {
                await this.errorManager.waitForAuthReady('event stream restart');
                await this.periodicLock.run(() => this.deviceLock.run(async () => {
                    if (this.arlo?.loggedIn)
                        await this.arlo.unsubscribe();
                    await this.subscribeToEventStream();
                }));
            }
        });
    }

    private async shutdown(clearCookies: boolean): Promise<void> {
        await this.deviceLock.run(() => this.shutdownLocked(clearCookies));
    }

    private async shutdownLocked(clearCookies: boolean): Promise<void> {
        this.setupInProgress = false;
        if (clearCookies)
            this.storage.removeItem('arlo_cookies');
        for (const device of [...this.scryptedDevices.values()])
            await device.close().catch(() => { });
        for (const tag of ['initialize_plugin', 'periodic_discovery', 'periodic_refresh', 'refresh'])
            await this.taskManager.cancelAndAwaitByTag(tag, this);
        await this.cleanUpLoginTasks();
        await this.taskManager.cancelAndAwaitByTag('auth_recovery', this);
        await this.resetArloClient();
        this.logger.info('Provider shutdown finished');
    }

    // Settings.

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (!this.validateSetting(key, value)) {
            this.settingsChanged();
            return;
        }
        const values = this.storageSettings.values;
        switch (key) {
            case 'arlo_username':
            case 'arlo_password': {
                const previous = [this.arloUsername, this.arloPassword];
                await this.storageSettings.putSetting(key, value);
                if (this.arloUsername && this.arloPassword && (this.arloUsername !== previous[0] || this.arloPassword !== previous[1]))
                    this.requestRestart('restart');
                break;
            }
            case 'arlo_mfa_code':
                if (this.activeLogin && !this.activeLogin.done && this.manualMfaCode) {
                    this.logger.debug('Entered MFA code.');
                    this.manualMfaCode.resolve(String(value ?? ''));
                }
                break;
            case 'force_mfa_reauthentication':
                if (value === true || value === 'true')
                    this.requestRestart('restart');
                break;
            case 'plugin_log_level':
                await this.storageSettings.putSetting(key, value);
                this.propagateLogLevel();
                break;
            case 'mfa_strategy': {
                const previous = this.mfaStrategy;
                await this.storageSettings.putSetting(key, value);
                this.requestRestart('refresh_login_loop');
                if (value === 'Manual' && previous !== 'Manual')
                    this.clearImapSettings();
                break;
            }
            case 'event_stream_refresh_interval':
                await this.storageSettings.putSetting(key, value);
                this.arlo?.eventStream?.setRefreshInterval(values.event_stream_refresh_interval);
                break;
            case 'imap_mfa_host':
            case 'imap_mfa_port':
            case 'imap_mfa_username':
            case 'imap_mfa_password':
            case 'imap_mfa_sender':
                await this.storageSettings.putSetting(key, value);
                if (this.imapSettingsReady())
                    this.requestRestart('refresh_login_loop');
                break;
            case 'hidden_devices':
            case 'mvss_enabled':
                await this.storageSettings.putSetting(key, value);
                if (this.arlo?.loggedIn)
                    this.requestRestart('relogin');
                break;
            case 'device_refresh_interval':
            case 'device_discovery_interval': {
                await this.storageSettings.putSetting(key, value);
                const [tag, loop] = key === 'device_refresh_interval'
                    ? ['periodic_refresh', (signal: AbortSignal) => this.periodicRefresh(signal)] as const
                    : ['periodic_discovery', (signal: AbortSignal) => this.periodicDiscovery(signal)] as const;
                await this.taskManager.cancelAndAwaitByTag(tag, this);
                this.taskManager.createTask(loop, { tag, owner: this });
                break;
            }
            case 'auto_snapshot_generation':
                await this.storageSettings.putSetting(key, value);
                for (const device of this.scryptedDevices.values()) {
                    if (device instanceof ArloCamera)
                        await device.updateAutoSnapshot().catch(e => this.logger.debug(`Failed to update auto snapshot refresh for ${device.nativeId}: ${e}`));
                }
                break;
            case 'disable_plugin': {
                const requestedDisable = value === true || value === 'true';
                if (this.errorManager.handleDisablePluginSetting(requestedDisable))
                    this.requestRestart('plugin');
                break;
            }
            default:
                await this.storageSettings.putSetting(key, value);
        }
        this.settingsChanged();
    }

    private validateSetting(key: string, value: SettingValue): boolean {
        const fail = (reason: string) => {
            this.logger.error(`Invalid value for ${key}: "${value}" - ${reason}`);
            return false;
        };
        if (['device_discovery_interval', 'device_refresh_interval', 'event_stream_refresh_interval', 'imap_mfa_port'].includes(key)) {
            const number = Number(value);
            if (!Number.isInteger(number))
                return fail('must be a whole number');
            if (number < 0)
                return fail('must be nonnegative');
        }
        if (key === 'plugin_log_level' && !LOG_LEVELS.includes(value as LogLevel))
            return fail(`must be one of ${LOG_LEVELS.join(', ')}`);
        if (key === 'mfa_strategy' && !MFA_STRATEGIES.includes(String(value)))
            return fail(`must be one of ${MFA_STRATEGIES.join(', ')}`);
        return true;
    }

    private clearImapSettings(): void {
        for (const key of ['imap_mfa_host', 'imap_mfa_username', 'imap_mfa_password', 'imap_mfa_sender', 'imap_mfa_port'])
            this.storage.removeItem(key);
    }

    // Scrypted asks for devices it already knows, including at startup before
    // discovery has created them; those are returned once discovery runs.
    async getDevice(nativeId: string): Promise<any> {
        if (!this.disablePlugin) {
            const name = this.arloBasestations.get(nativeId)?.deviceName ?? this.arloCameras.get(nativeId)?.deviceName ?? this.arloMvss.get(nativeId)?.deviceName ?? nativeId;
            this.logger.debug(`Scrypted requested to load device ${name}`);
        }
        let device = this.scryptedDevices.get(nativeId);
        if (!device && this.building && !this.disablePlugin) {
            let waiter = this.deviceWaiters.get(nativeId);
            if (!waiter) {
                waiter = new Deferred();
                this.deviceWaiters.set(nativeId, waiter);
            }
            device = await withTimeout(waiter.promise, BUILD_WAIT).catch(() => undefined);
        }
        if (device)
            this.handedOut.set(nativeId, device);
        return device;
    }

    // A device removed in Scrypted stops its work here.
    async releaseDevice(id: string, nativeId: string): Promise<void> {
        const device = this.scryptedDevices.get(nativeId);
        this.scryptedDevices.delete(nativeId);
        this.handedOut.delete(nativeId);
        await device?.close();
    }

    private deviceReady(nativeId: string, device: ArloDeviceBase): void {
        this.deviceWaiters.get(nativeId)?.resolve(device);
        this.deviceWaiters.delete(nativeId);
    }

    // The first build is over, or will not happen; any device still waited
    // for is not coming.
    private endBuild(): void {
        if (!this.building)
            return;
        this.building = false;
        for (const waiter of this.deviceWaiters.values())
            waiter.resolve(undefined);
        this.deviceWaiters.clear();
    }
}
