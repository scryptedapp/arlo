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
import type { ArloDevice, Unsubscribe } from './client';
import type { ArloProvider } from './provider';
import { ArloSiren } from './siren';
import { sleep } from './util';

const SUPPORTED_MODES = [SecuritySystemMode.AwayArmed, SecuritySystemMode.HomeArmed, SecuritySystemMode.Disarmed];

export abstract class ArloBaseVirtualSecuritySystem extends ArloDeviceBase implements SecuritySystem, Settings, Readme {
    abstract get mode(): SecuritySystemMode;

    abstract setMode(mode: SecuritySystemMode): void;

    protected override async delayedInit(signal: AbortSignal): Promise<void> {
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

    override getApplicableInterfaces(): string[] {
        return [ScryptedInterface.SecuritySystem, ScryptedInterface.DeviceProvider, ScryptedInterface.Settings, ScryptedInterface.Readme];
    }

    override getDeviceType(): string {
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
            this.setMode(value as SecuritySystemMode);
        }
        catch (e) {
            this.logger.error(`Error setting mode: ${e}`);
        }
    }

    async getReadmeMarkdown(): Promise<string> {
        return this.readmeMarkdown().trim();
    }

    protected abstract modeDescription(): string;

    protected abstract readmeMarkdown(): string;

    async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        if (!SUPPORTED_MODES.includes(mode))
            throw new Error(`invalid mode ${mode}`);
        try {
            this.logger.info(`Arming ${mode}`);
            this.setMode(mode);
        }
        catch (e) {
            this.logger.error(`Error arming security system: ${e}`);
        }
    }

    async disarmSecuritySystem(): Promise<void> {
        try {
            this.logger.info('Disarming');
            this.setMode(SecuritySystemMode.Disarmed);
        }
        catch (e) {
            this.logger.error(`Error disarming security system: ${e}`);
        }
    }

    protected updateState(mode: SecuritySystemMode): void {
        this.securitySystemState = { ...this.securitySystemState, supportedModes: SUPPORTED_MODES, mode };
        this.onDeviceEvent(ScryptedInterface.Settings, undefined).catch(() => { });
    }
}

export class ArloSirenVirtualSecuritySystem extends ArloBaseVirtualSecuritySystem implements DeviceProvider {
    siren?: ArloSiren;

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, readonly parent: ArloDeviceBase & { readonly hasSiren: boolean }) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    get mode(): SecuritySystemMode {
        const mode = this.storage.getItem('mode') as SecuritySystemMode;
        return SUPPORTED_MODES.includes(mode) ? mode : SecuritySystemMode.Disarmed;
    }

    setMode(mode: SecuritySystemMode): void {
        if (!SUPPORTED_MODES.includes(mode))
            throw new Error(`invalid mode ${mode}`);
        this.storage.setItem('mode', mode);
        this.updateState(mode);
    }

    override async putSetting(key: string, value: SettingValue): Promise<void> {
        await super.putSetting(key, value);
        if (this.mode === SecuritySystemMode.Disarmed)
            await this.getSiren().turnOff();
    }

    override getBuiltinChildDeviceManifests(): Device[] {
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

    async getDevice(nativeId: string): Promise<any> {
        return nativeId.endsWith('siren') ? this.getSiren() : undefined;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }

    override async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        await super.armSecuritySystem(mode);
        if (mode === SecuritySystemMode.Disarmed)
            await this.getSiren().turnOff();
    }

    override async disarmSecuritySystem(): Promise<void> {
        await super.disarmSecuritySystem();
        await this.getSiren().turnOff();
    }

    private getSiren(): ArloSiren {
        this.siren ??= new ArloSiren(`${this.arloDevice.deviceId}.siren`, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this);
        return this.siren;
    }

    override async close(): Promise<void> {
        await this.siren?.close();
        await super.close();
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

const ARLO_TO_SCRYPTED: Record<string, SecuritySystemMode> = {
    armAway: SecuritySystemMode.AwayArmed,
    armHome: SecuritySystemMode.HomeArmed,
    standby: SecuritySystemMode.Disarmed,
};

const SCRYPTED_TO_ARLO: Record<string, string> = Object.fromEntries(Object.entries(ARLO_TO_SCRYPTED).map(([arlo, scrypted]) => [scrypted, arlo]));

export class ArloModeVirtualSecuritySystem extends ArloBaseVirtualSecuritySystem {
    private initCompleted = false;
    private unsubscribeActiveMode?: Unsubscribe;

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider, false);
        this.markReady();
    }

    completeInit(): void {
        if (!this.initCompleted)
            this.taskManager.createTask(signal => this.delayedInit(signal), { tag: `delayed_init:${this.nativeId}`, owner: this });
    }

    protected override async delayedInit(signal: AbortSignal): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                if (sdk.deviceManager.getDeviceState(this.nativeId)?.id)
                    break;
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloModeVirtualSecuritySystem device state, will try again: ${e}`);
            }
            if (attempt >= 100) {
                this.logger.error('Delayed init exceeded iteration limit for ArloModeVirtualSecuritySystem device state, giving up.');
                return;
            }
            await sleep(100, signal);
        }
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.stopSubscriptions)
                return;
            try {
                this.securitySystemState = { supportedModes: SUPPORTED_MODES, mode: this.mode };
                const [mode, revision] = await this.getInitialModeAndRevision();
                this.setModeAndRevision(mode, revision);
                this.unsubscribeActiveMode ??= this.provider.arlo!.subscribeToActiveModeEvents(this.location, modeAndRevision => {
                    this.setModeAndRevision(modeAndRevision.properties.mode, modeAndRevision.revision);
                });
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
        const response = await this.provider.arlo!.getModeAndRevision();
        const entry = this.provider.oneLocation ? response : response?.[this.location];
        if (!entry)
            throw new Error(`Location "${this.location}" not found in response: ${JSON.stringify(response)}`);
        const mode = entry.properties?.mode;
        const revision = entry.revision;
        if (mode == null || revision == null)
            throw new Error(`Mode or revision missing in response: ${JSON.stringify(response)}`);
        return [mode, revision];
    }

    private setModeAndRevision(arloMode: string, revision: string | number): void {
        const mode = ARLO_TO_SCRYPTED[arloMode] ?? arloMode as SecuritySystemMode;
        this.securitySystemState = { supportedModes: SUPPORTED_MODES, mode };
        this.setMode(mode);
        this.storage.setItem('next_revision', String(Number(revision) + 1));
    }

    get location(): string {
        return this.nativeId!.replace('.mvss', '');
    }

    get mode(): SecuritySystemMode {
        const arloMode = this.storage.getItem('mode') ?? '';
        return ARLO_TO_SCRYPTED[arloMode] ?? arloMode as SecuritySystemMode;
    }

    setMode(mode: SecuritySystemMode): void {
        if (!SUPPORTED_MODES.includes(mode))
            throw new Error(`invalid mode ${mode}`);
        this.storage.setItem('mode', SCRYPTED_TO_ARLO[mode] ?? mode);
        this.updateState(mode);
    }

    private async changeArloMode(mode: SecuritySystemMode): Promise<void> {
        this.logger.info(`Setting Arlo Security Mode to ${mode}`);
        await this.provider.arlo!.setMode(SCRYPTED_TO_ARLO[mode] ?? mode, this.location, this.storage.getItem('next_revision') ?? '');
        this.setMode(mode);
    }

    override async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key !== 'mode')
            throw new Error(`invalid setting ${key}`);
        await this.changeArloMode(value as SecuritySystemMode);
    }

    override async armSecuritySystem(mode: SecuritySystemMode): Promise<void> {
        await this.changeArloMode(mode);
    }

    override async disarmSecuritySystem(): Promise<void> {
        await this.changeArloMode(SecuritySystemMode.Disarmed);
    }

    override getApplicableInterfaces(): string[] {
        return [ScryptedInterface.SecuritySystem, ScryptedInterface.Settings, ScryptedInterface.Readme];
    }

    override async close(): Promise<void> {
        this.unsubscribeActiveMode?.();
        await super.close();
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
