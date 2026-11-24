import { Device, ScryptedDeviceBase } from '@scrypted/sdk';

import type { ArloDevice, Unsubscribe } from './client';
import { Logger } from './logging';
import type { ArloProvider } from './provider';
import { AsyncEvent, sleep, TaskManager } from './util';

export interface ManifestOptions {
    name?: string;
    interfaces?: string[];
    deviceType?: string;
    providerNativeId?: string;
    infoOverrides?: Device['info'];
    nativeId?: string;
}

export class ArloDeviceBase extends ScryptedDeviceBase {
    readonly logger: Logger;
    arloCapabilities: any = {};
    arloSmartFeatures: any = {};
    stopSubscriptions = false;
    private readonly subscriptions = new Map<string, Unsubscribe | 'pending'>();
    private readonly ready = new AsyncEvent();
    private closed = false;

    constructor(nativeId: string, readonly arloDevice: ArloDevice, readonly arloBasestation: ArloDevice,
        public arloProperties: Record<string, any>, readonly provider: ArloProvider, autoInit = true) {
        super(nativeId);
        this.logger = new Logger(arloDevice.deviceName, this.console);
        if (autoInit)
            this.taskManager.createTask(signal => this.delayedInit(signal), { tag: `delayed_init:${nativeId}`, owner: this });
    }

    get taskManager(): TaskManager {
        return this.provider.taskManager;
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
        for (const unsubscribe of this.subscriptions.values()) {
            if (unsubscribe !== 'pending')
                unsubscribe();
        }
        this.subscriptions.clear();
        await this.taskManager.cancelAndAwaitByOwner(this).catch(() => { });
    }

    protected async delayedInit(signal: AbortSignal): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.stopSubscriptions)
                return;
            try {
                await this.loadDeviceCapabilitiesAndSmartFeatures();
                this.ready.set();
                return;
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloDeviceBase, will try again: ${e}`);
                await sleep(100, signal);
            }
        }
        this.logger.error('Delayed init exceeded iteration limit for ArloDeviceBase, giving up.');
        this.ready.set();
    }

    private async loadDeviceCapabilitiesAndSmartFeatures(): Promise<void> {
        if (this.nativeId!.endsWith('mvss'))
            return;
        try {
            this.arloCapabilities = await this.provider.arlo!.getDeviceCapabilities(this.arloDevice);
            this.arloSmartFeatures = await this.provider.arlo!.getDeviceSmartFeatures(this.arloDevice);
        }
        catch (e) {
            this.logger.warn(`Could not load device capabilities and smart features: ${e}`);
            this.arloCapabilities = {};
            this.arloSmartFeatures = {};
        }
    }

    protected markReady(): void {
        this.ready.set();
    }

    waitForReady(signal?: AbortSignal): Promise<void> {
        return this.ready.wait(signal);
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
        const info = this.nativeId!.endsWith('mvss') ? infoOverrides : {
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
        if (this.subscriptions.has(key)) {
            this.logger.debug(`Event subscription "${key}" already running for device ${this.arloDevice.deviceId}.`);
            return;
        }
        if (!this.provider.setupInProgress) {
            this.subscriptions.set(key, subscribe());
            return;
        }
        this.subscriptions.set(key, 'pending');
        this.taskManager.createTask(async signal => {
            while (this.provider.setupInProgress && !this.stopSubscriptions)
                await sleep(1_000, signal);
            if (!this.stopSubscriptions && this.subscriptions.get(key) === 'pending')
                this.subscriptions.set(key, subscribe());
        }, { tag: key, owner: this });
    }

    protected removeEventSubscription(key: string): void {
        const unsubscribe = this.subscriptions.get(key);
        this.subscriptions.delete(key);
        if (unsubscribe && unsubscribe !== 'pending')
            unsubscribe();
    }

    hasFeature(feature: string): boolean {
        return !!this.arloSmartFeatures?.planFeatures?.[feature];
    }

    private capabilities(subCapability?: string, subSubCapability?: string): any {
        let capabilities = this.arloCapabilities?.Capabilities ?? {};
        if (subCapability)
            capabilities = capabilities[subCapability] ?? {};
        if (subSubCapability)
            capabilities = capabilities[subSubCapability] ?? {};
        return capabilities;
    }

    hasCapability(capability: string, subCapability?: string, subSubCapability?: string): boolean {
        const capabilities = this.capabilities(subCapability, subSubCapability);
        return Array.isArray(capabilities) ? capabilities.includes(capability) : capability in capabilities;
    }

    getCapability(capability: string, subCapability?: string, subSubCapability?: string): any {
        const capabilities = this.capabilities(subCapability, subSubCapability);
        return Array.isArray(capabilities) ? undefined : capabilities[capability];
    }

    hasProperty(property: string, subProperty?: string): boolean {
        if (!this.arloProperties)
            return false;
        return subProperty ? property in (this.arloProperties[subProperty] ?? {}) : property in this.arloProperties;
    }
}
