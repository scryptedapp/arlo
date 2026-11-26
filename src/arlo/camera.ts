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
    PanTiltZoom,
    PanTiltZoomCommand,
    PanTiltZoomMovement,
    RequestMediaStreamOptions,
    RequestPictureOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
    RTCAVSignalingSetup,
    RTCSessionControl,
    RTCSignalingChannel,
    RTCSignalingOptions,
    RTCSignalingSession,
    ScryptedDeviceType,
    ScryptedInterface,
    ScryptedMimeTypes,
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
import { ArloPtzSwitch } from './ptz';
import { abortable, AsyncLock, sleep, TimeoutError, withTimeout } from './util';
import { ArloSirenVirtualSecuritySystem } from './vss';
import { ArloCameraWebRTCSessionControl, ArloCameraWebRTCSignalingSession } from './webrtc_sip';

const SCRYPTED_TO_ARLO_BRIGHTNESS: Record<number, number> = { 0: -2, 25: -1, 50: 0, 75: 1, 100: 2 };
const ARLO_TO_SCRYPTED_BRIGHTNESS: Record<number, number> = Object.fromEntries(
    Object.entries(SCRYPTED_TO_ARLO_BRIGHTNESS).map(([scrypted, arlo]) => [arlo, Number(scrypted)]));

class SourceUnavailable extends Error { }

async function isViewerSession(session: RTCSignalingSession): Promise<boolean> {
    const options: RTCSignalingOptions | undefined = typeof session.options === 'object'
        ? session.options
        : await session.getOptions().catch(() => undefined);
    return !!(options?.userAgent || options?.capabilities);
}

export class ArloCamera extends ArloDeviceBase implements AudioSensor, Battery, Brightness, Camera, Charger, DeviceProvider,
    MotionSensor, ObjectDetector, OnOff, PanTiltZoom, RTCSignalingChannel, Settings, VideoCamera, VideoClips, Intercom {
    intercom?: ArloIntercom;
    light?: ArloBaseLight;
    svss?: ArloSirenVirtualSecuritySystem;
    ptzSwitches = new Map<string, ArloPtzSwitch>();
    timeout = 10_000;
    private speaker?: Intercom;
    deviceState?: string;
    activityState?: string;
    private lastSnapshot?: MediaObject;
    private lastSnapshotTime = 0;
    private lastSnapshotUrl = '';
    private intercomActive = false;
    private ptzStopTimer?: NodeJS.Timeout;
    private skipPrebufferOnFirstAutoSnapshot = true;
    private snapshotLock = new AsyncLock();
    private rtcSessions = new Set<ArloCameraWebRTCSignalingSession>();
    streamSipInfo?: StreamSipInfo;
    private ownStream?: { kind: 'rtsp', id: string, confirmed: boolean, startedAt: number } | { kind: 'webrtc' };
    private connectionLock = new AsyncLock();

    storageSettings = new StorageSettings(this, {
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
            onGet: async () => ({ hide: !this.storageSettings.values.eco_mode }),
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
        ptz_presets: {
            multiple: true,
            hide: true,
            json: true,
            defaultValue: [],
        },
    });

    async close(): Promise<void> {
        for (const session of this.rtcSessions)
            await session.close().catch(() => { });
        this.rtcSessions.clear();
        await this.intercom?.close().catch(() => { });
        await this.light?.close().catch(() => { });
        await this.svss?.close().catch(() => { });
        for (const ptzSwitch of this.ptzSwitches.values())
            await ptzSwitch.close().catch(() => { });
        this.intercomActive = false;
        this.speaker = undefined;
        await super.close();
    }

    protected async delayedInit(signal: AbortSignal): Promise<void> {
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
                if (this.hasPanTiltZoom)
                    this.refreshPtzPresets(signal);
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
        this.createOrRegisterEventSubscription('error_subscription', () =>
            this.provider.arlo.subscribeToErrorEvents(this.arloDevice, (code, message) =>
                this.logger.error(`Arlo returned error code ${code} with message: ${message}`)));
        this.createOrRegisterEventSubscription('device_state_subscription', () =>
            this.provider.arlo.subscribeToDeviceStateEvents(this.arloDevice, state => this.deviceState = state));
        this.createOrRegisterEventSubscription('activity_state_subscription', () =>
            this.provider.arlo.subscribeToActivityStateEvents(this.arloDevice, state => this.applyActivityState(state)));
        this.createOrRegisterEventSubscription('snapshot_subscription', () =>
            this.provider.arlo.subscribeToSnapshotEvents(this.arloDevice, url =>
                this.taskManager.createTask(signal => abortable(this.getSnapshotFromEventUrl(url), signal),
                    { tag: `snapshot_event_update:${this.nativeId}`, owner: this })));
        this.createOrRegisterEventSubscription('motion_subscription', () =>
            this.provider.arlo.subscribeToMotionEvents(this.arloDevice, detected => this.motionDetected = detected, this.logger));
        if (this.hasAudioSensor)
            this.createOrRegisterEventSubscription('audio_subscription', () =>
                this.provider.arlo.subscribeToAudioEvents(this.arloDevice, detected => this.audioDetected = detected, this.logger));
        if (this.hasBattery)
            this.createOrRegisterEventSubscription('battery_subscription', () =>
                this.provider.arlo.subscribeToPropertyEvents(this.arloDevice, 'batteryLevel', level => this.batteryLevel = level));
        const ledProperty = this.ledProperty;
        if (ledProperty)
            this.createOrRegisterEventSubscription('led_subscription', () =>
                this.provider.arlo.subscribeToPropertyEvents(this.arloDevice, ledProperty, enabled => this.on = enabled));
        this.createOrRegisterEventSubscription('brightness_subscription', () =>
            this.provider.arlo.subscribeToPropertyEvents(this.arloDevice, 'brightness',
                brightness => this.brightness = ARLO_TO_SCRYPTED_BRIGHTNESS[brightness]));
        let lastSeen = 0;
        this.createOrRegisterEventSubscription('smart_motion_subscription', () =>
            this.provider.arlo.subscribeToSmartMotionEvents(this.arloDevice, event => {
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

    private shouldRunAutoSnapshot(): boolean {
        return this.provider.autoSnapshotGeneration && this.snapshotThrottleInterval > 0;
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
                const spread = [...this.nativeId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 90;
                await sleep((30 + spread) * 1_000, signal);
            }
            if (!this.isTimeForNewSnapshot()) {
                await sleep(interval, signal);
                continue;
            }
            await abortable(this.snapshotLock.run(async () => {
                await this.createSnapshot(!this.skipPrebufferOnFirstAutoSnapshot);
                this.skipPrebufferOnFirstAutoSnapshot = false;
            }, signal), signal).catch(e => {
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

    getApplicableInterfaces(): string[] {
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
        if (this.hasSiren || this.hasSpotlight || this.hasFloodlight || this.hasNightlight || this.hasPushToTalk || this.hasPanTiltZoom)
            interfaces.add(ScryptedInterface.DeviceProvider);
        if (this.hasAudioSensor)
            interfaces.add(ScryptedInterface.AudioSensor);
        if (this.hasCloudRecording)
            interfaces.add(ScryptedInterface.VideoClips);
        if (this.hasPanTiltZoom)
            interfaces.add(ScryptedInterface.PanTiltZoom);
        return [...interfaces];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.Camera;
    }

    async ptzCommand(command: PanTiltZoomCommand): Promise<void> {
        clearTimeout(this.ptzStopTimer);
        const movement = command.movement ?? (command.preset ? PanTiltZoomMovement.Preset : PanTiltZoomMovement.Relative);
        const pan = command.pan ?? 0;
        const tilt = command.tilt ?? 0;
        if (movement === PanTiltZoomMovement.Preset) {
            if (!command.preset) {
                this.logger.warn('A PTZ preset move needs a preset.');
                return;
            }
            await this.provider.arlo.ptzGotoPreset(this.arloBasestation, this.arloDevice, command.preset);
        }
        else if (movement === PanTiltZoomMovement.Home) {
            await this.provider.arlo.ptzGotoHomePosition(this.arloBasestation, this.arloDevice);
        }
        else if (movement === PanTiltZoomMovement.Absolute) {
            await this.provider.arlo.ptzAbsoluteMove(this.arloBasestation, this.arloDevice, pan, tilt);
        }
        else if (!pan && !tilt) {
            await this.provider.arlo.ptzStop(this.arloBasestation, this.arloDevice);
        }
        else if (movement === PanTiltZoomMovement.Continuous) {
            await this.provider.arlo.ptzContinuousMove(this.arloBasestation, this.arloDevice, pan * (command.speed?.pan ?? 1), tilt * (command.speed?.tilt ?? 1));
            if (command.timeout)
                this.ptzStopTimer = setTimeout(() => this.provider.arlo.ptzStop(this.arloBasestation, this.arloDevice)
                    .catch(e => this.logger.error(`Error stopping PTZ movement: ${e}`)), command.timeout);
        }
        else {
            await this.provider.arlo.ptzRelativeMove(this.arloBasestation, this.arloDevice, pan, tilt);
        }
    }

    getBuiltinChildDeviceManifests(): Device[] {
        const manifests: Device[] = [];
        if (this.hasSpotlight || this.hasFloodlight || this.hasNightlight) {
            const light = this.getLight();
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
        if (this.hasPanTiltZoom) {
            const id = this.arloDevice.deviceId;
            const labels: [string, string][] = [
                [`${id}.panleft`, 'Pan Left'],
                [`${id}.panright`, 'Pan Right'],
                ...(this.getCapability('tilt', 'PanTiltZoom') ? [[`${id}.tiltup`, 'Tilt Up'], [`${id}.tiltdown`, 'Tilt Down']] as [string, string][] : []),
                [`${id}.home`, 'Home Position'],
                ...this.ptzPresets.map(preset => [`${id}.preset.${preset.presetToken}`, `Preset ${preset.name}`] as [string, string]),
            ];
            for (const [nativeId, label] of labels) {
                const ptzSwitch = this.getPtzSwitch(nativeId);
                manifests.push(ptzSwitch.getDeviceManifest({
                    name: `${this.arloDevice.deviceName} ${label}`,
                    interfaces: ptzSwitch.getApplicableInterfaces(),
                    deviceType: ptzSwitch.getDeviceType(),
                    providerNativeId: this.nativeId,
                    nativeId: ptzSwitch.nativeId,
                }));
            }
        }
        return manifests;
    }

    async refreshDevice(): Promise<void> {
        try {
            this.arloProperties = await this.provider.getDeviceProperties(this.arloBasestation, this.arloDevice);
            if (this.hasPanTiltZoom)
                await this.refreshPtzPresets();
            for (const child of [this.light, this.svss, this.svss?.siren, this.intercom, ...this.ptzSwitches.values()])
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

    get hasStatusLight(): boolean {
        return this.hasCapability('StatusLight') && this.hasProperty('idleLedEnable');
    }

    get ledProperty(): 'idleLedEnable' | 'chargeNotificationLedEnable' | undefined {
        if (this.hasStatusLight)
            return 'idleLedEnable';
        return this.hasProperty('chargeNotificationLedEnable') ? 'chargeNotificationLedEnable' : undefined;
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

    get hasPanTiltZoom(): boolean {
        return !!this.getCapability('pan', 'PanTiltZoom');
    }

    get ptzPresets(): { presetToken: string, name: string }[] {
        return this.registered ? this.storageSettings.values.ptz_presets ?? [] : [];
    }

    get hasLocalLiveStreaming(): boolean {
        return this.hasCapability('LocalStreaming', 'Streaming')
            && this.arloDevice.deviceId !== this.arloBasestation.deviceId
            && this.provider.arlo?.userId === this.arloDevice.owner?.ownerId;
    }

    get localLiveStreamingCodec(): string {
        return (this.registered && this.storageSettings.values.local_live_streaming_codec) || 'h.264';
    }

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
                await this.provider.arlo.restartDevice(this.arloDevice.deviceId);
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

    private async withRequestTimeout<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        try {
            return await withTimeout(request(controller.signal), this.timeout);
        }
        finally {
            controller.abort();
        }
    }

    private get ownCloudStream(): boolean {
        const ownStream = this.ownStream;
        return ownStream?.kind === 'rtsp' && (ownStream.confirmed || Date.now() - ownStream.startedAt < 15_000);
    }

    private get busyReason(): string | undefined {
        if (this.ownStream?.kind === 'webrtc')
            return "this plugin's WebRTC stream";
        if (this.ownCloudStream)
            return "this plugin's cloud RTSP stream";
        const state = this.activityState;
        if (!state || state === 'idle' || state === 'unavailable')
            return undefined;
        return state;
    }

    get webrtcStreamActive(): boolean {
        return this.ownStream?.kind === 'webrtc';
    }

    private applyActivityState(state: string, fromProperties = false): void {
        this.activityState = state;
        const ownStream = this.ownStream;
        if (ownStream?.kind === 'rtsp' && (state === 'startUserStream' || state === 'userStreamActive'))
            ownStream.confirmed = true;
        if (state !== 'idle')
            return;
        if (ownStream?.kind === 'rtsp' && !ownStream.confirmed && !fromProperties) {
            this.logger.debug('Idle report from before the new stream started; keeping the new stream.');
            return;
        }
        if (this.streamSipInfo) {
            this.logger.debug('Stream ended; clearing its SIP session.');
            this.streamSipInfo = undefined;
        }
        if (this.ownStream?.kind === 'rtsp')
            this.ownStream = undefined;
    }

    private async waitForConnection(purpose: string): Promise<void> {
        if (!this.busyReason)
            return;
        this.logger.debug(`Camera is busy (${this.busyReason}); waiting to ${purpose}.`);
        const deadline = Date.now() + 7_000;
        while (this.busyReason && Date.now() < deadline)
            await sleep(250);
        if (this.busyReason && this.ownStream?.kind !== 'webrtc') {
            const properties = await this.provider.arlo.triggerProperties(this.arloBasestation, this.arloDevice, { timeout: 2_000 })
                .catch((): Record<string, any> => ({}));
            if (typeof properties.activityState === 'string')
                this.applyActivityState(properties.activityState, true);
        }
        if (this.busyReason) {
            const hint = this.ownStream?.kind === 'webrtc' || this.ownCloudStream
                ? ' Give all of this camera\'s Rebroadcast destinations the same stream.'
                : '';
            throw new Error(`The camera is busy (${this.busyReason}); Arlo serves one stream or snapshot at a time.${hint}`);
        }
        this.logger.debug(`Camera is free; continuing to ${purpose}.`);
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        this.logger.info('Requesting snapshot');
        const snapshot = await this.snapshotLock.run(() => this.createSnapshot(true));
        if (!snapshot) {
            this.logger.error('Failed to create or retrieve any snapshot');
            throw new Error('Failed to create or retrieve any snapshot');
        }
        return snapshot;
    }

    private async createSnapshot(usePrebuffer: boolean): Promise<MediaObject | undefined> {
        if (usePrebuffer && await this.trySnapshotSource('prebuffer', 'Prebuffer'))
            return this.lastSnapshot;
        if (this.busyReason) {
            this.logger.debug(`Camera is busy (${this.busyReason}); returning the last snapshot.`);
            return this.lastSnapshot;
        }
        if (!this.isTimeForNewSnapshot()) {
            if (this.lastSnapshot)
                this.logger.debug('Returning cached snapshot within throttle interval');
            else
                this.logger.warn('No cached snapshot available within throttle interval');
            return this.lastSnapshot;
        }
        await this.trySnapshotSource('arlo_cloud', 'Arlo Cloud');
        return this.lastSnapshot;
    }

    private async trySnapshotSource(source: 'prebuffer' | 'arlo_cloud', label: string): Promise<boolean> {
        try {
            await this.createSnapshotFromSource(source);
            this.logger.debug(`Snapshot created successfully from ${label}`);
            return true;
        }
        catch (e) {
            if (e instanceof SourceUnavailable)
                this.logger.debug(`${label} snapshot skipped: ${e.message}`);
            else
                this.logger.error(`${label} snapshot failed: ${e}`);
            return false;
        }
    }

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
        const device = sdk.systemManager.getDeviceById<VideoCamera>(this.id);
        if (!device)
            throw new Error('Scrypted Device not found');
        const msos = await device.getVideoStreamOptions();
        const prebufferId = msos?.find(mso => 'prebuffer' in mso)?.id;
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
            this.lastSnapshotUrl = await this.connectionLock.run(async () => {
                if (this.busyReason)
                    throw new SourceUnavailable(`the camera is busy (${this.busyReason})`);
                return this.withRequestTimeout(signal =>
                    this.provider.arlo.triggerFullFrameSnapshot(this.arloDevice, { timeout: this.timeout, signal }));
            });
        }
        catch (e) {
            if (e instanceof SourceUnavailable)
                throw e;
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

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const audio = this.arloDevice.modelId === 'VMC3030' ? null : { codec: 'aac' };
        const cloud: ResponseMediaStreamOptions = {
            id: 'default',
            name: 'Cloud RTSP',
            container: 'rtsp',
            video: { codec: this.cloudStreamingVideoCodec },
            audio,
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
        const msos = await this.getVideoStreamOptions();
        const option = msos.find(mso => mso.id === (options?.id ?? 'default')) ?? msos[0];
        const mso: ResponseMediaStreamOptions = { ...option, refreshAt: Date.now() + 30 * 60_000 };
        const refreshing = !!(options as ResponseMediaStreamOptions | undefined)?.refreshAt;
        const url = await this.getVideoStreamUrl(option, refreshing);
        const input: FFmpegInput = {
            url,
            container: 'rtsp',
            mediaStreamOptions: mso,
            inputArguments: ['-f', 'rtsp', '-i', url],
        };
        return sdk.mediaManager.createFFmpegMediaObject(input);
    }

    private getVideoStreamUrl(option: ResponseMediaStreamOptions, refreshing: boolean): Promise<string> {
        return this.connectionLock.run(async () => {
            const previous = this.ownStream;
            const running = previous?.kind === 'rtsp' && previous.confirmed && previous.id === option.id && this.activityState !== 'idle';
            if (previous?.kind === 'rtsp' && !this.ownCloudStream)
                this.ownStream = undefined;
            let reuse = running && refreshing;
            if (running && !refreshing) {
                this.logger.debug('Waiting for the previous cloud stream to end.');
                const deadline = Date.now() + this.timeout;
                while (this.ownStream === previous && Date.now() < deadline)
                    await sleep(250);
                reuse = this.ownStream === previous;
            }
            if (!reuse)
                await this.waitForConnection('start a stream');
            if (option.name === 'Local RTSP') {
                this.logger.info('Requesting local stream');
                const basestation = this.provider.scryptedDevices.get(this.arloBasestation.deviceId) as ArloBasestation | undefined;
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
                const port = await new ArloLocalStreamProxy(this.provider, basestation, this).start();
                const url = `rtsp://localhost:${port}/${this.nativeId}/tcp/${this.localLiveStreamingCodec === 'h.265' ? 'hevc' : 'avc'}`;
                this.logger.debug(`Got local stream URL at ${url}`);
                return url;
            }
            this.logger.info('Requesting rtsp stream');
            if (!reuse)
                this.ownStream = { kind: 'rtsp', id: option.id, confirmed: false, startedAt: Date.now() };
            try {
                const stream = await this.withRequestTimeout(signal =>
                    this.provider.arlo.startStream(this.arloDevice, !this.disableEagerStreams, { timeout: this.timeout, signal }));
                this.streamSipInfo = stream.sipInfo;
                this.logger.debug(`Got rtsp stream URL${stream.sipInfo ? ', with a SIP session for the intercom' : ''}`);
                return stream.url;
            }
            catch (e) {
                if (!reuse && this.ownStream?.kind === 'rtsp' && !this.ownStream.confirmed)
                    this.ownStream = undefined;
                if (e instanceof TimeoutError) {
                    this.logger.error('Timed out waiting for rtsp stream URL');
                    throw new Error('Timed out waiting for rtsp stream URL');
                }
                throw e;
            }
        });
    }

    async startIntercom(media: MediaObject): Promise<void> {
        try {
            this.speaker ??= this.getIntercom().speaker();
            await this.speaker.startIntercom(media);
            this.intercomActive = true;
        }
        catch (e) {
            this.intercomActive = false;
            this.logger.error(`Talk failed: ${e?.message ?? e}`);
            this.logger.debug('Error in startIntercom:', e);
            throw e;
        }
    }

    async stopIntercom(): Promise<void> {
        if (!this.intercomActive) {
            this.logger.debug('Intercom is not active, nothing to stop.');
            return;
        }
        this.intercomActive = false;
        try {
            this.speaker ??= this.getIntercom().speaker();
            await this.speaker.stopIntercom().catch(e =>
                this.logger.debug(`Scrypted's WebRTC plugin did not stop the talk: ${e?.message ?? e}`));
            await this.getIntercom().endTalk();
            this.logger.info('Talk stopped.');
        }
        catch (e) {
            this.logger.error('Error in stopIntercom:', e);
        }
    }

    private async findRecording(id: string, noCache = false): Promise<any> {
        const time = Number(id);
        const library = await this.provider.arlo.getLibrary(this.arloDevice, new Date(time - 10_000), new Date(time + 10_000), noCache);
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
        const start = options?.startTime ?? end - 86_400_000;
        const library = await this.provider.arlo.getLibrary(this.arloDevice, new Date(start), new Date(end));
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

    async getDevice(nativeId: string): Promise<ArloDeviceBase | undefined> {
        if ((nativeId.endsWith('spotlight') && this.hasSpotlight) || (nativeId.endsWith('floodlight') && this.hasFloodlight)
            || (nativeId.endsWith('nightlight') && this.hasNightlight))
            return this.getLight();
        if (nativeId.endsWith('svss') && this.hasSiren)
            return this.getSvss();
        if (nativeId.endsWith('intercom') && this.hasPushToTalk)
            return this.getIntercom();
        if (this.hasPanTiltZoom)
            return this.getPtzSwitch(nativeId);
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

    private getPtzSwitch(nativeId: string): ArloPtzSwitch | undefined {
        const kind = nativeId.slice(this.arloDevice.deviceId.length + 1);
        const command: PanTiltZoomCommand | undefined = kind === 'panleft' ? { pan: -0.05 }
            : kind === 'panright' ? { pan: 0.05 }
            : kind === 'tiltup' ? { tilt: 0.05 }
            : kind === 'tiltdown' ? { tilt: -0.05 }
            : kind === 'home' ? { movement: PanTiltZoomMovement.Home }
            : kind.startsWith('preset.') ? { movement: PanTiltZoomMovement.Preset, preset: kind.slice('preset.'.length) }
            : undefined;
        if (!command)
            return undefined;
        if (!this.ptzSwitches.has(nativeId))
            this.ptzSwitches.set(nativeId, new ArloPtzSwitch(nativeId, this.arloDevice, this.arloBasestation, this.arloProperties, this.provider, this, command));
        return this.ptzSwitches.get(nativeId);
    }

    private async refreshPtzPresets(signal?: AbortSignal): Promise<void> {
        for (let attempt = 0; attempt < 100 && !this.registered; attempt++)
            await sleep(100, signal);
        const previous = JSON.stringify(this.ptzPresets);
        try {
            const presets = await this.provider.arlo.getPtzPresets(this.arloBasestation, this.arloDevice, { timeout: this.timeout, signal });
            this.storageSettings.values.ptz_presets = presets.filter(preset => preset?.presetToken)
                .map(preset => ({ presetToken: String(preset.presetToken), name: String(preset.name || preset.presetToken) }));
        }
        catch (e) {
            this.logger.debug(`Could not read the PTZ presets: ${e}`);
        }
        try {
            this.ptzCapabilities = {
                pan: true,
                tilt: !!this.getCapability('tilt', 'PanTiltZoom'),
                zoom: false,
                presets: Object.fromEntries(this.ptzPresets.map(preset => [preset.presetToken, preset.name])),
            };
            if (JSON.stringify(this.ptzPresets) !== previous) {
                while (this.provider.setupInProgress)
                    await sleep(1_000, signal);
                await sdk.deviceManager.onDevicesChanged({
                    providerNativeId: this.nativeId,
                    devices: this.getBuiltinChildDeviceManifests().filter(manifest => manifest.providerNativeId === this.nativeId),
                });
            }
        }
        catch (e) {
            this.logger.debug(`Could not update the PTZ presets: ${e}`);
        }
    }

    async getDetectionInput(detectionId: string, eventId?: any): Promise<MediaObject> {
        return this.clipThumbnail(detectionId, true);
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return { classes: ['person', 'vehicle', 'package', 'animal', 'car', 'truck', 'bus', 'motorbike', 'bicycle', 'dog', 'cat'] };
    }

    async setBrightness(brightness: number): Promise<void> {
        this.logger.debug(`Brightness ${brightness}`);
        const level = Math.trunc(brightness);
        if (!(level in SCRYPTED_TO_ARLO_BRIGHTNESS))
            throw new Error('Valid brightness levels are 0, 25, 50, 75, 100');
        await this.provider.arlo.setBrightness(this.arloBasestation, this.arloDevice, SCRYPTED_TO_ARLO_BRIGHTNESS[level]);
    }

    async startRTCSignalingSession(scryptedSession: RTCSignalingSession): Promise<RTCSessionControl | undefined> {
        if (await isViewerSession(scryptedSession))
            return this.startViewerSession(scryptedSession);
        return this.connectionLock.run(async () => {
            const session = new ArloCameraWebRTCSignalingSession(this);
            try {
                await this.waitForConnection('start a WebRTC session');
                this.logger.debug('Starting RTC signaling session.');
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
                this.ownStream = { kind: 'webrtc' };
                const onEnd = () => {
                    this.rtcSessions.delete(session);
                    if (this.ownStream?.kind === 'webrtc' && !this.rtcSessions.size)
                        this.ownStream = undefined;
                };
                session.onEnded = reason => {
                    this.logger.debug(`The camera ended its WebRTC call: ${reason}.`);
                    if (session.arloSip?.talking)
                        this.logger.info(`Talk ended: ${reason}.`);
                    onEnd();
                };
                return new ArloCameraWebRTCSessionControl(session, onEnd);
            }
            catch (e) {
                this.rtcSessions.delete(session);
                await session.close().catch(() => { });
                this.logger.error('Failed to start RTC signaling session:', e);
                throw e;
            }
        });
    }

    private async startViewerSession(scryptedSession: RTCSignalingSession): Promise<RTCSessionControl | undefined> {
        this.logger.debug('Serving a WebRTC viewer from Rebroadcast.');
        const device = sdk.systemManager.getDeviceById<VideoCamera>(this.id);
        if (!device)
            throw new Error('Scrypted Device not found');
        const media = await device.getVideoStream({ destination: 'local' });
        const channel = await sdk.mediaManager.convertMediaObject<RTCSignalingChannel>(media, ScryptedMimeTypes.RTCSignalingChannel);
        return channel.startRTCSignalingSession(scryptedSession);
    }

    async turnOn(): Promise<void> {
        await this.setLed(true);
    }

    async turnOff(): Promise<void> {
        await this.setLed(false);
    }

    private async setLed(on: boolean): Promise<void> {
        const arlo = this.provider.arlo;
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
