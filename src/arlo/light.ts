import { OnOff, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import type { ArloCamera } from './camera';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import { sleep } from './util';

export class ArloBaseLight extends ArloDeviceBase implements OnOff {
    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, public camera?: ArloCamera) {
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
            this.logger.debug(`Could not set the light state: ${e}`);
        }
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.OnOff];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.Light;
    }

    async turnOn(): Promise<void> {
        try {
            await this.setLightState(true);
        }
        catch (e) {
            this.logger.error(`Error turning on light: ${e}`);
        }
    }

    async turnOff(): Promise<void> {
        try {
            await this.setLightState(false);
        }
        catch (e) {
            this.logger.error(`Error turning off light: ${e}`);
        }
    }

    protected reportedState(properties: Record<string, any>): boolean | undefined {
        return undefined;
    }

    protected async setLightState(state: boolean): Promise<void> {
        throw new Error('Subclasses must implement setLightState');
    }
}

export class ArloSpotlight extends ArloBaseLight {
    protected reportedState(properties: Record<string, any>): boolean | undefined {
        return properties.spotlight?.enabled;
    }

    protected async setLightState(state: boolean): Promise<void> {
        this.logger.info(`Turning spotlight ${state ? 'on' : 'off'}`);
        await this.provider.arlo.setSpotlight(this.arloBasestation, this.arloDevice, state);
        this.on = state;
    }
}

export class ArloFloodlight extends ArloBaseLight {
    protected reportedState(properties: Record<string, any>): boolean | undefined {
        return properties.floodlight?.on;
    }

    protected async setLightState(state: boolean): Promise<void> {
        this.logger.info(`Turning floodlight ${state ? 'on' : 'off'}`);
        await this.provider.arlo.setFloodlight(this.arloBasestation, this.arloDevice, state);
        this.on = state;
    }
}

export class ArloNightlight extends ArloBaseLight {
    constructor(nativeId: string, arloDevice: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider, camera?: ArloCamera) {
        super(nativeId, arloDevice, arloDevice, arloProperties, provider, camera);
    }

    protected reportedState(properties: Record<string, any>): boolean | undefined {
        return properties.nightLight?.enabled;
    }

    protected async setLightState(state: boolean): Promise<void> {
        this.logger.info(`Turning nightlight ${state ? 'on' : 'off'}`);
        await this.provider.arlo.setNightlight(this.arloDevice, state);
        this.on = state;
    }
}
