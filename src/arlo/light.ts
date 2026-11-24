import { OnOff, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import { sleep } from './util';

export abstract class ArloBaseLight extends ArloDeviceBase implements OnOff {
    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, public camera?: ArloDeviceBase) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    protected async delayedInit(signal: AbortSignal): Promise<void> {
        await super.delayedInit(signal);
        const on = this.reportedState(this.camera?.arloProperties ?? this.arloProperties ?? {});
        if (typeof on !== 'boolean')
            return;
        for (let attempt = 0; attempt < 100 && !this.registered; attempt++)
            await sleep(100, signal);
        try {
            this.on = on;
        }
        catch (e) {
            this.logger.debug(`Could not set the ${this.lightName} state: ${e}`);
        }
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.OnOff];
    }

    getDeviceType(): string {
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

    protected abstract lightName: string;

    protected abstract reportedState(properties: Record<string, any>): unknown;

    protected abstract sendLightState(on: boolean): Promise<void>;
}

export class ArloSpotlight extends ArloBaseLight {
    protected lightName = 'spotlight';

    protected reportedState(properties: Record<string, any>): unknown {
        return properties.spotlight?.enabled;
    }

    protected async sendLightState(on: boolean): Promise<void> {
        await this.provider.arlo.setSpotlight(this.arloBasestation, this.arloDevice, on);
    }
}

export class ArloFloodlight extends ArloBaseLight {
    protected lightName = 'floodlight';

    protected reportedState(properties: Record<string, any>): unknown {
        return properties.floodlight?.on;
    }

    protected async sendLightState(on: boolean): Promise<void> {
        await this.provider.arlo.setFloodlight(this.arloBasestation, this.arloDevice, on);
    }
}

export class ArloNightlight extends ArloBaseLight {
    protected lightName = 'nightlight';

    protected reportedState(properties: Record<string, any>): unknown {
        return properties.nightLight?.enabled;
    }

    constructor(nativeId: string, arloDevice: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider, camera?: ArloDeviceBase) {
        super(nativeId, arloDevice, arloDevice, arloProperties, provider, camera);
    }

    protected async sendLightState(on: boolean): Promise<void> {
        await this.provider.arlo.setNightlight(this.arloDevice, on);
    }
}
