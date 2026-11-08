import sdk, {
    AudioSensor,
    Battery,
    Brightness,
    Camera,
    ChargeState,
    Charger,
    Device,
    DeviceProvider,
    FFmpegInput,
    Intercom,
    MediaObject,
    MotionSensor,
    ObjectDetectionTypes,
    ObjectDetector,
    ObjectsDetected,
    OnOff,
    RequestMediaStreamOptions,
    RequestPictureOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
    RTCAVSignalingSetup,
    RTCSessionControl,
    RTCSignalingChannel,
    RTCSignalingSession,
    ScryptedDeviceType,
    ScryptedInterface,
    Setting,
    Settings,
    SettingValue,
    VideoCamera,
    VideoClip,
    VideoClipOptions,
    VideoClips,
    VideoClipThumbnailOptions,
} from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';

import { ArloDeviceBase } from './base';
import type { ArloBasestation } from './basestation';
import type { ArloDevice, StreamSipInfo } from './client';
import { ArloIntercom } from './intercom';
import { ArloBaseLight, ArloFloodlight, ArloNightlight, ArloSpotlight } from './light';
import { ArloLocalStreamProxy } from './local_stream';
import type { ArloProvider } from './provider';
import { AsyncLock, sleep, TimeoutError, withTimeout } from './util';
import { ArloSirenVirtualSecuritySystem } from './vss';
import { ArloCameraWebRTCSessionControl, ArloCameraWebRTCSignalingSession } from './webrtc_sip';

const SCRYPTED_TO_ARLO_BRIGHTNESS: Record<number, number> = { 0: -2, 25: -1, 50: 0, 75: 1, 100: 2 };
const ARLO_TO_SCRYPTED_BRIGHTNESS: Record<number, number> = Object.fromEntries(
    Object.entries(SCRYPTED_TO_ARLO_BRIGHTNESS).map(([scrypted, arlo]) => [arlo, Number(scrypted)]));

const TIMEOUT = 10_000;
const DAY = 86_400_000;

// A snapshot source that does not apply right now, which is not a failure.
class SourceUnavailable extends Error { }

export class ArloCamera extends ArloDeviceBase implements AudioSensor, Battery, Brightness, Camera, Charger, DeviceProvider,
    MotionSensor, ObjectDetector, OnOff, RTCSignalingChannel, Settings, VideoCamera, VideoClips, Intercom {
    intercom?: ArloIntercom;
    light?: ArloBaseLight;
    svss?: ArloSirenVirtualSecuritySystem;
    private speaker?: any;
    deviceState?: string;
    activityState?: string;
    private lastSnapshot?: MediaObject;
    private lastSnapshotTime = 0;
    private lastSnapshotUrl = '';
    private intercomActive = false;
    private skipPrebufferOnFirstAutoSnapshot = true;
    private readonly snapshotLock = new AsyncLock();
    private readonly rtcSessions = new Set<ArloCameraWebRTCSignalingSession>();
    // The SIP session that came with the current cloud RTSP stream, for the
    // SIP-only intercom. Held in memory only, since it carries a SIP password,
    // and cleared when the camera reports the stream ended.
    streamSipInfo?: StreamSipInfo;

    readonly storageSettings = new StorageSettings(this, {
        wired_to_power: {
            group: 'General',
            title: 'Plugged In to External Power',
            description: 'Informs Scrypted that this device is plugged in to an external power source. '
                + 'Will allow features like persistent prebuffer to work. '
                + 'Note that a persistent prebuffer may cause excess battery drain if the external power is not able to charge faster than the battery consumption rate.',
            type: 'boolean',
            onGet: async () => ({ hide: !this.hasBattery }),
        },
        eco_mode: {
            group: 'General',
            title: 'Eco Mode',
            description: 'Configures Scrypted to limit the number of requests made to this camera. Additional eco mode settings will appear when this is turned on.',
            type: 'boolean',
        },
        disable_eager_streams: {
            group: 'General',
            title: 'Disable Eager Streams for RTSP',
            description: 'If eager streams are disabled, Scrypted will wait for Arlo Cloud to report that the RTSP camera stream has started before passing the stream URL to downstream consumers.',
            type: 'boolean',
        },
        disable_webrtc: {
            group: 'General',
            title: 'Disable WebRTC',
            description: 'Disables WebRTC streaming for this camera. This will prevent the camera from being used in the Scrypted WebRTC UI, but will still allow RTSP streaming.',
            type: 'boolean',
            onGet: async () => ({ hide: !this.hasSipWebrtcStreaming }),
        },
        local_live_streaming_codec: {
            group: 'General',
            title: 'Local Live Streaming Codec',
            description: 'Select the codec to pull the Local Live Stream from the basestation.',
            defaultValue: 'h.264',
            onGet: async () => ({ hide: !this.hasLocalLiveStreaming, choices: this.localLiveStreamingCodecList }),
        },
        snapshot_throttle_interval: {
            group: 'Eco Mode',
            title: 'Snapshot Throttle Interval',
            description: 'Time, in minutes, to throttle snapshot requests. '
                + 'When eco mode is on, snapshot requests to the camera will be throttled for the given duration. '
                + 'Cached snapshots may be returned if the time since the last snapshot has not exceeded the interval. '
                + 'A value of 0 will disable throttling even when eco mode is on.',
            type: 'number',
            defaultValue: 60,
            onGet: async () => ({ hide: this.storage.getItem('eco_mode') !== 'true' }),
        },
        print_debug: {
            group: 'General',
            title: 'Debug Info',
            description: 'Prints information about this device to console.',
            type: 'button',
            noStore: true,
        },
        restart_device: {
            group: 'General',
            title: 'Restart Device',
            description: 'Restarts the Device.',
            type: 'button',
            noStore: true,
            onGet: async () => ({ hide: !this.canRestart }),
        },
    });

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>, provider: ArloProvider) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    override async close(): Promise<void> {
        for (const session of this.rtcSessions)
            await session.close().catch(() => { });
        this.rtcSessions.clear();
        await this.intercom?.close().catch(() => { });
        await this.light?.close().catch(() => { });
        await this.svss?.close().catch(() => { });
        this.intercomActive = false;
        this.speaker = undefined;
        await super.close();
    }

    protected override async delayedInit(signal: AbortSignal): Promise<void> {
        await super.delayedInit(signal);
        this.startEventSubscriptions();
        for (let attempt = 0; attempt < 100; attempt++) {
            if (this.stopSubscriptions)
                return;
            try {
                if (!this.arloProperties || !Object.keys(this.arloProperties).length)
                    this.arloProperties = await this.provider.getDeviceProperties(this.arloBasestation, this.arloDevice);
                if (this.hasBattery) {
                    this.batteryLevel = this.arloProperties.batteryLevel ?? 0;
                    this.chargeState = this.wiredToPower ? ChargeState.Charging : ChargeState.NotCharging;
                }
                if (this.ledProperty)
                    this.on = !!this.arloProperties[this.ledProperty];
                this.deviceState = this.arloProperties.connectionState ?? 'unavailable';
                this.activityState = this.arloProperties.activityState ?? 'unavailable';
                this.brightness = ARLO_TO_SCRYPTED_BRIGHTNESS[this.arloProperties.brightness ?? 0];
                this.startAutoSnapshot();
                return;
            }
            catch (e) {
                this.logger.debug(`Delayed init failed for ArloCamera, will try again: ${e}`);
                await sleep(100, signal);
            }
        }
        this.logger.error('Delayed init exceeded iteration limit for ArloCamera, giving up.');
    }

    private startEventSubscriptions(): void {
        const arlo = () => this.provider.arlo!;
        this.createOrRegisterEventSubscription('error_subscription', () => arlo().subscribeToErrorEvents(this.arloDevice,
            (code, message) => this.logger.error(`Arlo returned error code ${code} with message: ${message}`)));
        this.createOrRegisterEventSubscription('device_state_subscription', () => arlo().subscribeToDeviceStateEvents(this.arloDevice,
            state => this.deviceState = state));
        this.createOrRegisterEventSubscription('activity_state_subscription', () => arlo().subscribeToActivityStateEvents(this.arloDevice, state => {
            this.activityState = state;
            if (state === 'idle' && this.streamSipInfo) {
                this.logger.debug('Stream ended; clearing its SIP session.');
                this.streamSipInfo = undefined;
            }
        }));
        this.createOrRegisterEventSubscription('snapshot_subscription', () => arlo().subscribeToSnapshotEvents(this.arloDevice, url => {
            this.taskManager.createTask(() => this.getSnapshotFromEventUrl(url), { tag: `snapshot_event_update:${this.nativeId}`, owner: this });
        }));
        this.createOrRegisterEventSubscription('motion_subscription', () => arlo().subscribeToMotionEvents(this.arloDevice,
            detected => this.motionDetected = detected, this.logger));
        if (this.hasAudioSensor)
            this.createOrRegisterEventSubscription('audio_subscription', () => arlo().subscribeToAudioEvents(this.arloDevice,
                detected => this.audioDetected = detected, this.logger));
        if (this.hasBattery)
            this.createOrRegisterEventSubscription('battery_subscription', () => arlo().subscribeToPropertyEvents(this.arloDevice, 'batteryLevel',
                level => this.batteryLevel = level));
        const ledProperty = this.ledProperty;
        if (ledProperty)
            this.createOrRegisterEventSubscription('led_subscription', () => arlo().subscribeToPropertyEvents(this.arloDevice,
                ledProperty, enabled => this.on = enabled));
        this.createOrRegisterEventSubscription('brightness_subscription', () => arlo().subscribeToPropertyEvents(this.arloDevice, 'brightness',
            brightness => this.brightness = ARLO_TO_SCRYPTED_BRIGHTNESS[brightness]));
        let lastSeen = 0;
        this.createOrRegisterEventSubscription('smart_motion_subscription', () => arlo().subscribeToSmartMotionEvents(this.arloDevice, event => {
            const timestamp = event.utcCreatedDate ?? 0;
            if (timestamp <= lastSeen)
                return;
            lastSeen = timestamp;
            const detection = {
                detectionId: `${timestamp}`,
                timestamp,
                detections: (event.objCategory ?? []).map((category: string) => ({ className: category.toLowerCase() })),
            } as ObjectsDetected;
            this.onDeviceEvent(ScryptedInterface.ObjectDetector, detection).catch(() => { });
        }));
    }

    private async getSnapshotFromEventUrl(url: string): Promise<void> {
        try {
            await this.snapshotLock.run(async () => {
                await sleep(1_000);
                if (url !== this.lastSnapshotUrl) {
                    await this.createSnapshotFromBuffer(await this.getBufferFromUrl(url));
                    this.lastSnapshotUrl = url;
                }
            });
        }
        catch (e) {
            this.logger.debug(`Failed to update snapshot from subscription event url: ${e}`);
        }
    }

    // Automatic snapshots, every throttle interval, while the plugin setting is on.

    private shouldRunAutoSnapshot(): boolean {
        return this.provider.autoSnapshotGeneration && this.snapshotThrottleInterval > 0;
    }

    private startAutoSnapshot(): void {
        if (!this.shouldRunAutoSnapshot()) {
            this.skipPrebufferOnFirstAutoSnapshot = false;
            return;
        }
        this.createOrRegisterEventSubscription('auto_snapshot', () => {
            const task = this.taskManager.createTask(signal => this.autoSnapshotLoop(signal), { tag: 'auto_snapshot', owner: this });
            return () => task.controller.abort();
        });
    }

    private async autoSnapshotLoop(signal: AbortSignal): Promise<void> {
        let startupDelayDone = false;
        while (!this.stopSubscriptions) {
            const interval = this.snapshotThrottleInterval * 60_000;
            if (this.provider.setupInProgress) {
                await sleep(5_000, signal);
                continue;
            }
            if (!startupDelayDone) {
                startupDelayDone = true;
                // Spread cameras out over the first two minutes.
                const spread = [...this.nativeId!].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 90;
                await sleep((30 + spread) * 1_000, signal);
            }
            if (!this.isTimeForNewSnapshot()) {
                await sleep(interval, signal);
                continue;
            }
            await this.snapshotLock.run(async () => {
                const sources: ['prebuffer' | 'arlo_cloud', string][] = [['arlo_cloud', 'Arlo Cloud']];
                if (!this.skipPrebufferOnFirstAutoSnapshot)
                    sources.unshift(['prebuffer', 'Prebuffer']);
                for (const [source, label] of sources) {
                    try {
                        await this.createSnapshotFromSource(source);
                        this.logger.debug(`Snapshot created successfully from ${label}`);
                        break;
                    }
                    catch (e) {
                        this.logSnapshotFailure(label, e);
                    }
                }
                this.skipPrebufferOnFirstAutoSnapshot = false;
            }, signal).catch(e => {
                if (signal.aborted)
                    throw e;
                this.logger.debug(`Auto snapshot loop error: ${e}`);
            });
            await sleep(interval, signal);
        }
    }

    async updateAutoSnapshot(): Promise<void> {
        this.removeEventSubscription('auto_snapshot');
        await this.taskManager.cancelAndAwaitByTag('auto_snapshot', this);
        this.startAutoSnapshot();
    }

    // Capabilities and settings.

    override getApplicableInterfaces(): string[] {
        const interfaces = new Set<string>([
            ScryptedInterface.VideoCamera,
            ScryptedInterface.Camera,
            ScryptedInterface.MotionSensor,
            ScryptedInterface.Settings,
            ScryptedInterface.ObjectDetector,
            ScryptedInterface.Brightness,
        ]);
        if (this.ledProperty)
            interfaces.add(ScryptedInterface.OnOff);
        if (this.hasSipWebrtcStreaming && !this.disableWebrtc)
            interfaces.add(ScryptedInterface.RTCSignalingChannel);
        if (this.hasPushToTalk)
            interfaces.add(ScryptedInterface.Intercom);
        if (this.hasBattery) {
            interfaces.add(ScryptedInterface.Battery);
            interfaces.add(ScryptedInterface.Charger);
        }
        // Scrypted loads child devices through their parent's getDevice.
        if (this.hasSiren || this.hasSpotlight || this.hasFloodlight || this.hasNightlight || this.hasPushToTalk)
            interfaces.add(ScryptedInterface.DeviceProvider);
        if (this.hasAudioSensor)
            interfaces.add(ScryptedInterface.AudioSensor);
        if (this.hasCloudRecording)
            interfaces.add(ScryptedInterface.VideoClips);
        return [...interfaces];
    }

    override getDeviceType(): string {
        return ScryptedDeviceType.Camera;
    }

    override getBuiltinChildDeviceManifests(): Device[] {
        const manifests: Device[] = [];
        if (this.hasSpotlight || this.hasFloodlight || this.hasNightlight) {
            const light = this.getLight()!;
            const kind = this.hasSpotlight ? 'Spotlight' : this.hasFloodlight ? 'Floodlight' : 'Nightlight';
            manifests.push(light.getDeviceManifest({
                name: `${this.arloDevice.deviceName} ${kind}`,
                interfaces: light.getApplicableInterfaces(),
                deviceType: light.getDeviceType(),
                providerNativeId: this.nativeId,
                nativeId: light.nativeId,
            }));
        }
        if (this.hasSiren) {
            const svss = this.getSvss();
            manifests.push(svss.getDeviceManifest({
                name: `${this.arloDevice.deviceName} Siren Virtual Security System`,
                interfaces: svss.getApplicableInterfaces(),
                deviceType: svss.getDeviceType(),
                providerNativeId: this.nativeId,
                nativeId: svss.nativeId,
            }), ...svss.getBuiltinChildDeviceManifests());
        }
        if (this.hasPushToTalk) {
            const intercom = this.getIntercom();
            manifests.push(intercom.getDeviceManifest({
                name: `${this.arloDevice.deviceName} Intercom`,
                interfaces: intercom.getApplicableInterfaces(),
                deviceType: intercom.getDeviceType(),
                providerNativeId: this.nativeId,
                nativeId: intercom.nativeId,
            }));
        }
        return manifests;
    }

    override async refreshDevice(): Promise<void> {
        try {
            this.arloProperties = await this.provider.getDeviceProperties(this.arloBasestation, this.arloDevice);
            for (const child of [this.light, this.svss, this.svss?.siren, this.intercom])
                if (child)
                    child.arloProperties = this.arloProperties;
            for (const manifest of [this.getDeviceManifest(), ...this.getBuiltinChildDeviceManifests()])
                await sdk.deviceManager.onDeviceDiscovered(manifest);
            this.logger.debug('Camera and children refreshed and updated in Scrypted.');
        }
        catch (e) {
            this.logger.error('Error refreshing camera:', e);
        }
    }

    get canRestart(): boolean {
        return this.arloDevice.deviceId === this.arloDevice.parentId && this.provider.arlo?.userId === this.arloDevice.owner?.ownerId;
    }

    // Wired indoor cameras have a status light instead, and still report a
    // charge notification LED setting that does nothing.
    get hasStatusLight(): boolean {
        return this.hasCapability('StatusLight') && this.hasProperty('idleLedEnable');
    }

    get hasChargeNotificationLed(): boolean {
        return !this.hasStatusLight && this.hasProperty('chargeNotificationLedEnable');
    }

    // The Arlo property behind the camera's OnOff.
    get ledProperty(): 'idleLedEnable' | 'chargeNotificationLedEnable' | undefined {
        if (this.hasStatusLight)
            return 'idleLedEnable';
        return this.hasChargeNotificationLed ? 'chargeNotificationLedEnable' : undefined;
    }

    get wiredToPower(): boolean {
        return this.registered && !!this.storageSettings.values.wired_to_power;
    }

    get ecoMode(): boolean {
        return this.registered && !!this.storageSettings.values.eco_mode;
    }

    get disableEagerStreams(): boolean {
        return this.registered && !!this.storageSettings.values.disable_eager_streams;
    }

    get disableWebrtc(): boolean {
        return this.registered && !!this.storageSettings.values.disable_webrtc;
    }

    get snapshotThrottleInterval(): number {
        return this.registered ? Number(this.storageSettings.values.snapshot_throttle_interval) || 0 : 60;
    }

    get hasCloudRecording(): boolean {
        return this.hasFeature('eventRecording');
    }

    get hasSpotlight(): boolean {
        return this.hasCapability('Spotlight');
    }

    get hasFloodlight(): boolean {
        return this.hasCapability('Floodlight');
    }

    get hasNightlight(): boolean {
        return this.hasCapability('Nightlight');
    }

    get hasSiren(): boolean {
        return this.hasCapability('Siren', 'ResourceTypes');
    }

    // The older Automation block names the trigger AudioDetectionTrigger;
    // Automation3.0 names it audioStart.
    get hasAudioSensor(): boolean {
        return this.hasCapability('AudioDetectionTrigger', 'Automation', 'AutomationTriggers')
            || this.hasCapability('AudioDetectionTrigger', 'Automation3.0', 'AutomationTriggers')
            || this.hasCapability('audioStart', 'Automation3.0', 'AutomationTriggers');
    }

    get hasBattery(): boolean {
        const powerSource = this.getCapability('PowerSource');
        const battery = powerSource?.Battery;
        const ac = powerSource?.AC;
        return !!battery && (battery.indicatorVisible ?? true) && (!ac || (ac.indicatorVisible ?? true));
    }

    get hasPushToTalk(): boolean {
        return this.hasCapability('fullDuplex', 'PushToTalk');
    }

    get usesSipPushToTalk(): boolean {
        return this.hasCapability('sip', 'PushToTalk', 'signal');
    }

    get hasSipWebrtcStreaming(): boolean {
        return this.hasCapability('SIPStreaming', 'Streaming');
    }

    get hasLocalLiveStreaming(): boolean {
        return this.hasCapability('LocalStreaming', 'Streaming')
            && this.arloDevice.deviceId !== this.arloBasestation.deviceId
            && this.provider.arlo?.userId === this.arloDevice.owner?.ownerId;
    }

    get localLiveStreamingCodec(): string {
        return (this.registered && this.storageSettings.values.local_live_streaming_codec) || 'h.264';
    }

    // The codec the cloud stream carries, from the camera's Video block: H.264
    // where it is listed, otherwise H.265. The CloudStreaming block's own codec
    // can be wrong (it says avc on cameras that stream HEVC).
    get cloudStreamingVideoCodec(): string {
        const codecs = this.localLiveStreamingCodecList.map(codec => String(codec).toLowerCase().replace('.', ''));
        if (codecs.includes('h264') || codecs.includes('avc'))
            return 'h264';
        if (codecs.includes('h265') || codecs.includes('hevc'))
            return 'h265';
        return 'h264';
    }

    get localLiveStreamingCodecList(): string[] {
        const video = this.arloCapabilities?.Capabilities?.Video ?? {};
        return Array.isArray(video) ? video.flatMap(entry => entry.Codecs ?? []) : video.Codecs ?? [];
    }

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'snapshot_throttle_interval' && !Number.isInteger(Number(value))) {
            this.logger.error(`Invalid snapshot throttle interval ${value} - must be an integer`);
            await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            return;
        }
        if (key === 'wired_to_power' || key === 'disable_webrtc') {
            await this.storageSettings.putSetting(key, value);
            if (key === 'wired_to_power')
                this.chargeState = this.wiredToPower ? ChargeState.Charging : ChargeState.NotCharging;
            await this.refreshDevice();
        }
        else if (key === 'snapshot_throttle_interval') {
            await this.storageSettings.putSetting(key, value);
            await this.updateAutoSnapshot();
        }
        else if (key === 'print_debug') {
            this.logger.debug(`Device Capabilities: ${JSON.stringify(this.arloCapabilities)}`);
            this.logger.debug(`Device Smart Features: ${JSON.stringify(this.arloSmartFeatures)}`);
            this.logger.debug(`Device Properties: ${JSON.stringify(this.arloProperties)}`);
            this.logger.debug(`Device State: ${this.deviceState}`);
            this.logger.debug(`Activity State: ${this.activityState}`);
        }
        else if (key === 'restart_device') {
            if (this.activityState === 'idle') {
                this.logger.debug('Restarting Device');
                await this.provider.arlo!.restartDevice(this.arloDevice.deviceId);
            }
            else {
                this.logger.warn('Device is not idle, cannot restart at this time.');
            }
        }
        else {
            await this.storageSettings.putSetting(key, value);
        }
        await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    // Gives an Arlo request 10 seconds, then cancels it, so the request layer
    // does not go on retrying a stream or snapshot nobody waits for.
    private async withRequestTimeout<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        try {
            return await withTimeout(request(controller.signal), TIMEOUT);
        }
        finally {
            controller.abort();
        }
    }

    // Waits up to 10 seconds for the camera to go idle, unless the named stream
    // is the one the prebuffer already keeps running.
    private async waitForStateChange(name?: string): Promise<void> {
        const start = Date.now();
        this.logger.debug('Checking activity state...');
        while (true) {
            let prebufferName: string | undefined;
            if (!this.skipPrebufferOnFirstAutoSnapshot) {
                const device: VideoCamera | undefined = sdk.systemManager.getDeviceById(this.id!) as any;
                const options = await device?.getVideoStreamOptions().catch(() => undefined);
                prebufferName = options?.find(option => 'prebuffer' in option)?.name;
            }
            if (this.activityState === 'idle' || (prebufferName && name === prebufferName)) {
                this.logger.debug('Activity State is idle or selected stream is currently active, continuing...');
                return;
            }
            if (Date.now() - start > TIMEOUT) {
                this.activityState = 'idle';
                throw new TimeoutError('Waiting for activity state to be idle timed out');
            }
            await sleep(500);
        }
    }

    // Snapshots.

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    // Takes the prebuffer's current frame, or else asks Arlo Cloud, which
    // within the throttle interval returns the last snapshot instead.
    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        this.logger.info('Requesting snapshot');
        const snapshot = await this.snapshotLock.run(async () => {
            for (const [source, label] of [['prebuffer', 'Prebuffer'], ['arlo_cloud', 'Arlo Cloud']] as const) {
                if (source === 'arlo_cloud' && !this.isTimeForNewSnapshot()) {
                    if (this.lastSnapshot) {
                        this.logger.debug('Returning cached snapshot within throttle interval');
                        return this.lastSnapshot;
                    }
                    this.logger.warn('No cached snapshot available within throttle interval');
                    continue;
                }
                try {
                    await this.createSnapshotFromSource(source);
                    this.logger.debug(`Snapshot created successfully from ${label}`);
                    return this.lastSnapshot;
                }
                catch (e) {
                    this.logSnapshotFailure(label, e);
                }
            }
            return undefined;
        });
        if (!snapshot) {
            this.logger.error('Failed to create or retrieve any snapshot');
            throw new Error('Failed to create or retrieve any snapshot');
        }
        return snapshot;
    }

    private logSnapshotFailure(label: string, e: unknown): void {
        if (e instanceof SourceUnavailable)
            this.logger.debug(`${label} snapshot skipped: ${e.message}`);
        else
            this.logger.error(`${label} snapshot failed: ${e}`);
    }

    // Cloud snapshots are throttled only in eco mode, as its settings say.
    private isTimeForNewSnapshot(): boolean {
        const interval = this.ecoMode ? this.snapshotThrottleInterval : 0;
        return interval === 0 || Date.now() - this.lastSnapshotTime >= interval * 60_000;
    }

    private async createSnapshotFromSource(source: 'prebuffer' | 'arlo_cloud'): Promise<void> {
        const buffer = source === 'prebuffer'
            ? await this.getBufferFromPrebuffer()
            : await this.getBufferFromUrl(await this.getSnapshotUrl());
        await this.createSnapshotFromBuffer(buffer);
    }

    private async getBufferFromPrebuffer(): Promise<Buffer> {
        this.logger.debug('Attempting to get Scrypted Device and Prebuffer ID');
        const device: VideoCamera | undefined = sdk.systemManager.getDeviceById(this.id!) as any;
        if (!device)
            throw new Error('Scrypted Device not found');
        const options = await device.getVideoStreamOptions();
        const prebufferId = options?.find(option => 'prebuffer' in option)?.id;
        if (!prebufferId)
            throw new SourceUnavailable('no prebuffer or running Rebroadcast stream');
        const media = await device.getVideoStream({ id: prebufferId, refresh: false });
        if (!media)
            throw new Error('No MediaObject received from Scrypted Prebuffer');
        const buffer = await sdk.mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
        if (!buffer?.length)
            throw new Error('Failed to convert MediaObject to buffer');
        return buffer;
    }

    private async getSnapshotUrl(): Promise<string> {
        this.logger.debug('Getting snapshot URL');
        try {
            await this.waitForStateChange();
            this.lastSnapshotUrl = await this.withRequestTimeout(signal => this.provider.arlo!.triggerFullFrameSnapshot(this.arloDevice, { timeout: TIMEOUT, signal }));
        }
        catch (e) {
            if (e instanceof TimeoutError)
                throw new Error('Timed out waiting for snapshot URL from Arlo Cloud');
            throw new Error(`Failed to get snapshot URL: ${e}`);
        }
        if (!this.lastSnapshotUrl)
            throw new Error('Snapshot URL is empty');
        return this.lastSnapshotUrl;
    }

    private async getBufferFromUrl(url: string): Promise<Buffer> {
        const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (response.status !== 200)
            throw new Error(`Unexpected status downloading snapshot image: ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length)
            throw new Error('Failed to get buffer from Arlo Cloud URL');
        return buffer;
    }

    private async createSnapshotFromBuffer(buffer: Buffer): Promise<void> {
        this.lastSnapshot = await sdk.mediaManager.createMediaObject(buffer, 'image/jpeg');
        this.lastSnapshotTime = Date.now();
    }

    // Streams.

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const audio = this.arloDevice.modelId === 'VMC3030' ? null : { codec: 'aac' };
        const cloud: ResponseMediaStreamOptions = {
            id: 'default',
            name: 'Cloud RTSP',
            container: 'rtsp',
            video: { codec: this.cloudStreamingVideoCodec },
            audio: audio as any,
            source: 'cloud',
            tool: 'scrypted',
            userConfigurable: false,
        };
        if (!this.hasLocalLiveStreaming)
            return [cloud];
        return [
            {
                ...cloud,
                id: 'default',
                name: 'Local RTSP',
                video: { codec: this.localLiveStreamingCodec === 'h.265' ? 'h265' : 'h264' },
            },
            { ...cloud, id: 'rtsp' },
        ];
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const all = await this.getVideoStreamOptions();
        const option = all.find(o => o.id === (options?.id ?? 'default')) ?? all[0];
        const mso: ResponseMediaStreamOptions = { ...option, refreshAt: Date.now() + 30 * 60_000 };
        const url = await this.getVideoStreamUrl(mso.name!);
        const input: FFmpegInput = {
            url,
            container: 'rtsp',
            mediaStreamOptions: mso,
            inputArguments: ['-f', 'rtsp', '-i', url],
        };
        return sdk.mediaManager.createFFmpegMediaObject(input);
    }

    private async getVideoStreamUrl(name: string): Promise<string> {
        await this.waitForStateChange(name);
        if (name === 'Local RTSP') {
            this.logger.info('Requesting local stream');
            const basestation = await this.provider.getDevice(this.arloBasestation.deviceId) as ArloBasestation | undefined;
            if (!basestation)
                throw new Error("This camera's basestation is missing or hidden, unable to use local stream.");
            if (this.arloDevice.deviceId === this.arloBasestation.deviceId)
                throw new Error('This camera is not connected to a basestation, unable to use local stream.');
            if (!basestation.ip)
                throw new Error("Must specify the basestation's IP address to use local stream.");
            if (!basestation.hostName)
                throw new Error("Must specify the basestation's Hostname to use local stream.");
            if (!basestation.peerCert)
                throw new Error('This basestation does not have a certificate, unable to use local stream.');
            const port = await new ArloLocalStreamProxy(this.provider.arloPrivateKey, basestation, this).start();
            const url = `rtsp://localhost:${port}/${this.nativeId}/tcp/${this.localLiveStreamingCodec === 'h.265' ? 'hevc' : 'avc'}`;
            this.logger.debug(`Got local stream URL at ${url}`);
            return url;
        }
        this.logger.info('Requesting rtsp stream');
        try {
            const stream = await this.withRequestTimeout(signal => this.provider.arlo!.startStream(this.arloDevice, !this.disableEagerStreams, { timeout: TIMEOUT, signal }));
            this.streamSipInfo = stream.sipInfo;
            this.logger.debug(`Got rtsp stream URL${stream.sipInfo ? ', with a SIP session for the intercom' : ''}`);
            return stream.url;
        }
        catch (e) {
            if (e instanceof TimeoutError) {
                this.logger.error('Timed out waiting for rtsp stream URL');
                throw new Error('Timed out waiting for rtsp stream URL');
            }
            throw e;
        }
    }

    // Talk, through the intercom child device.

    async startIntercom(media: MediaObject): Promise<void> {
        try {
            this.speaker ??= this.getIntercom().speaker();
            await this.speaker.startIntercom(media);
            this.intercomActive = true;
        }
        catch (e) {
            this.intercomActive = false;
            this.logger.error('Error in startIntercom:', e);
        }
    }

    async stopIntercom(): Promise<void> {
        try {
            if (!this.intercomActive) {
                this.logger.debug('Intercom is not active, nothing to stop.');
                return;
            }
            this.speaker ??= this.getIntercom().speaker();
            await this.speaker.stopIntercom();
        }
        catch (e) {
            this.logger.error('Error in stopIntercom:', e);
        }
        finally {
            this.intercomActive = false;
        }
    }

    // Video clips from Arlo Cloud recordings.

    private async findRecording(id: string, noCache = false): Promise<any> {
        const time = Number(id);
        const library = await this.provider.arlo!.getLibrary(this.arloDevice, new Date(time - 10_000), new Date(time + 10_000), noCache);
        return library.find(recording => recording.name === id);
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        this.logger.info(`Getting video clip ${videoId}`);
        const recording = await this.findRecording(videoId);
        if (!recording)
            throw new Error(`Clip ${videoId} not found`);
        return sdk.mediaManager.createMediaObjectFromUrl(recording.presignedContentUrl);
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        this.logger.info(`Getting video clips ${JSON.stringify(options)}`);
        const end = options?.endTime ?? Date.now();
        const start = options?.startTime ?? end - DAY;
        const library = await this.provider.arlo!.getLibrary(this.arloDevice, new Date(start), new Date(end));
        const clips: VideoClip[] = library.map(recording => ({
            duration: recording.mediaDurationSecond * 1000,
            id: recording.name,
            thumbnailId: recording.name,
            videoId: recording.name,
            startTime: recording.utcCreatedDate,
            description: recording.reason,
            resources: {
                thumbnail: { href: recording.presignedThumbnailUrl },
                video: { href: recording.presignedContentUrl },
            },
        }));
        // The SDK does not type reverseOrder, but Scrypted sends it.
        return (options as { reverseOrder?: boolean } | undefined)?.reverseOrder ? clips.reverse() : clips;
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        return this.clipThumbnail(thumbnailId, false);
    }

    private async clipThumbnail(thumbnailId: string, noCache: boolean): Promise<MediaObject> {
        this.logger.info(`Getting video clip thumbnail ${thumbnailId}`);
        const recording = await this.findRecording(thumbnailId, noCache);
        if (!recording)
            throw new Error(`Clip thumbnail ${thumbnailId} not found`);
        return sdk.mediaManager.createMediaObjectFromUrl(recording.presignedThumbnailUrl);
    }

    async removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error('Deleting Arlo video clips is not implemented by this plugin - please delete clips through the Arlo App.');
    }

    // Child devices.

    async getDevice(nativeId: string): Promise<any> {
        if ((nativeId.endsWith('spotlight') && this.hasSpotlight) || (nativeId.endsWith('floodlight') && this.hasFloodlight)
            || (nativeId.endsWith('nightlight') && this.hasNightlight))
            return this.getLight();
        if (nativeId.endsWith('svss') && this.hasSiren)
            return this.getSvss();
        if (nativeId.endsWith('intercom') && this.hasPushToTalk)
            return this.getIntercom();
        return undefined;
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
    }

    private getLight(): ArloBaseLight | undefined {
        if (!this.light) {
            const id = this.arloDevice.deviceId;
            if (this.hasSpotlight)
                this.light = new ArloSpotlight(`${id}.spotlight`, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this);
            else if (this.hasFloodlight)
                this.light = new ArloFloodlight(`${id}.floodlight`, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this);
            else if (this.hasNightlight)
                this.light = new ArloNightlight(`${id}.nightlight`, this.arloDevice, this.arloProperties, this.provider, this);
        }
        return this.light;
    }

    private getSvss(): ArloSirenVirtualSecuritySystem {
        this.svss ??= new ArloSirenVirtualSecuritySystem(`${this.arloDevice.deviceId}.svss`, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this);
        return this.svss;
    }

    private getIntercom(): ArloIntercom {
        this.intercom ??= new ArloIntercom(`${this.arloDevice.deviceId}.intercom`, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this);
        return this.intercom;
    }

    // Object detection, from Arlo's smart notifications.

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return this.clipThumbnail(detectionId, true);
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return { classes: ['person', 'vehicle', 'package', 'animal', 'car', 'truck', 'bus', 'motorbike', 'bicycle', 'dog', 'cat'] };
    }

    // Brightness, in Scrypted's 0 to 100 as Arlo's -2 to 2.

    async setBrightness(brightness: number): Promise<void> {
        this.logger.debug(`Brightness ${brightness}`);
        const level = Math.trunc(brightness);
        if (!(level in SCRYPTED_TO_ARLO_BRIGHTNESS))
            throw new Error('Valid brightness levels are 0, 25, 50, 75, 100');
        await this.provider.arlo!.setBrightness(this.arloBasestation, this.arloDevice, SCRYPTED_TO_ARLO_BRIGHTNESS[level]);
    }

    // Live video over SIP (WebRTC).

    async startRTCSignalingSession(scryptedSession: RTCSignalingSession): Promise<RTCSessionControl | undefined> {
        let session: ArloCameraWebRTCSignalingSession | undefined;
        try {
            await this.waitForStateChange('WebRTC');
            this.logger.debug('Starting RTC signaling session.');
            session = new ArloCameraWebRTCSignalingSession(this);
            this.rtcSessions.add(session);
            await session.delayedInit();
            session.scryptedSession = scryptedSession;
            const setup: RTCAVSignalingSetup = {
                type: 'offer',
                audio: { direction: 'sendrecv' },
                video: { direction: 'recvonly' },
                configuration: { iceServers: session.iceServers, iceCandidatePoolSize: 0 },
            };
            let offer: RTCSessionDescriptionInit;
            try {
                offer = await withTimeout(scryptedSession.createLocalDescription('offer', setup, undefined), 3_000);
            }
            catch (e) {
                if (!(e instanceof TimeoutError))
                    throw e;
                this.logger.warn('Timeout waiting for ICE candidates, falling back to ignore trickle.');
                offer = await scryptedSession.createLocalDescription('offer', setup, async () => { });
            }
            await session.setRemoteDescription(offer);
            const answer = await session.createLocalDescription();
            await scryptedSession.setRemoteDescription(answer, setup);
            this.logger.debug('RTC signaling session established successfully.');
            const established = session;
            return new ArloCameraWebRTCSessionControl(established, () => this.rtcSessions.delete(established));
        }
        catch (e) {
            if (session) {
                this.rtcSessions.delete(session);
                await session.close().catch(() => { });
            }
            this.logger.error('Failed to start RTC signaling session:', e);
            throw e;
        }
    }

    // The status light, or the charge notification LED.

    async turnOn(): Promise<void> {
        await this.setLed(true);
    }

    async turnOff(): Promise<void> {
        await this.setLed(false);
    }

    private async setLed(on: boolean): Promise<void> {
        const arlo = this.provider.arlo!;
        const statusLight = this.hasStatusLight;
        try {
            if (statusLight)
                await arlo.setStatusLight(this.arloBasestation, this.arloDevice, on);
            else
                await arlo.setChargeNotificationLed(this.arloBasestation, this.arloDevice, on);
        }
        catch (e) {
            this.logger.error(`Error turning ${statusLight ? 'status light' : 'charge notification LED'} ${on ? 'on' : 'off'}:`, e);
        }
    }
}
