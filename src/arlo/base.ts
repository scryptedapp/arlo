import { Device, ScryptedDeviceBase } from '@scrypted/sdk';

import type { ArloDevice, Unsubscribe } from './client';
import { Logger } from './logging';
import type { ArloProvider } from './provider';
import { AsyncEvent, sleep, TaskManager } from './util';

interface ManifestOptions {
    name?: string;
    interfaces?: string[];
    deviceType?: string;
    providerNativeId?: string;
    infoOverrides?: Device['info'];
    nativeId?: string;
}

export class ArloDeviceBase extends ScryptedDeviceBase {
    logger: Logger;
    arloCapabilities: any = {};
    arloSmartFeatures: any = {};
    stopSubscriptions = false;
    activeEventSubscriptions = new Map<string, Unsubscribe | 'pending'>();
    taskManager: TaskManager;
    protected readyEvent = new AsyncEvent();
    private closed = false;

    constructor(nativeId: string, public arloDevice: ArloDevice, public arloBasestation: ArloDevice,
        public arloProperties: Record<string, any>, public provider: ArloProvider, autoInit = true) {
        super(nativeId);
        this.logger = new Logger(arloDevice.deviceName, this.console);
        this.taskManager = provider.taskManager;
        if (autoInit)
            this.taskManager.createTask(signal => this.delayedInit(signal), { tag: `delayed_init:${nativeId}`, owner: this });
    }

    get registered(): boolean {
        try {
            this.storage.getItem('registered');
            return true;
        }
        catch {
            return false;
        }
    }

    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        this.stopSubscriptions = true;
        for (const unsubscribe of this.activeEventSubscriptions.values()) {
            if (unsubscribe !== 'pending')
                unsubscribe();
        }
        this.activeEventSubscriptions.clear();
        await this.taskManager.cancelAndAwaitByOwner(this).catch(() => { });
    }

    protected async delayedInit(signal: AbortSignal): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.stopSubscriptions)
                return;
            try {
                await this.loadDeviceCapabilitiesAndSmartFeatures();
                this.readyEvent.set();
                return;
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloDeviceBase, will try again: ${e}`);
                await sleep(100, signal);
            }
        }
        this.logger.error('Delayed init exceeded iteration limit for ArloDeviceBase, giving up.');
        this.readyEvent.set();
    }

    private async loadDeviceCapabilitiesAndSmartFeatures(): Promise<void> {
        if (this.nativeId.endsWith('mvss'))
            return;
        try {
            this.arloCapabilities = await this.provider.arlo.getDeviceCapabilities(this.arloDevice);
            this.arloSmartFeatures = await this.provider.arlo.getDeviceSmartFeatures(this.arloDevice);
        }
        catch (e) {
            this.logger.warn(`Could not load device capabilities and smart features: ${e}`);
            this.arloCapabilities = {};
            this.arloSmartFeatures = {};
        }
    }

    waitForReady(signal?: AbortSignal): Promise<void> {
        return this.readyEvent.wait(signal);
    }

    getApplicableInterfaces(): string[] {
        return [];
    }

    getDeviceType(): string {
        return '';
    }

    getDeviceManifest({ name, interfaces, deviceType, providerNativeId, infoOverrides, nativeId }: ManifestOptions = {}): Device {
        if (!providerNativeId) {
            const parentId = this.arloDevice.parentId;
            if (parentId && parentId !== this.arloDevice.deviceId && !this.provider.hiddenDeviceIds.includes(parentId))
                providerNativeId = parentId;
        }
        const modelId = this.arloDevice.modelId ?? '';
        const hwVersion = String(this.arloProperties?.hwVersion ?? '').replaceAll(modelId, '').replaceAll('er', '').replaceAll('r', '');
        const info = this.nativeId.endsWith('mvss') ? infoOverrides : {
            model: `${modelId} ${hwVersion}`.trim(),
            manufacturer: 'Arlo',
            firmware: this.arloDevice.firmwareVersion,
            serialNumber: this.arloDevice.deviceId,
        };
        return {
            info,
            nativeId: nativeId ?? this.arloDevice.deviceId,
            name: name ?? this.arloDevice.deviceName,
            interfaces: interfaces ?? this.getApplicableInterfaces(),
            type: (deviceType ?? this.getDeviceType()) as Device['type'],
            providerNativeId,
        };
    }

    getBuiltinChildDeviceManifests(): Device[] {
        return [];
    }

    async refreshDevice(): Promise<void> {
    }

    protected createOrRegisterEventSubscription(key: string, subscribe: () => Unsubscribe): void {
        if (this.stopSubscriptions)
            return;
        if (this.activeEventSubscriptions.has(key)) {
            this.logger.debug(`Event subscription "${key}" already running for device ${this.arloDevice.deviceId}.`);
            return;
        }
        if (!this.provider.setupInProgress) {
            this.activeEventSubscriptions.set(key, subscribe());
            return;
        }
        this.activeEventSubscriptions.set(key, 'pending');
        this.taskManager.createTask(async signal => {
            while (this.provider.setupInProgress && !this.stopSubscriptions)
                await sleep(1_000, signal);
            if (!this.stopSubscriptions && this.activeEventSubscriptions.get(key) === 'pending')
                this.activeEventSubscriptions.set(key, subscribe());
        }, { tag: key, owner: this });
    }

    protected removeEventSubscription(key: string): void {
        const unsubscribe = this.activeEventSubscriptions.get(key);
        this.activeEventSubscriptions.delete(key);
        if (unsubscribe && unsubscribe !== 'pending')
            unsubscribe();
    }

    protected hasFeature(feature: string): boolean {
        return !!this.arloSmartFeatures?.planFeatures?.[feature];
    }

    private getCapabilities(subCapability?: string, subSubCapability?: string): any {
        let capabilities = this.arloCapabilities?.Capabilities ?? {};
        if (subCapability)
            capabilities = capabilities[subCapability] ?? {};
        if (subSubCapability)
            capabilities = capabilities[subSubCapability] ?? {};
        return capabilities;
    }

    protected hasCapability(capability: string, subCapability?: string, subSubCapability?: string): boolean {
        const capabilities = this.getCapabilities(subCapability, subSubCapability);
        return Array.isArray(capabilities) ? capabilities.includes(capability) : capability in capabilities;
    }

    protected getCapability(capability: string, subCapability?: string, subSubCapability?: string): any {
        const capabilities = this.getCapabilities(subCapability, subSubCapability);
        return Array.isArray(capabilities) ? undefined : capabilities[capability];
    }

    protected hasProperty(property: string, subProperty?: string): boolean {
        if (!this.arloProperties)
            return false;
        return subProperty ? property in (this.arloProperties[subProperty] ?? {}) : property in this.arloProperties;
    }
}
