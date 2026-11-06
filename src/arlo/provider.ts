import { DeviceProvider, ScryptedDeviceBase, Setting, Settings, SettingValue } from '@scrypted/sdk';

import { initImpers } from './client/request';
import { Logger } from './logging';
import { TaskManager } from './util';

export class ArloProvider extends ScryptedDeviceBase implements DeviceProvider, Settings {
    readonly logger = new Logger('Arlo Provider', this.console);
    readonly taskManager = new TaskManager(this.logger);

    constructor(nativeId?: string) {
        super(nativeId);
        this.taskManager.createTask(() => initImpers(this.logger), { tag: 'initialize_plugin', owner: this });
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
