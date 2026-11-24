import { BinarySensor, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

import { ArloCamera } from './camera';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';

export class ArloDoorbell extends ArloCamera implements BinarySensor {
    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
        this.createOrRegisterEventSubscription('doorbell_subscription', () =>
            this.provider.arlo.subscribeToDoorbellEvents(this.arloDevice, pressed => this.binaryState = pressed));
    }

    getDeviceType(): string {
        return ScryptedDeviceType.Doorbell;
    }

    getApplicableInterfaces(): string[] {
        const interfaces = super.getApplicableInterfaces();
        if (!interfaces.includes(ScryptedInterface.BinarySensor))
            interfaces.push(ScryptedInterface.BinarySensor);
        return interfaces;
    }
}
