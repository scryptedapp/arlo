import { OnOff, ScryptedDeviceType, ScryptedInterface, SecuritySystemMode } from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import { ArloBasestation } from './basestation';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import type { ArloSirenVirtualSecuritySystem } from './vss';

// A siren, armed through its virtual security system: while that is disarmed,
// turning the siren on is ignored.
export class ArloSiren extends ArloDeviceBase implements OnOff {
    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, readonly svss: ArloSirenVirtualSecuritySystem) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    override getApplicableInterfaces(): string[] {
        return [ScryptedInterface.OnOff];
    }

    override getDeviceType(): string {
        return ScryptedDeviceType.Siren;
    }

    // A basestation siren is addressed as the basestation's; a camera siren
    // through its basestation.
    private sirenCamera(): ArloDevice | undefined {
        return this.svss.parent instanceof ArloBasestation ? undefined : this.arloDevice;
    }

    async turnOn(): Promise<void> {
        try {
            this.logger.info('Turning on');
            // The stored mode, which reads as Disarmed when unset, so a security
            // system whose state is not known yet never lets the siren sound.
            const state = this.svss.securitySystemState ?? { mode: this.svss.mode };
            if (this.svss.mode === SecuritySystemMode.Disarmed) {
                this.logger.info('Virtual security system is disarmed, ignoring trigger');
                this.on = true;
                this.on = false;
                this.svss.securitySystemState = { ...state, triggered: false };
                return;
            }
            await this.provider.arlo!.setSiren(this.arloBasestation, this.sirenCamera(), true);
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
            await this.provider.arlo!.setSiren(this.arloBasestation, this.sirenCamera(), false);
            this.on = false;
            this.svss.securitySystemState = { ...this.svss.securitySystemState!, triggered: false };
        }
        catch (e) {
            this.logger.error(`Error turning off siren: ${e}`);
        }
    }
}
