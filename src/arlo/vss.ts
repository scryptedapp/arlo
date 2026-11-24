import sdk, {
    Device,
    DeviceProvider,
    Readme,
    ScryptedDeviceType,
    ScryptedInterface,
    SecuritySystem,
    SecuritySystemMode,
    Setting,
    Settings,
    SettingValue,
} from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import type { ArloBasestation } from './basestation';
import type { ArloCamera } from './camera';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import { ArloSiren } from './siren';
import { sleep } from './util';

const SUPPORTED_MODES = [SecuritySystemMode.AwayArmed, SecuritySystemMode.HomeArmed, SecuritySystemMode.Disarmed];

export class ArloBaseVirtualSecuritySystem extends ArloDeviceBase implements SecuritySystem, Settings, Readme {
    protected async delayedInit(signal: AbortSignal): Promise<void> {
        await super.delayedInit(signal);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.stopSubscriptions)
                return;
            try {
                const mode = this.mode;
                if (SUPPORTED_MODES.includes(mode)) {
                    this.securitySystemState = { supportedModes: SUPPORTED_MODES, mode };
                    return;
                }
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloBaseVirtualSecuritySystem security system state, will try again: ${e}`);
            }
            await sleep(100, signal);
        }
        this.logger.error('Delayed init exceeded iteration limit for ArloBaseVirtualSecuritySystem security system state, giving up.');
    }

    get mode(): SecuritySystemMode {
        throw new Error('Not implemented');
    }

    set mode(mode: SecuritySystemMode) {
        throw new Error('Not implemented');
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.SecuritySystem, ScryptedInterface.DeviceProvider, ScryptedInterface.Settings, ScryptedInterface.Readme];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.SecuritySystem;
    }

    async getSettings(): Promise<Setting[]> {
        return [{
            key: 'mode',
            title: 'Arm Mode',
            description: this.modeDescription(),
            value: this.mode,
            choices: SUPPORTED_MODES,
        }];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key !== 'mode')
            throw new Error(`invalid setting ${key}`);
        try {
            this.mode = value as SecuritySystemMode;
        }
        catch (e) {
            this.logger.error(`Error setting mode: ${e}`);
        }
    }

    async getReadmeMarkdown(): Promise<string> {
        return this.readmeMarkdown().trim();
    }

    protected modeDescription(): string {
        return 'Set the security system arm/disarm mode.';
    }

    protected readmeMarkdown(): string {
        return '# Virtual Security System\n\nThis is a virtual security system device.';
    }

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        if (!SUPPORTED_MODES.includes(mode))
            throw new Error(`invalid mode ${mode}`);
        try {
            this.logger.info(`Arming ${mode}`);
            this.mode = mode;
        }
        catch (e) {
            this.logger.error(`Error arming security system: ${e}`);
        }
    }

    async disarmSecuritySystem(): Promise<void> {
        try {
            this.logger.info('Disarming');
            this.mode = SecuritySystemMode.Disarmed;
        }
        catch (e) {
            this.logger.error(`Error disarming security system: ${e}`);
        }
    }
}

export class ArloSirenVirtualSecuritySystem extends ArloBaseVirtualSecuritySystem implements DeviceProvider {
    siren?: ArloSiren;

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, public parent: ArloBasestation | ArloCamera) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    async close(): Promise<void> {
        await this.siren?.close();
        await super.close();
    }

    get mode(): SecuritySystemMode {
        const mode = this.storage.getItem('mode') as SecuritySystemMode;
        return SUPPORTED_MODES.includes(mode) ? mode : SecuritySystemMode.Disarmed;
    }

    set mode(mode: SecuritySystemMode) {
        if (!SUPPORTED_MODES.includes(mode))
            throw new Error(`invalid mode ${mode}`);
        this.storage.setItem('mode', mode);
        this.securitySystemState = { ...this.securitySystemState, supportedModes: SUPPORTED_MODES, mode };
        this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => { });
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await super.putSetting(key, value);
        if (this.mode === SecuritySystemMode.Disarmed)
            await this.getSiren().turnOff();
    }

    getBuiltinChildDeviceManifests(): Device[] {
        if (!this.parent.hasSiren)
            return [];
        const siren = this.getSiren();
        return [siren.getDeviceManifest({
            name: `${this.arloDevice.deviceName} Siren`,
            interfaces: siren.getApplicableInterfaces(),
            deviceType: siren.getDeviceType(),
            providerNativeId: this.nativeId,
            nativeId: siren.nativeId,
        })];
    }

    async getDevice(nativeId: string): Promise<ArloSiren | undefined> {
        return nativeId.endsWith('siren') ? this.getSiren() : undefined;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        await super.armSecuritySystem(mode);
        if (mode === SecuritySystemMode.Disarmed)
            await this.getSiren().turnOff();
    }

    async disarmSecuritySystem(): Promise<void> {
        await super.disarmSecuritySystem();
        await this.getSiren().turnOff();
    }

    private getSiren(): ArloSiren {
        this.siren ??= new ArloSiren(`${this.arloDevice.deviceId}.siren`, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this);
        return this.siren;
    }

    protected modeDescription(): string {
        return 'If disarmed, the associated siren will not be physically triggered even if toggled.';
    }

    protected readmeMarkdown(): string {
        return `
# Virtual Security System for Arlo Sirens

This device is a virtual security system provided by the Arlo Scrypted plugin. It grants Arm/Disarm semantics to help prevent accidental or unwanted triggering of the real physical siren through integrations such as HomeKit.

When the system is Disarmed, any triggers of the siren will be ignored. To allow the siren to trigger, set the Arm Mode to any of the Armed options. Changing the mode only affects this Scrypted device and does not modify your Arlo cloud or account settings.

If synced to HomeKit, the siren will appear as a switch within the same security system accessory. To use the siren as a standalone switch, disable syncing of the virtual security system and enable syncing of the siren, then manually arm the virtual security system in Scrypted.
`;
    }
}

export class ArloModeVirtualSecuritySystem extends ArloBaseVirtualSecuritySystem {
    static arloToScrypted: Record<string, SecuritySystemMode> = {
        armAway: SecuritySystemMode.AwayArmed,
        armHome: SecuritySystemMode.HomeArmed,
        standby: SecuritySystemMode.Disarmed,
    };

    static scryptedToArlo: Record<string, string> = Object.fromEntries(
        Object.entries(ArloModeVirtualSecuritySystem.arloToScrypted).map(([arlo, scrypted]) => [scrypted, arlo]));

    private initCompleted = false;

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider, false);
        this.readyEvent.set();
    }

    completeInit(): void {
        if (!this.initCompleted)
            this.taskManager.createTask(signal => this.delayedInit(signal), { tag: `delayed_init:${this.nativeId}`, owner: this });
    }

    protected async delayedInit(signal: AbortSignal): Promise<void> {
        let attempt = 0;
        for (; attempt < 100; attempt++) {
            try {
                if (sdk.deviceManager.getDeviceState(this.nativeId)?.id)
                    break;
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloModeVirtualSecuritySystem device state, will try again: ${e}`);
            }
            await sleep(100, signal);
        }
        if (attempt === 100) {
            this.logger.error('Delayed init exceeded iteration limit for ArloModeVirtualSecuritySystem device state, giving up.');
            return;
        }
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.stopSubscriptions)
                return;
            try {
                this.securitySystemState = { supportedModes: SUPPORTED_MODES, mode: this.mode };
                const [mode, revision] = await this.getInitialModeAndRevision();
                this.setModeAndRevision(mode, revision);
                this.startActiveModeSubscription();
                this.initCompleted = true;
                return;
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloModeVirtualSecuritySystem security system state, will try again: ${e}`);
                await sleep(100, signal);
            }
        }
        this.logger.error('Delayed init exceeded iteration limit for ArloModeVirtualSecuritySystem security system state, giving up.');
    }

    private async getInitialModeAndRevision(): Promise<[string, string]> {
        const response = await this.provider.arlo.getModeAndRevision();
        const location = this.provider.oneLocation ? response : response?.[this.location];
        if (!location)
            throw new Error(`Location "${this.location}" not found in response: ${JSON.stringify(response)}`);
        const mode = location.properties?.mode;
        const revision = location.revision;
        if (mode == null || revision == null)
            throw new Error(`Mode or revision missing in response: ${JSON.stringify(response)}`);
        return [mode, revision];
    }

    private setModeAndRevision(arloMode: string, revision: string | number): void {
        const scryptedMode = this.arloToScryptedMode(arloMode);
        this.securitySystemState = { supportedModes: SUPPORTED_MODES, mode: scryptedMode };
        this.mode = scryptedMode;
        this.nextRevision = String(Number(revision) + 1);
    }

    private startActiveModeSubscription(): void {
        this.createOrRegisterEventSubscription('active_mode_subscription', () =>
            this.provider.arlo.subscribeToActiveModeEvents(this.location, modeAndRevision =>
                this.setModeAndRevision(modeAndRevision.properties.mode, modeAndRevision.revision)));
    }

    get location(): string {
        return this.nativeId.replace('.mvss', '');
    }

    private arloToScryptedMode(arloMode: string): SecuritySystemMode {
        return ArloModeVirtualSecuritySystem.arloToScrypted[arloMode] ?? arloMode as SecuritySystemMode;
    }

    private scryptedToArloMode(scryptedMode: SecuritySystemMode): string {
        return ArloModeVirtualSecuritySystem.scryptedToArlo[scryptedMode] ?? scryptedMode;
    }

    get mode(): SecuritySystemMode {
        return this.arloToScryptedMode(this.storage.getItem('mode') ?? '');
    }

    set mode(scryptedMode: SecuritySystemMode) {
        if (!SUPPORTED_MODES.includes(scryptedMode))
            throw new Error(`invalid mode ${scryptedMode}`);
        this.storage.setItem('mode', this.scryptedToArloMode(scryptedMode));
        this.securitySystemState = { ...this.securitySystemState, supportedModes: SUPPORTED_MODES, mode: scryptedMode };
        this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => { });
    }

    get nextRevision(): string {
        return this.storage.getItem('next_revision') ?? '';
    }

    set nextRevision(nextRevision: string) {
        this.storage.setItem('next_revision', nextRevision);
    }

    private async changeArloMode(mode: SecuritySystemMode): Promise<void> {
        this.logger.info(`Setting Arlo Security Mode to ${mode}`);
        await this.provider.arlo.setMode(this.scryptedToArloMode(mode), this.location, this.nextRevision);
        this.mode = mode;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key !== 'mode')
            throw new Error(`invalid setting ${key}`);
        await this.changeArloMode(value as SecuritySystemMode);
    }

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        await this.changeArloMode(mode);
    }

    async disarmSecuritySystem(): Promise<void> {
        await this.changeArloMode(SecuritySystemMode.Disarmed);
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.SecuritySystem, ScryptedInterface.Settings, ScryptedInterface.Readme];
    }

    protected modeDescription(): string {
        return 'Change this value to change the Security Mode in your Arlo App.';
    }

    protected readmeMarkdown(): string {
        return `
# Virtual Security System for Arlo Security Modes

This device is a virtual security system provided by the Arlo Scrypted plugin. It allows you to control the Arm Away, Arm Home, and Disarm modes of your Arlo system through integrations such as HomeKit.

Changing the mode on this device will update the security mode in your Arlo cloud account, which may affect automations or routines you have configured in the Arlo app. Use this device to synchronize your Arlo security modes with your smart home integrations.
`;
    }
}
