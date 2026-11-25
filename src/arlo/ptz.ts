import { OnOff, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import type { ArloCamera } from './camera';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import { sleep } from './util';

export class ArloPtzSwitch extends ArloDeviceBase implements OnOff {
    private resetTimer?: NodeJS.Timeout;

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, public camera: ArloCamera, public direction: string, public pan: number, public tilt: number) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    async close(): Promise<void> {
        clearTimeout(this.resetTimer);
        await super.close();
    }

    protected async delayedInit(signal: AbortSignal): Promise<void> {
        await super.delayedInit(signal);
        for (let attempt = 0; attempt < 100 && !this.registered; attempt++)
            await sleep(100, signal);
        try {
            this.on = false;
        }
        catch (e) {
            this.logger.debug(`Could not set the switch state: ${e}`);
        }
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.OnOff];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.Switch;
    }

    async turnOn(): Promise<void> {
        clearTimeout(this.resetTimer);
        this.on = true;
        this.resetTimer = setTimeout(() => this.turnOff(), 1_000);
        try {
            await this.camera.ptzCommand({ pan: this.pan, tilt: this.tilt });
        }
        catch (e) {
            this.logger.error(`Error moving the camera (${this.direction}): ${e}`);
        }
    }

    async turnOff(): Promise<void> {
        clearTimeout(this.resetTimer);
        this.on = false;
    }
}
