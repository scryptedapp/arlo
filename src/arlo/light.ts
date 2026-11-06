import { OnOff, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';

export abstract class ArloBaseLight extends ArloDeviceBase implements OnOff {
    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, readonly camera?: ArloDeviceBase) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    override getApplicableInterfaces(): string[] {
        return [ScryptedInterface.OnOff];
    }

    override getDeviceType(): string {
        return ScryptedDeviceType.Light;
    }

    async turnOn(): Promise<void> {
        await this.setLight(true).catch(e => this.logger.error(`Error turning on light: ${e}`));
    }

    async turnOff(): Promise<void> {
        await this.setLight(false).catch(e => this.logger.error(`Error turning off light: ${e}`));
    }

    private async setLight(on: boolean): Promise<void> {
        this.logger.info(`Turning ${this.lightName} ${on ? 'on' : 'off'}`);
        await this.sendLightState(on);
        this.on = on;
    }

    protected abstract readonly lightName: string;

    protected abstract sendLightState(on: boolean): Promise<void>;
}

export class ArloSpotlight extends ArloBaseLight {
    protected readonly lightName = 'spotlight';

    protected async sendLightState(on: boolean): Promise<void> {
        await this.provider.arlo!.setSpotlight(this.arloBasestation, this.arloDevice, on);
    }
}

export class ArloFloodlight extends ArloBaseLight {
    protected readonly lightName = 'floodlight';

    protected async sendLightState(on: boolean): Promise<void> {
        await this.provider.arlo!.setFloodlight(this.arloBasestation, this.arloDevice, on);
    }
}

// The nightlight belongs to the device itself, which acts as its own
// basestation for the command.
export class ArloNightlight extends ArloBaseLight {
    protected readonly lightName = 'nightlight';

    constructor(nativeId: string, arloDevice: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider, camera?: ArloDeviceBase) {
        super(nativeId, arloDevice, arloDevice, arloProperties, provider, camera);
    }

    protected async sendLightState(on: boolean): Promise<void> {
        await this.provider.arlo!.setNightlight(this.arloDevice, on);
    }
}
