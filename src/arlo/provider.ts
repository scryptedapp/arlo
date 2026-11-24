import crypto from 'node:crypto';

import sdk, { Device, DeviceProvider, ScryptedDeviceBase, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { ImapFlow, MessageStructureObject } from 'imapflow';

import { ArloDeviceBase } from './base';
import { ArloBasestation } from './basestation';
import { ArloCamera } from './camera';
import { ArloClient, ArloDevice, ArloService, browseArloServices, initImpers } from './client';
import { ArloDoorbell } from './doorbell';
import { LOG_LEVELS, Logger, setLogLevel } from './logging';
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
    UnauthorizedRestartException,
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

type RestartScope = 'plugin' | 'restart' | 'relogin' | 'refresh_login_loop' | 'event_stream';

interface ModeVirtualSecuritySystemInfo extends Partial<ArloDevice> {
    locationName: string;
    deviceName: string;
}

function compareNames(a: string, b: string): number {
    return a.toLowerCase().localeCompare(b.toLowerCase());
}

function sortedMap<T>(map: Map<string, T>, name: (value: T) => string): Map<string, T> {
    return new Map([...map].sort(([, a], [, b]) => compareNames(name(a), name(b))));
}

function minuteFloor(time: number): number {
    return Math.floor(time / 60_000) * 60_000;
}

function extractMfaCodeFromText(text: string): string | undefined {
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

export class ArloProvider extends ScryptedDeviceBase implements DeviceProvider, Settings {
    logger = new Logger('Arlo Provider', this.console);
    taskManager = new TaskManager(this.logger);
    errorManager: ErrorManager;

    storageSettings = new StorageSettings(this, {
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
    scryptedDevices = new Map<string, ArloDeviceBase>();
    private building = true;
    private deviceWaiters = new Map<string, Deferred<ArloDeviceBase | undefined>>();
    private loadedDevices = new Map<string, ArloDeviceBase>();
    setupInProgress = false;
    fullResetNeeded = false;
    private loginFailure?: 'temporary' | 'final';
    private loginRetries = 0;
    private eventStreamRestartPending = false;
    private eventStreamRestartAt = 0;
    private eventStreamBackoff = 0;
    private initializeLock = new AsyncLock();
    private restartLock = new AsyncLock();
    private periodicLock = new AsyncLock();
    deviceLock = new AsyncLock();
    private imapReady = new AsyncEvent();
    private activeLogin?: Deferred<boolean>;
    private lastLoginAttempt = 0;
    private manualMfaCode?: Deferred<string>;
    private mfaStateFuture?: Deferred<string>;
    private browserAuthenticated?: Deferred<boolean>;
    private mfaLoopFuture?: Deferred<void>;
    private mfaCodeFuture?: Deferred<string>;

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
        this.taskManager.createTask(signal => this.initializePlugin(false, signal), { tag: 'initialize_plugin', owner: this });
    }

    private propagateLogLevel(): void {
        const level = this.storageSettings.values.plugin_log_level;
        setLogLevel(LOG_LEVELS.includes(level) ? level : 'Info');
        this.logger.info(`Setting plugin log level to ${level}`);
    }

    private settingsChanged(): void {
        this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => { });
    }

    private async initializePlugin(awaitLogin = false, signal?: AbortSignal): Promise<void> {
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
                this.arlo?.events.processBufferedEvents();
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

    private async recoverAuth(reason: string, signal: AbortSignal): Promise<void> {
        try {
            if (this.errorManager.rateLimitRemaining() > 0)
                return;
            if (this.loginFailure) {
                this.logger.debug(`Not logging in again after an auth error, since the last login failed: ${reason}`);
                return;
            }
            if (!this.arlo) {
                this.fullResetNeeded = true;
                await this.login(signal);
                return;
            }
            this.logger.info(`Attempting Arlo soft relogin after auth error: ${reason}`);
            const arlo = this.arlo;
            await this.restartLock.run(() => this.periodicLock.run(() => this.deviceLock.run(() =>
                this.errorManager.authTransition(`auth recovery cleanup: ${reason}`, async () => {
                    await arlo.unsubscribe().catch(e => this.logger.debug(`Error stopping event stream during auth recovery: ${e}`));
                    await arlo.cancelHeartbeat().catch(e => this.logger.debug(`Error stopping heartbeat during auth recovery: ${e}`));
                    if (this.errorManager.rateLimitRemaining() > 0)
                        return;
                    this.arlo?.resetSession();
                    this.fullResetNeeded = false;
                }), signal), signal), signal);
            await this.login(signal);
            await this.resubscribeAfterRelogin(signal);
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

    get arloDeviceId(): string {
        let deviceId = this.storage.getItem('arlo_device_id');
        if (!deviceId) {
            deviceId = crypto.randomUUID();
            this.storage.setItem('arlo_device_id', deviceId);
        }
        return deviceId;
    }

    get arloPassword(): string {
        return this.storageSettings.values.arlo_password ?? '';
    }

    get arloUsername(): string {
        return this.storageSettings.values.arlo_username ?? '';
    }

    get eventStreamRefreshInterval(): number {
        return this.storageSettings.values.event_stream_refresh_interval;
    }

    get hiddenDeviceIds(): string[] {
        return (this.storageSettings.values.hidden_devices as string[] ?? [])
            .map(entry => /.*\((.*)\)$/.exec(entry)?.[1])
            .filter((id): id is string => !!id);
    }

    get mfaStrategy(): string {
        return this.storageSettings.values.mfa_strategy;
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

    get deviceDiscoveryInterval(): number {
        return this.storageSettings.values.device_discovery_interval;
    }

    get deviceRefreshInterval(): number {
        return this.storageSettings.values.device_refresh_interval;
    }

    get disablePlugin(): boolean {
        return !!this.storageSettings.values.disable_plugin;
    }

    get mdnsServices(): Record<string, ArloService> {
        try {
            return JSON.parse(this.storage.getItem('mdns_services') ?? '{}');
        }
        catch {
            return {};
        }
    }

    get arloPublicKey(): string {
        if (!this.storage.getItem('arlo_public_key'))
            this.generateArloKeypair();
        return this.storage.getItem('arlo_public_key');
    }

    get arloPrivateKey(): string {
        if (!this.storage.getItem('arlo_private_key'))
            this.generateArloKeypair();
        return this.storage.getItem('arlo_private_key');
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

    private async login(signal?: AbortSignal): Promise<void> {
        if (this.activeLogin && !this.activeLogin.done) {
            this.logger.debug('Login already in progress, waiting for it to complete.');
            await abortable(this.activeLogin.promise, signal);
            return;
        }
        const loginFuture = new Deferred<boolean>();
        this.activeLogin = loginFuture;
        this.loginFailure = undefined;
        this.errorManager.beginAuthTransition('Arlo Cloud login');
        let transitionOpen = true;
        let loginTask: Task<void> | undefined;
        try {
            const cooldown = 60_000 - (Date.now() - this.lastLoginAttempt);
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
            this.setLoginFutures();
            arlo.browserAuthenticated = this.browserAuthenticated;
            arlo.mfaStateFuture = this.mfaStateFuture;
            arlo.mfaLoopFuture = this.mfaLoopFuture;
            arlo.mfaCodeFuture = this.mfaCodeFuture;
            this.logger.debug('Setup ArloClient and MFA futures.');
            let failure: unknown;
            loginTask = this.taskManager.createTask(async loginSignal => {
                try {
                    await arlo.login(loginSignal);
                }
                catch (e) {
                    failure = e;
                }
            }, { tag: 'login-arlo', owner: this });

            const waitForLoginSignal = async <T>(future: Deferred<T>, description: string): Promise<T> => {
                const loginEnded = loginTask.promise.then(() => false, () => false);
                const signalled = future.promise.then(() => true);
                if (!await abortable(Promise.race([signalled, loginEnded]), signal) && !future.done) {
                    await loginTask.promise;
                    if (failure)
                        throw failure;
                    throw new Error(`Arlo Cloud login ended before ${description} was available.`);
                }
                return future.promise;
            };

            this.logger.debug('Waiting for MFA state from Arlo Cloud...');
            const mfaState = await waitForLoginSignal(this.mfaStateFuture, 'MFA state');
            const browserAuthenticated = mfaState === 'ENABLED'
                ? await waitForLoginSignal(this.browserAuthenticated, 'browser authentication state')
                : true;
            if (mfaState === 'ENABLED' && !browserAuthenticated) {
                const mfaStartTime = Date.now();
                await waitForLoginSignal(this.mfaLoopFuture, 'MFA challenge');
                if (this.mfaStrategy === 'IMAP') {
                    this.logger.debug('Using IMAP strategy for MFA code retrieval.');
                    this.taskManager.createTask(mfaSignal => this.imapMfaLoop(arlo, mfaStartTime, mfaSignal), { tag: 'mfa', owner: this });
                }
                else {
                    this.logger.debug('Using Manual strategy for MFA code retrieval.');
                    this.taskManager.createTask(mfaSignal => this.manualMfaLoop(mfaSignal), { tag: 'mfa', owner: this });
                }
            }
            await abortable(loginTask.promise, signal);
            if (failure)
                throw failure;
            if (!arlo.loggedIn)
                throw new Error('Arlo Cloud did not complete the login.');
            this.errorManager.endAuthTransition(true);
            transitionOpen = false;
            this.loginRetries = 0;
            await this.onLoginSuccess(arlo, signal);
            loginFuture.resolve(true);
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
                this.loginFailure = 'final';
                this.logger.warn(`Arlo Cloud login paused by rate limit for ${Math.floor((e.retryAfter ?? this.errorManager.rateLimitRemaining()) / 1000)} seconds.`);
            }
            else if (e instanceof TransientRequestError) {
                this.loginFailure = 'temporary';
                this.scheduleLoginRetry(e.message);
            }
            else {
                this.loginFailure = 'final';
                this.logger.error('Arlo Cloud login failed. The plugin does not try again after this; '
                    + 'once the cause is fixed, restart the plugin or turn on Force Re-Authentication.', e);
            }
        }
        finally {
            loginFuture.resolve(false);
            if (transitionOpen)
                this.errorManager.endAuthTransition(false);
            if (!this.arlo?.loggedIn)
                this.endBuild();
        }
    }

    private scheduleLoginRetry(reason: string): void {
        const delays = [5 * 60_000, 15 * 60_000, 60 * 60_000];
        const delay = delays[Math.min(this.loginRetries, delays.length - 1)];
        this.loginRetries++;
        this.logger.error(`Arlo Cloud login failed with a temporary error: ${reason}. Trying again in ${delay / 60_000} minutes.`);
        const relogin = !this.fullResetNeeded;
        this.taskManager.cancelAndAwaitByTag('login_retry', this).catch(() => { });
        this.taskManager.createTask(async signal => {
            await sleep(delay, signal);
            this.logger.info('Trying the Arlo Cloud login again.');
            await this.login(signal);
            if (relogin)
                await this.resubscribeAfterRelogin(signal);
        }, { tag: 'login_retry', owner: this });
    }

    private async resubscribeAfterRelogin(signal: AbortSignal): Promise<void> {
        if (!this.arlo?.loggedIn)
            return;
        await this.periodicLock.run(() => this.deviceLock.run(async () => {
            if (this.arlo?.loggedIn) {
                await this.subscribeToEventStream();
                this.settingsChanged();
            }
        }, signal), signal);
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

    private setLoginFutures(): void {
        this.mfaStateFuture = new Deferred();
        this.browserAuthenticated = new Deferred();
        this.mfaLoopFuture = new Deferred();
        this.mfaCodeFuture = new Deferred();
    }

    private async cleanUpLoginTasks(): Promise<void> {
        this.logger.debug('Cleaning up login and MFA tasks.');
        await this.taskManager.cancelAndAwaitByTag('mfa', this);
        await this.taskManager.cancelAndAwaitByTag('login-arlo', this);
        await this.taskManager.cancelAndAwaitByTag('login', this);
    }

    private async imapMfaLoop(arlo: ArloClient, mfaStartTime: number, signal: AbortSignal): Promise<void> {
        if (!this.imapSettingsReady()) {
            this.logger.info('IMAP MFA settings not ready, waiting for user input.');
            await this.imapReady.wait(signal);
        }
        this.logger.debug('IMAP MFA Loop started.');
        const code = await this.pollImapForMfaCode(mfaStartTime, signal);
        if (code) {
            this.mfaCodeFuture?.resolve(code);
            this.logger.debug('IMAP MFA code sent to Arlo client.');
            return;
        }
        if (!arlo.loggedIn && !signal.aborted)
            this.mfaCodeFuture?.reject(new Error('The MFA code was not found by IMAP; check the IMAP settings.'));
    }

    private async manualMfaLoop(signal: AbortSignal): Promise<void> {
        this.manualMfaCode = new Deferred();
        this.logger.info('Waiting for manual MFA code input.');
        try {
            const code = await withTimeout(abortable(this.manualMfaCode.promise, signal), 278_000);
            if (code) {
                this.mfaCodeFuture?.resolve(code);
                this.logger.debug('Manual MFA code sent to Arlo client.');
                return;
            }
            this.mfaCodeFuture?.reject(new Error('An empty MFA code was entered.'));
        }
        catch (e) {
            if (!(e instanceof TimeoutError))
                throw e;
            this.mfaCodeFuture?.reject(new Error('No MFA code was entered within 5 minutes.'));
        }
        finally {
            this.manualMfaCode = undefined;
        }
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

    private async refreshLoginLoop(signal: AbortSignal): Promise<void> {
        const hardInterval = 14 * 24 * 60 * 60_000;
        let elapsed = 0;
        while (true) {
            const minutes = this.eventStreamRefreshInterval > 0 ? this.eventStreamRefreshInterval : 90;
            const interval = Math.max(60_000, minutes * 60_000 + Math.round((Math.random() * 600 - 300) * 1000));
            const wait = Math.min(interval, hardInterval - elapsed);
            await sleep(wait, signal);
            elapsed += wait;
            try {
                if (elapsed >= hardInterval) {
                    this.logger.debug('Hard MFA refresh interval reached, refreshing Arlo login.');
                    await this.periodicLock.run(() => this.deviceLock.run(() =>
                        this.errorManager.authTransition('hard MFA refresh cleanup', async () => {
                            await this.arlo?.unsubscribe();
                            await this.arlo?.cancelHeartbeat();
                            this.fullResetNeeded = true;
                        }), signal), signal);
                    await this.login(signal);
                    return;
                }
                this.logger.debug('Session refresh interval reached, re-logging in.');
                await this.periodicLock.run(() => this.deviceLock.run(() =>
                    this.errorManager.authTransition('scheduled session refresh cleanup', async () => {
                        await this.arlo?.unsubscribe();
                        await this.arlo?.cancelHeartbeat();
                        this.arlo?.resetSession();
                    }), signal), signal);
                await this.login(signal);
                if (this.loginFailure === 'final') {
                    this.logger.info('Session refreshes stop until the next login.');
                    return;
                }
                await this.resubscribeAfterRelogin(signal);
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
                    if (elapsed >= hardInterval)
                        elapsed = Math.max(0, elapsed - interval);
                }
                else {
                    this.logger.error('Session refresh failed; trying again at the next refresh:', e);
                }
            }
        }
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
        client.on('error', e => this.logger.debug(`IMAP connection error: ${e}`));
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
            return extractMfaCodeFromText(text);
        for (const line of htmlToText(text).split(/\r?\n/)) {
            const code = extractMfaCodeFromText(line);
            if (code)
                return code;
        }
        return undefined;
    }

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
                await this.deviceLock.run(async () => {
                    const existingDevices = [...this.scryptedDevices.values()];
                    this.scryptedDevices.clear();
                    for (const device of existingDevices)
                        await device.close().catch(e => this.logger.debug(`Error closing ${device.arloDevice.deviceName} before setup: ${e}`));
                }, signal);
                await this.arlo.subscribe();
                await this.deviceLock.run(() => this.mdns(), signal);
                await this.deviceHandler(false, signal);
            }, signal);
        }
        catch (e) {
            if (e instanceof CancelledError || signal?.aborted) {
                cancelled = true;
                throw e;
            }
            if (e instanceof UnauthorizedRestartException) {
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
            this.arlo?.events.processBufferedEvents();
            if (!cancelled) {
                if (this.arlo?.loggedIn)
                    await this.arlo.startHeartbeat();
                this.logger.info('Arlo plugin initialized.');
            }
        }
    }

    requestRestart(scope: RestartScope): void {
        if (scope === 'event_stream') {
            this.requestEventStreamRestart();
            return;
        }
        const restart = scope === 'plugin'
            ? this.requestPluginRestart(false)
            : this.handleRestart(scope);
        restart.catch(e => this.logger.error(`Failed to request restart for scope ${scope}:`, e));
    }

    private requestEventStreamRestart(): void {
        if (this.eventStreamRestartPending)
            return;
        this.eventStreamRestartPending = true;
        const restartedRecently = Date.now() - this.eventStreamRestartAt < 60_000;
        this.eventStreamBackoff = restartedRecently ? Math.min(Math.max(this.eventStreamBackoff * 2, 5_000), 60_000) : 0;
        if (this.eventStreamBackoff)
            this.logger.info(`The event stream dropped again within a minute of its last restart; restarting it in ${this.eventStreamBackoff / 1000} seconds.`);
        this.taskManager.createTask(async signal => {
            try {
                await sleep(this.eventStreamBackoff, signal);
            }
            finally {
                this.eventStreamRestartPending = false;
            }
            this.eventStreamRestartAt = Date.now();
            await this.handleRestart('event_stream', signal).catch(e => {
                if (signal.aborted)
                    throw e;
                this.logger.error('Failed to request restart for scope event_stream:', e);
            });
        }, { tag: 'event_stream_restart', owner: this });
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

    private async handleRestart(scope: Exclude<RestartScope, 'plugin'>, signal?: AbortSignal): Promise<void> {
        await this.restartLock.run(async () => {
            if (scope === 'refresh_login_loop') {
                await this.periodicLock.run(async () => {
                    await this.taskManager.cancelAndAwaitByTag('refresh', this);
                    if (this.arlo?.loggedIn)
                        this.taskManager.createTask(refreshSignal => this.refreshLoginLoop(refreshSignal), { tag: 'refresh', owner: this });
                });
            }
            else if (scope === 'restart' || scope === 'relogin') {
                this.logger.info(scope === 'relogin' ? 'Forcing account relogin.' : 'Forcing full restart.');
                await this.periodicLock.run(() => this.deviceLock.run(() => this.shutdownLocked(scope === 'restart')));
                await this.initializePlugin(true);
            }
            else if (scope === 'event_stream') {
                await this.errorManager.waitForAuthReady('event stream restart', { signal });
                await this.periodicLock.run(() => this.deviceLock.run(async () => {
                    if (this.arlo?.loggedIn)
                        await this.arlo.unsubscribe();
                    await this.subscribeToEventStream();
                }, signal), signal);
            }
        }, signal);
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
        for (const tag of ['initialize_plugin', 'periodic_discovery', 'periodic_refresh', 'refresh', 'login_retry', 'event_stream_restart'])
            await this.taskManager.cancelAndAwaitByTag(tag, this);
        await this.cleanUpLoginTasks();
        await this.taskManager.cancelAndAwaitByTag('auth_recovery', this);
        await this.resetArloClient();
        this.logger.info('Provider shutdown finished');
    }

    private async deviceHandler(periodicDiscovery = false, signal?: AbortSignal): Promise<void> {
        await this.errorManager.waitForAuthReady('device discovery', { signal });
        await this.deviceLock.run(async () => {
            await this.discoverDevices();
            await this.subscribeToEventStream(periodicDiscovery);
            await this.createDevices();
        }, signal);
    }

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (!this.validateSetting(key, value)) {
            this.settingsChanged();
            return;
        }
        switch (key) {
            case 'arlo_username':
            case 'arlo_password': {
                const prevUser = this.arloUsername;
                const prevPass = this.arloPassword;
                await this.storageSettings.putSetting(key, value);
                if (this.arloUsername && this.arloPassword && (this.arloUsername !== prevUser || this.arloPassword !== prevPass))
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
                    this.clearImapDefaults();
                break;
            }
            case 'event_stream_refresh_interval':
                await this.storageSettings.putSetting(key, value);
                this.arlo?.eventStream?.setRefreshInterval(this.eventStreamRefreshInterval);
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
                await this.storageSettings.putSetting(key, value);
                await this.restartPeriodicTask('periodic_refresh', signal => this.periodicRefresh(signal));
                break;
            case 'device_discovery_interval':
                await this.storageSettings.putSetting(key, value);
                await this.restartPeriodicTask('periodic_discovery', signal => this.periodicDiscovery(signal));
                break;
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
        if (key === 'plugin_log_level' && !LOG_LEVELS.includes(String(value)))
            return fail(`must be one of ${LOG_LEVELS.join(', ')}`);
        if (key === 'mfa_strategy' && !MFA_STRATEGIES.includes(String(value)))
            return fail(`must be one of ${MFA_STRATEGIES.join(', ')}`);
        return true;
    }

    private clearImapDefaults(): void {
        for (const key of ['imap_mfa_host', 'imap_mfa_username', 'imap_mfa_password', 'imap_mfa_sender', 'imap_mfa_port'])
            this.storage.removeItem(key);
    }

    private async restartPeriodicTask(tag: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void> {
        await this.taskManager.cancelAndAwaitByTag(tag, this);
        this.taskManager.createTask(fn, { tag, owner: this });
    }

    async mdns(): Promise<void> {
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
        for (const basestation of [...basestations].sort((a, b) => compareNames(a.deviceName, b.deviceName))) {
            addEntry(basestationEntries, `${basestation.deviceName} (${basestation.deviceId})`);
            this.logger.debug(`Found basestation ${basestation.deviceName}`);
            if (!this.arloBasestations.has(basestation.deviceId))
                this.arloBasestations.set(basestation.deviceId, basestation);
        }
        this.arloBasestations = sortedMap(this.arloBasestations, device => device.deviceName);
        const basestationCount = this.arloBasestations.size;
        this.logger.debug(`Found ${basestationCount} basestation${basestationCount === 1 ? '' : 's'}.`);

        const cameras = await arlo.getDevices([DEVICE_TYPE_CAMERA, DEVICE_TYPE_ARLOQ, DEVICE_TYPE_ARLOQS, DEVICE_TYPE_DOORBELL], true);
        for (const camera of [...cameras].sort((a, b) => compareNames(a.deviceName, b.deviceName))) {
            addEntry(cameraEntries, `${camera.deviceName} (${camera.deviceId})`);
            this.logger.debug(`Found camera ${camera.deviceName}`);
            if (camera.deviceId !== camera.parentId && !this.arloBasestations.has(camera.parentId)) {
                this.logger.debug(`Skipping camera ${camera.deviceName} because its basestation was not found.`);
                continue;
            }
            if (this.arloCameras.has(camera.deviceId))
                continue;
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
            for (const [location, name] of Object.entries(locations).sort(([, a], [, b]) => compareNames(a, b))) {
                const nativeId = `${location}.mvss`;
                const deviceName = `Arlo Mode Virtual Security System ${name}`;
                addEntry(mvssEntries, `${deviceName} (${nativeId})`);
                this.logger.debug(`Found mode virtual security system ${deviceName}`);
                if (!this.arloMvss.has(nativeId))
                    this.arloMvss.set(nativeId, { locationName: name, deviceName });
            }
            this.arloMvss = sortedMap(this.arloMvss, mvss => mvss.locationName);
            this.logger.debug(`Found ${this.arloMvss.size} mode virtual security system${this.arloMvss.size === 1 ? '' : 's'}.`);
        }

        this.allDeviceIds = [basestationEntries, cameraEntries, mvssEntries].flatMap(entries => [...entries].sort(compareNames));
        this.logger.info('Done discovering devices.');
    }

    private async subscribeToEventStream(periodicDiscovery = false): Promise<void> {
        const arlo = this.arlo;
        if (!arlo?.loggedIn) {
            this.logger.warn('Arlo client not logged in, cannot subscribe to event stream.');
            return;
        }
        this.logger.info('Subscribing to Arlo event stream...');
        const subscribeArgs: [ArloDevice, ArloDevice][] = [...this.arloCameras.values()]
            .map(camera => [this.arloBasestations.get(camera.parentId), camera]);
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await arlo.subscribe(subscribeArgs, { startHeartbeat: !this.setupInProgress });
                break;
            }
            catch (e) {
                if (!(e instanceof TransientRequestError || e instanceof TimeoutError || e?.constructor === Error))
                    throw e;
                if (attempt === 0) {
                    this.logger.warn(`Event stream failed to connect: ${e}`);
                    this.logger.debug('Retrying stream setup after short delay...');
                    await sleep(5_000);
                }
                else {
                    this.logger.error('Stream still failed to connect after retry.');
                    throw e;
                }
            }
        }
        if (arlo.eventStream && !periodicDiscovery)
            arlo.eventStream.setRefreshInterval(this.eventStreamRefreshInterval);
        this.logger.info('Subscribed to Arlo event stream successfully.');
    }

    private async createDevices(): Promise<void> {
        if (!this.arlo?.loggedIn)
            throw new Error('Arlo client not connected, cannot create devices');
        this.logger.info('Creating devices...');
        const providerToDeviceMap = new Map<string | undefined, Device[]>();
        let basestationCount = 0;
        for (const [nativeId, basestation] of this.arloBasestations) {
            if (this.arloCameras.has(nativeId))
                continue;
            try {
                if (await this.registerDevice(nativeId, basestation, providerToDeviceMap))
                    basestationCount++;
            }
            catch (e) {
                this.logger.error(`Exception registering basestation ${basestation.deviceName}:`, e);
            }
        }
        this.logCreationMismatch('basestations', [...this.arloBasestations.keys()].filter(id => !this.arloCameras.has(id)).length, basestationCount);
        let cameraCount = 0;
        for (const [nativeId, camera] of this.arloCameras) {
            try {
                if (await this.registerDevice(nativeId, camera, providerToDeviceMap, camera.parentId))
                    cameraCount++;
            }
            catch (e) {
                this.logger.error(`Exception registering camera ${camera.deviceName}:`, e);
            }
        }
        this.logCreationMismatch('cameras', this.arloCameras.size, cameraCount);
        if (this.mvssEnabled) {
            let mvssCount = 0;
            for (const [nativeId, mvss] of this.arloMvss) {
                try {
                    if (await this.registerDevice(nativeId, mvss as ArloDevice, providerToDeviceMap, undefined, mvss.locationName))
                        mvssCount++;
                }
                catch (e) {
                    this.logger.error(`Exception registering mvss ${mvss.deviceName}:`, e);
                }
            }
            this.logCreationMismatch('mode virtual security systems', this.arloMvss.size, mvssCount);
        }
        for (const devices of [...providerToDeviceMap.values()]) {
            for (const device of devices) {
                if (device.interfaces.includes(ScryptedInterface.DeviceProvider) && !providerToDeviceMap.has(device.nativeId))
                    providerToDeviceMap.set(device.nativeId, []);
            }
        }
        this.endBuild();
        await this.sendDevicesToScrypted(providerToDeviceMap);
        this.logger.info('Done creating devices.');
        this.settingsChanged();
    }

    private async registerDevice(nativeId: string, arloDevice: ArloDevice, providerToDeviceMap: Map<string | undefined, Device[]>,
        parentId?: string, locationName?: string): Promise<boolean> {
        if (this.hiddenDeviceIds.includes(nativeId)) {
            this.logger.debug(`Skipping ${arloDevice.deviceName} as it is hidden.`);
            return false;
        }
        let device = this.scryptedDevices.get(nativeId);
        if (device) {
            this.logger.debug(`Device ${arloDevice.deviceName} already exists, skipping re-registration.`);
        }
        else {
            let properties: Record<string, any> = {};
            if (!nativeId.endsWith('mvss')) {
                properties = arloDevice.properties ?? {};
                if (!Object.keys(properties).length)
                    properties = parentId
                        ? await this.getDeviceProperties(this.arloBasestations.get(parentId), arloDevice)
                        : await this.getDeviceProperties(arloDevice);
            }
            this.logger.debug(`Device ${nativeId} not found, creating new device.`);
            device = this.createDevice(nativeId, properties);
            if (!device) {
                this.logger.warn(`Failed to create device for ${arloDevice.deviceName}, skipping registration.`);
                return false;
            }
            this.scryptedDevices.set(nativeId, device);
            try {
                await withTimeout(device.waitForReady(), 15_000);
            }
            catch {
                this.logger.warn(`Timed out waiting for ${arloDevice.deviceName} to finish startup initialization; continuing device registration.`);
            }
        }
        this.deviceWaiters.get(nativeId)?.resolve(device);
        this.deviceWaiters.delete(nativeId);
        if (device instanceof ArloModeVirtualSecuritySystem)
            device.completeInit();
        const manifest = nativeId.endsWith('mvss') && locationName
            ? device.getDeviceManifest({
                name: `Arlo Mode Virtual Security System ${locationName}`,
                infoOverrides: { model: 'Arlo Mode Virtual Security System', manufacturer: 'Arlo', firmware: '1.0', serialNumber: '000' },
                nativeId,
            })
            : device.getDeviceManifest();
        this.logger.debug(`Interfaces for ${arloDevice.deviceName}: ${JSON.stringify(device.getApplicableInterfaces())}`);
        const providerNativeId = !parentId || this.hiddenDeviceIds.includes(parentId) || nativeId === parentId ? undefined : parentId;
        this.appendUnique(providerToDeviceMap, providerNativeId, manifest);
        const loaded = this.loadedDevices.get(nativeId);
        const refresh = !!loaded && loaded !== device;
        if (refresh)
            this.logger.debug(`Asking Scrypted to fetch the rebuilt ${arloDevice.deviceName} and its children again.`);
        await sdk.deviceManager.onDeviceDiscovered({ ...manifest, refresh });
        for (const child of device.getBuiltinChildDeviceManifests()) {
            await sdk.deviceManager.onDeviceDiscovered({ ...child, refresh });
            this.appendUnique(providerToDeviceMap, child.providerNativeId, child);
        }
        return true;
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

    private async sendDevicesToScrypted(providerToDeviceMap: Map<string | undefined, Device[]>): Promise<void> {
        for (const [providerNativeId, devices] of providerToDeviceMap) {
            if (providerNativeId === undefined)
                continue;
            const name = this.arloBasestations.get(providerNativeId)?.deviceName ?? this.arloCameras.get(providerNativeId)?.deviceName ?? providerNativeId;
            this.logger.debug(`Sending ${name} and children to scrypted server`);
            await sdk.deviceManager.onDevicesChanged({ devices, providerNativeId });
        }
        const rootDevices = providerToDeviceMap.get(undefined) ?? [];
        if (rootDevices.length || this.allDeviceIds.length)
            await sdk.deviceManager.onDevicesChanged({ devices: rootDevices });
    }

    async getDeviceProperties(basestation: ArloDevice, camera?: ArloDevice): Promise<Record<string, any>> {
        const id = camera?.deviceId ?? basestation.deviceId;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                return await this.arlo.triggerProperties(basestation, camera, { timeout: 5_000 });
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

    private appendUnique(providerToDeviceMap: Map<string | undefined, Device[]>, providerNativeId: string | undefined, manifest: Device): void {
        const devices = providerToDeviceMap.get(providerNativeId) ?? [];
        if (!devices.some(device => device.nativeId === manifest.nativeId))
            devices.push(manifest);
        providerToDeviceMap.set(providerNativeId, devices);
    }

    async getDevice(nativeId: string): Promise<ArloDeviceBase | undefined> {
        if (!this.disablePlugin) {
            const name = this.arloBasestations.get(nativeId)?.deviceName ?? this.arloCameras.get(nativeId)?.deviceName
                ?? this.arloMvss.get(nativeId)?.deviceName ?? nativeId;
            this.logger.debug(`Scrypted requested to load device ${name}`);
        }
        let device = this.scryptedDevices.get(nativeId);
        if (!device && this.building && !this.disablePlugin) {
            let waiter = this.deviceWaiters.get(nativeId);
            if (!waiter) {
                waiter = new Deferred();
                this.deviceWaiters.set(nativeId, waiter);
            }
            device = await withTimeout(waiter.promise, 60_000).catch(() => undefined);
        }
        if (device)
            this.loadedDevices.set(nativeId, device);
        return device;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        const device = this.scryptedDevices.get(nativeId);
        this.scryptedDevices.delete(nativeId);
        this.loadedDevices.delete(nativeId);
        await device?.close();
    }

    private endBuild(): void {
        if (!this.building)
            return;
        this.building = false;
        for (const waiter of this.deviceWaiters.values())
            waiter.resolve(undefined);
        this.deviceWaiters.clear();
    }

    private createDevice(nativeId: string, properties: Record<string, any>): ArloDeviceBase | undefined {
        if (nativeId.endsWith('mvss')) {
            const mvss = this.arloMvss.get(nativeId) as ArloDevice;
            if (!mvss)
                return undefined;
            return new ArloModeVirtualSecuritySystem(nativeId, mvss, mvss, properties, this);
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
}
