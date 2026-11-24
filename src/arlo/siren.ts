import { OnOff, ScryptedDeviceType, ScryptedInterface, SecuritySystemMode } from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import { ArloBasestation } from './basestation';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import type { ArloSirenVirtualSecuritySystem } from './vss';

export class ArloSiren extends ArloDeviceBase implements OnOff {
    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, public svss: ArloSirenVirtualSecuritySystem) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.OnOff];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.Siren;
    }

    async turnOn(): Promise<void> {
        try {
            this.logger.info('Turning on');
            const state = this.svss.securitySystemState ?? { mode: this.svss.mode };
            if (this.svss.mode === SecuritySystemMode.Disarmed) {
                this.logger.info('Virtual security system is disarmed, ignoring trigger');
                this.on = true;
                this.on = false;
                this.svss.securitySystemState = { ...state, triggered: false };
                return;
            }
            if (this.svss.parent instanceof ArloBasestation) {
                this.logger.debug('Parent device is a basestation');
                await this.provider.arlo.setSiren(this.arloBasestation, undefined, true);
            }
            else {
                this.logger.debug('Parent device is a camera');
                await this.provider.arlo.setSiren(this.arloBasestation, this.arloDevice, true);
            }
            this.on = true;
            this.svss.securitySystemState = { ...state, triggered: true };
        }
        catch (e) {
            this.logger.error(`Error turning on siren: ${e}`);
        }
    }

    async turnOff(): Promise<void> {
        try {
            this.logger.info('Turning off');
            const state = this.svss.securitySystemState ?? { mode: this.svss.mode };
            if (this.svss.parent instanceof ArloBasestation)
                await this.provider.arlo.setSiren(this.arloBasestation, undefined, false);
            else
                await this.provider.arlo.setSiren(this.arloBasestation, this.arloDevice, false);
            this.on = false;
            this.svss.securitySystemState = { ...state, triggered: false };
        }
        catch (e) {
            this.logger.error(`Error turning off siren: ${e}`);
        }
    }
}
