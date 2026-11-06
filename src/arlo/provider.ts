import { DeviceProvider, ScryptedDeviceBase, Setting, Settings, SettingValue } from '@scrypted/sdk';

import { initImpers } from './client/request';

export class ArloProvider extends ScryptedDeviceBase implements DeviceProvider, Settings {
    constructor(nativeId?: string) {
        super(nativeId);
        initImpers(this.console).catch(e => this.console.error('Failed to load impers:', e));
    }

    async getSettings(): Promise<Setting[]> {
        return [];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
    }

    async getDevice(nativeId: string): Promise<any> {
        return undefined;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }
}
