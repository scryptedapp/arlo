import crypto from 'node:crypto';

import sdk, { Device, DeviceProvider, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';

import { ArloDeviceBase } from './base';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import { sleep } from './util';
import { ArloSirenVirtualSecuritySystem } from './vss';

function pemCertificate(body: string): string {
    return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
}

export class ArloBasestation extends ArloDeviceBase implements DeviceProvider, Settings {
    deviceState?: string;
    private rebootTime?: number = Date.now();
    svss?: ArloSirenVirtualSecuritySystem;

    storageSettings = new StorageSettings(this, {
        ip: {
            group: 'General',
            title: 'IP Address',
            description: 'This is the IP Address of the basestation pulled from mDNS. '
                + 'This will be used for cameras that support local streaming. '
                + 'Note that the basestation must be in the same network as Scrypted for this to work. '
                + 'If this is empty, it means mDNS failed to find your basestation, '
                + 'You will have to input the IP Address into this field manually.',
            onGet: async () => ({ hide: !this.hasLocalLiveStreaming, readonly: this.mdnsBoolean }),
        },
        host_name: {
            group: 'General',
            title: 'Hostname',
            description: 'This is the Hostname of the basestation pulled from mDNS. '
                + 'This will be used for cameras that support local streaming. '
                + 'Note that the basestation must be in the same network as Scrypted for this to work. '
                + 'If this is empty, it means mDNS failed to find your basestation, '
                + 'You will have to input the Hostname into this field manually, '
                + 'Usually the model including the domain, i.e. "VMB5000.local" or "VMB5000-2.local" '
                + 'if you have mutliple of the same model basestation.',
            onGet: async () => ({ hide: !this.hasLocalLiveStreaming, readonly: this.mdnsBoolean }),
        },
        print_debug: {
            group: 'General',
            title: 'Debug Info',
            description: 'Prints information about this device to console.',
            type: 'button',
            noStore: true,
        },
        restart_device: {
            group: 'General',
            title: 'Restart Device',
            description: 'Restarts the Device.',
            type: 'button',
            noStore: true,
            onGet: async () => ({ hide: !this.canRestart }),
        },
    });

    constructor(nativeId: string, arloBasestation: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider) {
        super(nativeId, arloBasestation, arloBasestation, arloProperties, provider);
        this.startDeviceStateSubscription();
    }

    async close(): Promise<void> {
        await this.svss?.close();
        await super.close();
    }

    protected async delayedInit(signal: AbortSignal): Promise<void> {
        await super.delayedInit(signal);
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.stopSubscriptions)
                return;
            try {
                if (!this.arloProperties || !Object.keys(this.arloProperties).length)
                    this.arloProperties = await this.provider.getDeviceProperties(this.arloDevice);
                if (this.hasLocalLiveStreaming) {
                    await this.checkCertificates();
                    this.mdns();
                }
                this.deviceState = this.arloProperties.state === 'idle' ? 'available' : 'unavailable';
                return;
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloBasestation, will try again: ${e}`);
                await sleep(100, signal);
            }
        }
        this.logger.error('Delayed init exceeded iteration limit for ArloBasestation, giving up.');
    }

    private startDeviceStateSubscription(): void {
        this.createOrRegisterEventSubscription('device_state_subscription', () =>
            this.provider.arlo.subscribeToDeviceStateEvents(this.arloDevice, state => {
                if (state === 'available' && this.rebootTime && Date.now() - this.rebootTime < 30_000)
                    return;
                this.deviceState = state;
                if (state === 'available')
                    this.rebootTime = undefined;
            }));
    }

    private async checkCertificates(): Promise<void> {
        this.logger.debug('Checking if Certificates are created with Arlo');
        if (!this.peerCert || !this.deviceCert || !this.icaCert) {
            this.logger.debug('Certificates have not been created with Arlo, proceeding with Certificate Creation');
            await this.createCertificates();
            return;
        }
        if (!this.checkCertificateAndKeyMatch()) {
            this.logger.debug('Certificates exist but do not match the expected keys, generating new keypair and creating new certificates.');
            this.provider.generateArloKeypair();
            await this.createCertificates();
            return;
        }
        this.logger.debug('Certificates have been created with Arlo and match the expected keys, skipping Certificate Creation');
    }

    private checkCertificateAndKeyMatch(): boolean {
        try {
            return new crypto.X509Certificate(this.peerCert).checkPrivateKey(crypto.createPrivateKey(this.provider.arloPrivateKey));
        }
        catch (e) {
            this.logger.warn(`Error checking peer certificate and private key match: ${e}`);
            return false;
        }
    }

    private async createCertificates(): Promise<void> {
        const publicKey = this.provider.arloPublicKey.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
        const certificates = await this.provider.arlo.createCertificates(this.arloBasestation, publicKey);
        if (!certificates) {
            this.logger.error('Failed to create Certificates with Arlo');
            return;
        }
        this.logger.debug('Certificates have been created with Arlo, parsing certificates');
        this.parseCertificates(certificates);
    }

    private parseCertificates(certificates: any): void {
        const peerCert = certificates.certsData?.[0]?.peerCert;
        const deviceCert = certificates.certsData?.[0]?.deviceCert;
        const icaCert = certificates.icaCert;
        if (peerCert && deviceCert && icaCert) {
            this.logger.debug('Certificates have been parsed, storing certificates');
            this.storeCertificates(peerCert, deviceCert, icaCert);
            return;
        }
        if (!peerCert)
            this.logger.error('Failed to parse peer Certificate');
        if (!deviceCert)
            this.logger.error('Failed to parse device Certificate');
        if (!icaCert)
            this.logger.error('Failed to parse ICA Certificate');
    }

    private storeCertificates(peerCert: string, deviceCert: string, icaCert: string): void {
        this.storage.setItem('peer_cert', pemCertificate(peerCert));
        this.storage.setItem('device_cert', pemCertificate(deviceCert));
        this.storage.setItem('ica_cert', pemCertificate(icaCert));
        this.logger.debug('Certificates have been stored with Scrypted');
    }

    private mdns(): void {
        this.logger.debug('Checking if Basestation is found in mDNS.');
        const service = this.provider.mdnsServices[this.arloDevice.deviceId];
        this.storage.setItem('mdns_boolean', String(!!service));
        if (service) {
            this.logger.debug('Basestation found in mDNS, setting IP Address and Hostname.');
            this.storage.setItem('ip', service.address);
            this.storage.setItem('host_name', service.server);
        }
        else if (!this.ip || !this.hostName) {
            this.logger.error('Basestation not found in mDNS, manual input needed under basestation settings.');
        }
    }

    get hasSiren(): boolean {
        return this.hasCapability('Siren', 'ResourceTypes');
    }

    get hasLocalLiveStreaming(): boolean {
        return this.hasCapability('supported', 'sipLiveStream') && this.provider.arlo?.userId === this.arloDevice.owner?.ownerId;
    }

    get canRestart(): boolean {
        return this.provider.arlo?.userId === this.arloDevice.owner?.ownerId;
    }

    get ip(): string | undefined {
        return this.storage.getItem('ip') || undefined;
    }

    get hostName(): string | undefined {
        return this.storage.getItem('host_name') || undefined;
    }

    get mdnsBoolean(): boolean {
        return this.storage.getItem('mdns_boolean') === 'true';
    }

    get peerCert(): string | undefined {
        return this.storage.getItem('peer_cert') || undefined;
    }

    get deviceCert(): string | undefined {
        return this.storage.getItem('device_cert') || undefined;
    }

    get icaCert(): string | undefined {
        return this.storage.getItem('ica_cert') || undefined;
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.DeviceProvider, ScryptedInterface.Settings];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.DeviceProvider;
    }

    getBuiltinChildDeviceManifests(): Device[] {
        if (!this.hasSiren)
            return [];
        const svss = this.getSvss();
        return [
            svss.getDeviceManifest({
                name: `${this.arloDevice.deviceName} Siren Virtual Security System`,
                interfaces: svss.getApplicableInterfaces(),
                deviceType: svss.getDeviceType(),
                providerNativeId: this.nativeId,
                nativeId: svss.nativeId,
            }),
            ...svss.getBuiltinChildDeviceManifests(),
        ];
    }

    async refreshDevice(): Promise<void> {
        try {
            this.arloProperties = await this.provider.getDeviceProperties(this.arloDevice);
            if (this.hasSiren) {
                const svss = this.getSvss();
                svss.arloProperties = this.arloProperties;
                if (svss.siren)
                    svss.siren.arloProperties = this.arloProperties;
            }
            for (const manifest of [this.getDeviceManifest(), ...this.getBuiltinChildDeviceManifests()])
                await sdk.deviceManager.onDeviceDiscovered(manifest);
            await this.onDeviceEvent(ScryptedInterface.DeviceProvider, undefined);
            this.logger.debug('Basestation and children refreshed and updated in Scrypted.');
        }
        catch (e) {
            this.logger.error('Error refreshing basestation:', e);
        }
    }

    async getDevice(nativeId: string): Promise<ArloDeviceBase | undefined> {
        if (!nativeId.startsWith(this.nativeId))
            return this.provider.getDevice(nativeId);
        return nativeId.endsWith('svss') ? this.getSvss() : undefined;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }

    private getSvss(): ArloSirenVirtualSecuritySystem {
        this.svss ??= new ArloSirenVirtualSecuritySystem(`${this.arloDevice.deviceId}.svss`, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this);
        return this.svss;
    }

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'print_debug') {
            this.logger.debug(`Device Capabilities: ${JSON.stringify(this.arloCapabilities)}`);
            this.logger.debug(`Device Smart Features: ${JSON.stringify(this.arloSmartFeatures)}`);
            this.logger.debug(`Device Properties: ${JSON.stringify(this.arloProperties)}`);
            this.logger.debug(`Peer Certificate:\n${this.peerCert}`);
            this.logger.debug(`Device Certificate:\n${this.deviceCert}`);
            this.logger.debug(`ICA Certificate:\n${this.icaCert}`);
            this.logger.debug(`Device State: ${this.deviceState}`);
        }
        else if (key === 'restart_device') {
            this.logger.debug('Restarting Device');
            this.rebootTime = Date.now();
            await this.provider.arlo.restartDevice(this.arloDevice.deviceId);
        }
        else {
            await this.storageSettings.putSetting(key, value);
        }
        await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }
}
