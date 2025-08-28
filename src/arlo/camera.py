from __future__ import annotations

import aiohttp
import asyncio
import json
import time

from datetime import datetime, timedelta
from typing import TYPE_CHECKING

import scrypted_sdk
from scrypted_sdk.types import (
    AudioSensor,
    Battery,
    Brightness,
    Camera,
    ChargeState,
    Charger,
    Device,
    DeviceProvider,
    Intercom,
    MediaObject,
    MotionSensor,
    ObjectDetectionTypes,
    ObjectDetector,
    OnOff,
    RequestMediaStreamOptions,
    ResponseMediaStreamOptions,
    ResponsePictureOptions,
    ScryptedDeviceType,
    ScryptedInterface,
    Setting,
    SettingValue,
    Settings,
    VideoCamera,
    VideoClip,
    VideoClipOptions,
    VideoClips,
)

from .base import ArloDeviceBase
from .intercom import ArloIntercom
from .light import ArloBaseLight, ArloSpotlight, ArloFloodlight, ArloNightlight
from .local_stream import ArloLocalStreamProxy
from .vss import ArloSirenVirtualSecuritySystem
from .webrtc_sip import (
    ArloCameraWebRTCSignalingSession,
    ArloCameraWebRTCSessionControl,
    RTCSignalingSession,
)

if TYPE_CHECKING:
    from .provider import ArloProvider
    from .basestation import ArloBasestation

class ArloCamera(ArloDeviceBase, Settings, Camera, VideoCamera, Brightness, ObjectDetector, DeviceProvider, VideoClips, MotionSensor, AudioSensor, Battery, Charger, OnOff):
    SCRYPTED_TO_ARLO_BRIGHTNESS_MAP = {
        0: -2,
        25: -1,
        50: 0,
        75: 1,
        100: 2
    }
    ARLO_TO_SCRYPTED_BRIGHTNESS_MAP = {v: k for k, v in SCRYPTED_TO_ARLO_BRIGHTNESS_MAP.items()}
    timeout: int = 15
    intercom: ArloIntercom = None
    light: ArloBaseLight = None
    speaker: Intercom = None
    svss: ArloSirenVirtualSecuritySystem = None
    device_state: str = None
    activity_state: str = None
    snapshot_lock: asyncio.Lock = None
    last_snapshot: MediaObject = None
    last_snapshot_time: datetime = datetime(1970, 1, 1)
    intercom_active: bool = False

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider)
        self.snapshot_lock = asyncio.Lock()

    async def _delayed_init(self) -> None:
        await super()._delayed_init()
        self._start_error_subscription()
        self._start_device_state_subscription()
        self._start_activity_state_subscription()
        self._start_motion_subscription()
        self._start_audio_subscription()
        self._start_battery_subscription()
        self._start_charge_notification_led_subscription()
        self._start_brightness_subscription()
        self._start_smart_motion_subscription()
        for _ in range(100):
            if self.stop_subscriptions:
                return
            try:
                if not self.arlo_properties:
                    self.create_task(self.refresh_device())
                if self.has_battery:
                    self.batteryLevel = self.arlo_properties.get('batteryLevel', 0)
                    self.chargeState = ChargeState.Charging.value if self.wired_to_power else ChargeState.NotCharging.value
                if self.has_charge_notification_led:
                    self.on = self.arlo_properties.get('chargeNotificationLedEnable', False)
                self.device_state = self.arlo_properties.get('connectionState', 'unavailable')
                self.activity_state = self.arlo_properties.get('activityState', 'unavailable')
                self.brightness = ArloCamera.ARLO_TO_SCRYPTED_BRIGHTNESS_MAP[self.arlo_properties.get('brightness', 0)]
                return
            except Exception as e:
                self.logger.debug(f'Delayed init failed for ArloCamera: {self.nativeId}, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error(f'Delayed init exceeded iteration limit for ArloCamera: {self.nativeId}, giving up.')
            return

    def _start_error_subscription(self) -> None:
        def callback(code, message):
            self.logger.error(f'Arlo returned error code {code} with message: {message}')
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_error_events,
            self.arlo_device, callback,
            event_key='error_subscription'
        )

    def _start_device_state_subscription(self) -> None:
        def callback(device_state: str):
            self.device_state = device_state
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_device_state_events,
            self.arlo_device, callback,
            event_key='device_state_subscription'
        )

    def _start_activity_state_subscription(self) -> None:
        def callback(activity_state: str):
            self.activity_state = activity_state
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_activity_state_events,
            self.arlo_device, callback,
            event_key='activity_state_subscription'
        )

    def _start_motion_subscription(self) -> None:
        def callback(motion_detected: bool):
            self.motionDetected = motion_detected
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_motion_events,
            self.arlo_device, callback, self.logger,
            event_key='motion_subscription'
        )

    def _start_audio_subscription(self) -> None:
        if not self.has_audio_sensor:
            return

        def callback(audio_detected: bool):
            self.audioDetected = audio_detected
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_audio_events,
            self.arlo_device, callback, self.logger,
            event_key='audio_subscription'
        )

    def _start_battery_subscription(self) -> None:
        if not self.has_battery:
            return

        def callback(battery_level: float):
            self.batteryLevel = battery_level
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_battery_events,
            self.arlo_device, callback,
            event_key='battery_subscription'
        )

    def _start_charge_notification_led_subscription(self) -> None:
        if not self.has_charge_notification_led:
            return

        def callback(charge_notification_led_enable: bool):
            self.on = charge_notification_led_enable
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_charge_notification_led_events,
            self.arlo_device, callback,
            event_key='charge_notification_led_subscription'
        )

    def _start_brightness_subscription(self) -> None:
        def callback(brightness: int):
            self.brightness = ArloCamera.ARLO_TO_SCRYPTED_BRIGHTNESS_MAP[brightness]
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_brightness_events,
            self.arlo_device, callback,
            event_key='brightness_subscription'
        )

    def _start_smart_motion_subscription(self) -> None:
        last_seen_timestamp = 0

        def callback(event: dict):
            nonlocal last_seen_timestamp
            timestamp = event.get('utcCreatedDate', 0)
            if timestamp <= last_seen_timestamp:
                return self.stop_subscriptions
            last_seen_timestamp = timestamp
            categories: list[str] = event.get('objCategory', [])
            detection = {
                'detectionId': f'{timestamp}',
                'timestamp': timestamp,
                'detections': [
                    {'className': cat.lower()}
                    for cat in categories
                ]
            }
            self.create_task(self.onDeviceEvent(ScryptedInterface.ObjectDetector.value, detection))
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_smart_motion_events,
            self.arlo_device, callback,
            event_key='smart_motion_subscription'
        )

    def get_applicable_interfaces(self) -> list[str]:
        results = set([
            ScryptedInterface.VideoCamera.value,
            ScryptedInterface.Camera.value,
            ScryptedInterface.MotionSensor.value,
            ScryptedInterface.Settings.value,
            ScryptedInterface.ObjectDetector.value,
            ScryptedInterface.Brightness.value,
        ])
        if self.has_charge_notification_led:
            results.add(ScryptedInterface.OnOff.value)
        if self.has_sip_webrtc_streaming and not self.disable_webrtc:
            results.add(ScryptedInterface.RTCSignalingChannel.value)
        if self.has_push_to_talk:
            results.add(ScryptedInterface.Intercom.value)
        if self.has_battery:
            results.add(ScryptedInterface.Battery.value)
            results.add(ScryptedInterface.Charger.value)
        if self.has_siren or self.has_spotlight or self.has_floodlight:
            results.add(ScryptedInterface.DeviceProvider.value)
        if self.has_audio_sensor:
            results.add(ScryptedInterface.AudioSensor.value)
        if self.has_cloud_recording:
            results.add(ScryptedInterface.VideoClips.value)
        return list(results)

    def get_device_type(self) -> str:
        return ScryptedDeviceType.Camera.value

    def get_builtin_child_device_manifests(self) -> list[Device]:
        results = []
        if self.has_spotlight or self.has_floodlight or self.has_nightlight:
            if not self.light:
                self._create_light()
            light_name = f'{self.arlo_device["deviceName"]} ' + (
                'Spotlight' if self.has_spotlight else
                'Floodlight' if self.has_floodlight else
                'Nightlight'
            )
            results.append(self.light.get_device_manifest(
                name=light_name,
                interfaces=self.light.get_applicable_interfaces(),
                device_type=self.light.get_device_type(),
                provider_native_id=self.nativeId,
                native_id=self.light.nativeId,
            ))
        if self.has_siren:
            if not self.svss:
                self._create_svss()
            results.append(self.svss.get_device_manifest(
                name=f'{self.arlo_device["deviceName"]} Siren Virtual Security System',
                interfaces=self.svss.get_applicable_interfaces(),
                device_type=self.svss.get_device_type(),
                provider_native_id=self.nativeId,
                native_id=self.svss.nativeId,
            ))
            results.extend(self.svss.get_builtin_child_device_manifests())
        if self.has_push_to_talk:
            if not self.intercom:
                self._create_intercom()
            results.append(self.intercom.get_device_manifest(
                name=f'{self.arlo_device["deviceName"]} Intercom',
                interfaces=self.intercom.get_applicable_interfaces(),
                device_type=self.intercom.get_device_type(),
                provider_native_id=self.nativeId,
                native_id=self.intercom.nativeId,
            ))
        return results

    async def refresh_device(self):
        try:
            try:
                self.arlo_properties = await self.provider._get_device_properties(self.arlo_basestation, self.arlo_device)
                if self.light:
                    self.light.arlo_properties = self.arlo_properties
                if self.svss:
                    self.svss.arlo_properties = self.arlo_properties
                    if hasattr(self.svss, 'siren') and self.svss.siren:
                        self.svss.siren.arlo_properties = self.arlo_properties
                if self.intercom:
                    self.intercom.arlo_properties = self.arlo_properties
                manifests = [self.get_device_manifest()]
                manifests.extend(self.get_builtin_child_device_manifests())
                for manifest in manifests:
                    await scrypted_sdk.deviceManager.onDeviceDiscovered(manifest)
                await self.onDeviceEvent(ScryptedInterface.VideoCamera.value, None)
                self.logger.debug(f'Camera {self.nativeId} and children refreshed and updated in Scrypted.')
            except Exception as e:
                self.logger.error(f'Error refreshing device {self.nativeId}: {e}', exc_info=True)
        except asyncio.CancelledError:
            pass

    @property
    def can_restart(self) -> bool:
        return self.arlo_device['deviceId'] == self.arlo_device['parentId'] and self.provider.arlo.user_id == self.arlo_device['owner']['ownerId']

    @property
    def has_charge_notification_led(self) -> bool:
        return self._has_property('chargeNotificationLedEnable')

    @property
    def wired_to_power(self) -> bool:
        if self.storage:
            return bool(self.storage.getItem('wired_to_power'))
        return False

    @property
    def eco_mode(self) -> bool:
        if self.storage:
            return bool(self.storage.getItem('eco_mode'))
        return False

    @property
    def disable_eager_streams(self) -> bool:
        if self.storage:
            return bool(self.storage.getItem('disable_eager_streams'))
        return False

    @property
    def disable_webrtc(self) -> bool:
        if self.storage:
            return bool(self.storage.getItem('disable_webrtc'))
        return False

    @property
    def snapshot_throttle_interval(self) -> int:
        interval = self.storage.getItem('snapshot_throttle_interval')
        if interval is None:
            interval = 60
            self.storage.setItem('snapshot_throttle_interval', interval)
        return int(interval)

    @property
    def has_cloud_recording(self) -> bool:
        return self._has_feature('eventRecording')

    @property
    def has_spotlight(self) -> bool:
        return self._has_capability('Spotlight')

    @property
    def has_floodlight(self) -> bool:
        return self._has_capability('Floodlight')

    @property
    def has_nightlight(self) -> bool:
        return self._has_capability('Nightlight')

    @property
    def has_siren(self) -> bool:
        return self._has_capability('Siren', 'ResourceTypes')

    @property
    def has_audio_sensor(self) -> bool:
        return self._has_capability('AudioDetectionTrigger', 'Automation', 'AutomationTriggers') or self._has_capability('AudioDetectionTrigger', 'Automation3.0', 'AutomationTriggers')

    @property
    def has_battery(self) -> bool:
        ps: dict = self._get_capability('PowerSource')
        battery: dict = ps.get('Battery')
        ac: dict = ps.get('AC')
        return bool(
            battery and
            battery.get('indicatorVisible', True) and
            (not ac or ac.get('indicatorVisible', True))
        )

    @property
    def has_push_to_talk(self) -> bool:
        return self._has_capability('fullDuplex', 'PushToTalk')

    @property
    def uses_sip_push_to_talk(self) -> bool:
        return self._has_capability('sip', 'PushToTalk', 'signal')

    @property
    def has_sip_webrtc_streaming(self) -> bool:
        return self._has_capability('SIPStreaming', 'Streaming')

    @property
    def has_local_live_streaming(self) -> bool:
        return self._has_capability('LocalStreaming', 'Streaming') and self.arlo_device['deviceId'] != self.arlo_basestation['deviceId'] and self.provider.arlo.user_id == self.arlo_device['owner']['ownerId']

    @property
    def local_live_streaming_codec(self) -> str:
        codec: str = self.storage.getItem('local_live_streaming_codec')
        if codec is None or codec == '':
            codec = 'h.264'
            self.storage.setItem('local_live_streaming_codec', codec)
        return codec

    @property
    def local_live_streaming_codec_list(self) -> list[str]:
        capabilities: dict = self.arlo_capabilities.get('Capabilities', {})
        video: list[dict] | dict = capabilities.get('Video', {})
        if isinstance(video, list):
            return sum([v.get('Codecs', []) for v in video], [])
        return video.get('Codecs', [])

    async def getSettings(self) -> list[Setting]:
        result = []
        if self.has_battery:
            result.append({
                'group': 'General',
                'key': 'wired_to_power',
                'title': 'Plugged In to External Power',
                'value': self.wired_to_power,
                'description': (
                    'Informs Scrypted that this device is plugged in to an external power source. '
                    'Will allow features like persistent prebuffer to work. '
                    'Note that a persistent prebuffer may cause excess battery drain if the external power is not able to charge faster than the battery consumption rate.'
                ),
                'type': 'boolean',
            })
        result.append({
            'group': 'General',
            'key': 'eco_mode',
            'title': 'Eco Mode',
            'value': self.eco_mode,
            'description': (
                'Configures Scrypted to limit the number of requests made to this camera. '
                'Additional eco mode settings will appear when this is turned on.'
            ),
            'type': 'boolean',
        })
        result.append({
            'group': 'General',
            'key': 'disable_eager_streams',
            'title': 'Disable Eager Streams for RTSP/DASH',
            'value': self.disable_eager_streams,
            'description': (
                'If eager streams are disabled, Scrypted will wait for Arlo Cloud to report that '
                'the RTSP or DASH camera stream has started before passing the stream URL to '
                'downstream consumers.'
            ),
            'type': 'boolean',
        })
        if self.has_sip_webrtc_streaming:
            result.append({
                'group': 'General',
                'key': 'disable_webrtc',
                'title': 'Disable WebRTC',
                'value': self.disable_webrtc,
                'description': (
                    'Disables WebRTC streaming for this camera. '
                    'This will prevent the camera from being used in the Scrypted WebRTC UI, but will still allow RTSP/DASH streaming.'
                ),
                'type': 'boolean',
            })
        if self.has_local_live_streaming:
            result.append(
                {
                    'group': 'General',
                    'key': 'local_live_streaming_codec',
                    'title': 'Local Live Streaming Codec',
                    'description': 'Select the codec to pull the Local Live Stream from the basestation.',
                    'value': self.local_live_streaming_codec,
                    'multiple': False,
                    'choices': self.local_live_streaming_codec_list,
                }
            )
        if self.eco_mode:
            result.append({
                'group': 'Eco Mode',
                'key': 'snapshot_throttle_interval',
                'title': 'Snapshot Throttle Interval',
                'value': self.snapshot_throttle_interval,
                'description': (
                    'Time, in minutes, to throttle snapshot requests. '
                    'When eco mode is on, snapshot requests to the camera will be throttled for the given duration. '
                    'Cached snapshots may be returned if the time since the last snapshot has not exceeded the interval. '
                    'A value of 0 will disable throttling even when eco mode is on.'
                ),
                'type': 'number',
            })
        result.append({
            'group': 'General',
            'key': 'print_debug',
            'title': 'Debug Info',
            'description': 'Prints information about this device to console.',
            'type': 'button',
        })
        if self.can_restart:
            result.append(
                {
                    'group': 'General',
                    'key': 'restart_device',
                    'title': 'Restart Device',
                    'description': 'Restarts the Device.',
                    'type': 'button',
                },
            )
        return result

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if not self._validate_setting(key, value):
            await self.onDeviceEvent(ScryptedInterface.Settings.value, None)
            return
        if key in ['wired_to_power', 'disable_webrtc']:
            self.storage.setItem(key, value == 'true' or value is True)
            if key == 'wired_to_power':
                self.chargeState = ChargeState.Charging.value if self.wired_to_power else ChargeState.NotCharging.value
            await self.refresh_device()
            if key == 'disable_webrtc':
                await self.onDeviceEvent(ScryptedInterface.VideoCamera.value, None)
        elif key in ['eco_mode', 'disable_eager_streams']:
            self.storage.setItem(key, value == 'true' or value is True)
        elif key == 'print_debug':
            self.logger.debug(f'Device Capabilities: {json.dumps(self.arlo_capabilities)}')
            self.logger.debug(f'Device Smart Features: {json.dumps(self.arlo_smart_features)}')
            self.logger.debug(f'Device Properties: {json.dumps(self.arlo_properties)}')
            self.logger.debug(f'Device State: {self.device_state}')
            self.logger.debug(f'Activity State: {self.activity_state}')
        elif key == 'restart_device':
            if self.activity_state == 'idle':
                self.logger.debug('Restarting Device')
                await self.provider.arlo.restart_device(self.arlo_device['deviceId'])
            else:
                self.logger.warning('Device is not idle, cannot restart at this time.')
        else:
            self.storage.setItem(key, value)
        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)

    def _validate_setting(self, key: str, val: SettingValue) -> bool:
        if key == 'snapshot_throttle_interval':
            try:
                int(val)
            except ValueError:
                self.logger.error(f'Invalid snapshot throttle interval {val!r} - must be an integer')
                return False
        return True

    async def _wait_for_state_change(self, name: str = None) -> None:
        start_time = asyncio.get_event_loop().time()
        self.logger.debug('Checking activity state...')
        while True:
            scrypted_device: VideoCamera = scrypted_sdk.systemManager.getDeviceById(self.getScryptedProperty('id'))
            if scrypted_device:
                msos: list[ResponseMediaStreamOptions] = await scrypted_device.getVideoStreamOptions()
                prebuffer_name: str | None = next((m['name'] for m in msos if 'prebuffer' in m), None) if msos else None
            if self.activity_state == 'idle' or (prebuffer_name and name == prebuffer_name):
                self.logger.debug('Activity State is idle or selected stream is currently active, continuing...')
                break
            elif (asyncio.get_event_loop().time() - start_time) > self.timeout:
                self.activity_state = 'idle'
                raise TimeoutError('Waiting for activity state to be idle timed out')
            await asyncio.sleep(1)

    async def getPictureOptions(self) -> list[ResponsePictureOptions]:
        return []

    async def takePicture(self, options: dict = None) -> MediaObject:
        try:
            self.logger.info('Requesting snapshot')
            async with self.snapshot_lock:
                try:
                    await self._attempt_snapshot_from_prebuffer()
                    self.logger.debug('Snapshot created successfully from prebuffer')
                    return self.last_snapshot
                except Exception as e:
                    self.logger.error(f'Prebuffer snapshot failed: {e}')
                if not self._is_time_for_new_snapshot():
                    if self.last_snapshot:
                        self.logger.debug('Returning cached snapshot within throttle interval')
                        return self.last_snapshot
                    else:
                        self.logger.warning('No cached snapshot available within throttle interval')
                try:
                    await self._attempt_snapshot_from_arlo_cloud()
                    self.logger.debug('Snapshot created successfully from Arlo Cloud')
                    return self.last_snapshot
                except Exception as e:
                    self.logger.error(f'Arlo Cloud snapshot failed: {e}')
        except Exception as e:
            self.logger.error(f'Unexpected error during snapshot process: {e}')
        self.logger.error('Failed to create or retrieve any snapshot')
        return None

    def _is_time_for_new_snapshot(self) -> bool:
        self.logger.debug('Checking if it is time for a new snapshot')
        if not hasattr(self, 'last_snapshot_time') or self.last_snapshot_time is None:
            return True
        return self.snapshot_throttle_interval == 0 or (
            self.snapshot_throttle_interval > 0 and
            datetime.now() - self.last_snapshot_time >= timedelta(minutes=self.snapshot_throttle_interval)
        )

    async def _attempt_snapshot_from_prebuffer(self) -> None:
        try:
            scrypted_device, prebuffer_id = await self._get_scrypted_device_and_prebuffer_id()
            buf: bytes = await self._get_buffer_from_prebuffer(scrypted_device, prebuffer_id)
            await self._create_snapshot_from_buffer(buf)
        except Exception:
            raise

    async def _attempt_snapshot_from_arlo_cloud(self) -> None:
        try:
            snapshot_url: str = await self._get_snapshot_url()
            buf: bytes = await self._get_buffer_from_url(snapshot_url)
            await self._create_snapshot_from_buffer(buf)
        except Exception:
            raise

    async def _get_scrypted_device_and_prebuffer_id(self) -> tuple[ArloCamera, str]:
        self.logger.debug('Attempting to get Scrypted Device and Prebuffer ID')
        scrypted_device: ArloCamera = scrypted_sdk.systemManager.getDeviceById(self.getScryptedProperty('id'))
        if not scrypted_device:
            raise ValueError('Scrypted Device not found')
        msos: list[ResponseMediaStreamOptions] = await scrypted_device.getVideoStreamOptions()
        prebuffer_id: str | None = next((m['id'] for m in msos if 'prebuffer' in m), None)
        if not prebuffer_id:
            raise ValueError('Scrypted Device found, but no Prebuffer ID found')
        self.logger.debug('Successfully got Scrypted Device and Prebuffer ID')
        return scrypted_device, prebuffer_id

    async def _get_snapshot_url(self) -> str:
        self.logger.debug('Getting snapshot URL')
        try:
            await self._wait_for_state_change()
            snapshot_url: str = await asyncio.wait_for(
                self.provider.arlo.trigger_full_frame_snapshot(self.arlo_device), timeout=self.timeout
            )
        except Exception as e:
            raise ValueError(f'Failed to get snapshot URL: {e}')
        if not snapshot_url:
            raise ValueError('Snapshot URL is empty')
        self.logger.debug(f'Got snapshot URL: {snapshot_url}')
        return snapshot_url

    async def _get_buffer_from_prebuffer(self, scrypted_device: VideoCamera, prebuffer_id: str) -> bytearray:
        self.logger.debug('Attempting to get buffer from Scrypted Prebuffer')
        media_object: MediaObject = await scrypted_device.getVideoStream({'id': f'{prebuffer_id}', 'refresh': False})
        if not media_object:
            raise ValueError('No MediaObject received from Scrypted Prebuffer')
        buf: bytearray = await scrypted_sdk.mediaManager.convertMediaObjectToBuffer(media_object, 'image/jpeg')
        if not buf:
            raise ValueError('Failed to convert MediaObject to buffer')
        self.logger.debug('Successfully got buffer from Scrypted Prebuffer')
        return buf

    async def _get_buffer_from_url(self, snapshot_url: str) -> bytes:
        self.logger.debug('Attempting to get buffer from Arlo Cloud URL')
        async with aiohttp.ClientSession() as session:
            async with session.get(snapshot_url) as resp:
                if resp.status != 200:
                    raise ValueError(f'Unexpected status downloading snapshot image: {resp.status}')
                buf: bytes = await resp.read()
                if not buf:
                    raise ValueError('Failed to get buffer from Arlo Cloud URL')
                self.logger.debug('Successfully got buffer from Arlo Cloud URL')
                return buf

    async def _create_snapshot_from_buffer(self, buf: bytearray | bytes) -> None:
        self.logger.debug('Creating snapshot from buffer')
        current_snapshot: MediaObject = await scrypted_sdk.mediaManager.createMediaObject(buf, 'image/jpeg')
        if not current_snapshot:
            raise ValueError('Failed to create MediaObject from buffer')
        self.last_snapshot = current_snapshot
        self.last_snapshot_time = datetime.now()
        self.logger.debug('Successfully created snapshot from buffer')

    async def getVideoStreamOptions(self, id: str = None) -> list[ResponseMediaStreamOptions]:
        options: list[ResponseMediaStreamOptions] = [
            {
                'id': 'default',
                'name': 'Cloud RTSP',
                'container': 'rtsp',
                'video': {
                    'codec': 'h264',
                },
                'audio': None if self.arlo_device.get('modelId') == 'VMC3030' else {
                    'codec': 'aac',
                },
                'source': 'cloud',
                'tool': 'scrypted',
                'userConfigurable': False,
            },
            {
                'id': 'dash',
                'name': 'Cloud DASH',
                'container': 'dash',
                'video': {
                    'codec': 'unknown',
                },
                'audio': None if self.arlo_device.get('modelId') == 'VMC3030' else {
                    'codec': 'unknown',
                },
                'source': 'cloud',
                'tool': 'ffmpeg',
                'userConfigurable': False,
            }
        ]
        if self.has_local_live_streaming:
            options[0]['id'] = 'rtsp'
            if self.local_live_streaming_codec == 'h.264':
                options = [
                    {
                        'id': 'default',
                        'name': 'Local RTSP',
                        'container': 'rtsp',
                        'video': {
                            'codec': 'h264',
                        },
                        'audio': None if self.arlo_device.get('modelId') == 'VMC3030' else {
                            'codec': 'aac',
                        },
                        'source': 'cloud',
                        'tool': 'scrypted',
                        'userConfigurable': False,
                    },
                ] + options
            elif self.local_live_streaming_codec == 'h.265':
                options = [
                    {
                        'id': 'default',
                        'name': 'Local RTSP',
                        'container': 'rtsp',
                        'video': {
                            'codec': 'h265',
                        },
                        'audio': None if self.arlo_device.get('modelId') == 'VMC3030' else {
                            'codec': 'aac',
                        },
                        'source': 'cloud',
                        'tool': 'scrypted',
                        'userConfigurable': False,
                    },
                ] + options
        if id is None:
            return options
        return next(iter([o for o in options if o['id'] == id]))

    async def getVideoStream(self, options: RequestMediaStreamOptions = {}) -> MediaObject:
        self.logger.debug('Entered getVideoStream')
        mso = await self.getVideoStreamOptions(id=options.get('id', 'default'))
        mso['refreshAt'] = round(time.time() * 1000) + 30 * 60 * 1000
        container = mso['container']
        name = mso['name']
        url = await self._get_video_stream_url(name, container)
        additional_ffmpeg_args = []
        if container == 'dash':
            headers = self.provider.arlo.get_mpd_headers(url)
            ffmpeg_headers = '\r\n'.join([
                f'{k}: {v}'
                for k, v in headers.items()
            ])
            additional_ffmpeg_args = ['-headers', ffmpeg_headers + '\r\n']
        ffmpeg_input = {
            'url': url,
            'container': container,
            'mediaStreamOptions': mso,
            'inputArguments': [
                '-f', container,
                *additional_ffmpeg_args,
                '-i', url,
            ]
        }
        return await scrypted_sdk.mediaManager.createFFmpegMediaObject(ffmpeg_input)

    async def _get_video_stream_url(self, name: str, container: str) -> str:
        try:
            await self._wait_for_state_change(name)
            if name == 'Local RTSP':
                self.logger.info(f'Requesting local stream')
                basestation: ArloBasestation = await self.provider._get_device(self.arlo_basestation['deviceId'])
                if basestation is None:
                    raise Exception("This camera's basestation is missing or hidden, unable to use local stream.")
                if self.arlo_device['deviceId'] == self.arlo_basestation['deviceId']:
                    raise Exception('This camera is not connected to a basestation, unable to use local stream.')
                if basestation.ip is None or not basestation.ip:
                    raise Exception("Must specify the basestation's IP address to use local stream.")
                if basestation.host_name is None or not basestation.host_name:
                    raise Exception("Must specify the basestation's Hostname to use local stream.")
                if basestation.peer_cert is None or not basestation.peer_cert:
                    raise Exception('This basestation does not have a certificate, unable to use local stream.')
                proxy = ArloLocalStreamProxy(
                    self.provider,
                    basestation,
                    self
                )
                port = await proxy.start()
                if self.local_live_streaming_codec == 'h.264':
                    url = f'rtsp://localhost:{port}/{self.nativeId}/tcp/avc'
                elif self.local_live_streaming_codec == 'h.265':
                    url = f'rtsp://localhost:{port}/{self.nativeId}/tcp/hevc'
                self.logger.debug(f'Got local stream URL at {url}')
            else:
                self.logger.info(f'Requesting {container} stream')
                url: str = await asyncio.wait_for(self.provider.arlo.start_stream(self.arlo_device, mode=container, eager=not self.disable_eager_streams), timeout=self.timeout)
                self.logger.debug(f'Got {container} stream URL at {url}')
            return url
        except asyncio.TimeoutError:
            self.logger.error(f'Timed out waiting for {container} stream URL')
            raise TimeoutError(f'Timed out waiting for {container} stream URL')

    async def startIntercom(self, media: MediaObject) -> None:
        try:
            if not self.speaker:
                self.logger.debug('Speaker not initialized, creating...')
                self.speaker = self.intercom.speaker()
            await self.speaker.startIntercom(media)
            self.intercom_active = True
        except Exception as e:
            self.intercom_active = False
            self.logger.error(f'Error in startIntercom: {e}', exc_info=True)

    async def stopIntercom(self) -> None:
        try:
            if not self.intercom_active:
                self.logger.debug('Intercom is not active, nothing to stop.')
                return
            if not self.speaker:
                self.logger.debug('Speaker not initialized, creating...')
                self.speaker = self.intercom.speaker()
            await self.speaker.stopIntercom()
            self.intercom_active = False
        except Exception as e:
            self.intercom_active = False
            self.logger.error(f'Error in stopIntercom: {e}', exc_info=True)

    async def getVideoClip(self, videoId: str) -> MediaObject:
        self.logger.info(f'Getting video clip {videoId}')
        id_as_time = int(videoId) / 1000.0
        start = datetime.fromtimestamp(id_as_time) - timedelta(seconds=10)
        end = datetime.fromtimestamp(id_as_time) + timedelta(seconds=10)
        library = await self.provider.arlo.get_library(self.arlo_device, start, end)
        for recording in library:
            if videoId == recording['name']:
                return await scrypted_sdk.mediaManager.createMediaObjectFromUrl(recording['presignedContentUrl'])
        self.logger.warning(f'Clip {videoId} not found')
        return None

    async def getVideoClips(self, options: VideoClipOptions = None) -> list[VideoClip]:
        self.logger.info(f'Getting video clips {options}')
        start = datetime.fromtimestamp(options['startTime'] / 1000.0)
        end = datetime.fromtimestamp(options['endTime'] / 1000.0)
        library = await self.provider.arlo.get_library(self.arlo_device, start, end)
        clips = []
        for recording in library:
            clip = {
                'duration': recording['mediaDurationSecond'] * 1000.0,
                'id': recording['name'],
                'thumbnailId': recording['name'],
                'videoId': recording['name'],
                'startTime': recording['utcCreatedDate'],
                'description': recording['reason'],
                'resources': {
                    'thumbnail': {
                        'href': recording['presignedThumbnailUrl'],
                    },
                    'video': {
                        'href': recording['presignedContentUrl'],
                    },
                },
            }
            clips.append(clip)
        if options and options.get('reverseOrder'):
            clips.reverse()
        return clips

    async def getVideoClipThumbnail(self, thumbnailId: str, no_cache: bool = False) -> MediaObject:
        self.logger.info(f'Getting video clip thumbnail {thumbnailId}')
        id_as_time = int(thumbnailId) / 1000.0
        start = datetime.fromtimestamp(id_as_time) - timedelta(seconds=10)
        end = datetime.fromtimestamp(id_as_time) + timedelta(seconds=10)
        library = await self.provider.arlo.get_library(self.arlo_device, start, end, no_cache=no_cache)
        for recording in library:
            if thumbnailId == recording['name']:
                return await scrypted_sdk.mediaManager.createMediaObjectFromUrl(recording['presignedThumbnailUrl'])
        self.logger.warning(f'Clip thumbnail {thumbnailId} not found')
        return None

    async def removeVideoClips(self, videoClipIds: list[str]) -> None:
        raise Exception('Deleting Arlo video clips is not implemented by this plugin - please delete clips through the Arlo App.')

    async def getDevice(self, nativeId: str) -> ArloDeviceBase:
        if (nativeId.endswith('spotlight') and self.has_spotlight) or (nativeId.endswith('floodlight') and self.has_floodlight) or (nativeId.endswith('nightlight') and self.has_nightlight):
            if not self.light:
                self._create_light()
            return self.light
        if nativeId.endswith('svss') and self.has_siren:
            if not self.svss:
                self._create_svss()
            return self.svss
        if nativeId.endswith('intercom') and self.has_push_to_talk:
            if not self.intercom:
                self._create_intercom()
            return self.intercom
        return None

    def _create_light(self) -> None:
        if self.has_spotlight:
            light_id = f'{self.arlo_device["deviceId"]}.spotlight'
            self.light = ArloSpotlight(light_id, self.arlo_device, self.arlo_basestation, self.arlo_properties, self.provider, self)
        elif self.has_floodlight:
            light_id = f'{self.arlo_device["deviceId"]}.floodlight'
            self.light = ArloFloodlight(light_id, self.arlo_device, self.arlo_basestation, self.arlo_properties, self.provider, self)
        elif self.has_nightlight:
            light_id = f'{self.arlo_device["deviceId"]}.nightlight'
            self.light = ArloNightlight(light_id, self.arlo_device, self.arlo_properties, self.provider, self)

    def _create_svss(self) -> None:
        if self.has_siren:
            svss_id = f'{self.arlo_device["deviceId"]}.svss'
            self.svss = ArloSirenVirtualSecuritySystem(svss_id, self.arlo_device, self.arlo_basestation, self.arlo_properties, self.provider, self)

    def _create_intercom(self) -> None:
        if self.has_push_to_talk:
            intercom_id = f'{self.arlo_device["deviceId"]}.intercom'
            self.intercom = ArloIntercom(intercom_id, self.arlo_device, self.arlo_basestation, self.arlo_properties, self.provider, self)

    async def getDetectionInput(self, detectionId: str, eventId: str = None) -> MediaObject:
        return await self.getVideoClipThumbnail(detectionId, no_cache=True)

    async def getObjectTypes(self) -> ObjectDetectionTypes:
        return {
            'classes': [
                'person',
                'vehicle',
                'package',
                'animal',
                'car',
                'truck',
                'bus',
                'motorbike',
                'bicycle',
                'dog',
                'cat',
            ]
        }

    async def setBrightness(self, brightness: float) -> None:
        self.logger.debug(f'Brightness {brightness}')
        brightness = int(brightness)
        if brightness not in ArloCamera.SCRYPTED_TO_ARLO_BRIGHTNESS_MAP:
            raise Exception('Valid brightness levels are 0, 25, 50, 75, 100')
        self.provider.arlo.brightness_set(self.arlo_basestation, self.arlo_device, ArloCamera.SCRYPTED_TO_ARLO_BRIGHTNESS_MAP[brightness])

    async def startRTCSignalingSession(self, scrypted_session: RTCSignalingSession):
        try:
            await self._wait_for_state_change('WebRTC')
            self.logger.debug('Starting RTC signaling session.')
            plugin_session = ArloCameraWebRTCSignalingSession(self)
            await plugin_session.delayed_init()
            plugin_session.scrypted_session = scrypted_session
            scrypted_setup = {
                'type': 'offer',
                'audio': {'direction': 'sendrecv'},
                'video': {'direction': 'recvonly'},
                'configuration': {
                    'iceServers': plugin_session.ice_servers,
                    'iceCandidatePoolSize': 0,
                }
            }
            try:
                scrypted_offer = await asyncio.wait_for(
                    scrypted_session.createLocalDescription('offer', scrypted_setup),
                    timeout=3
                )
            except asyncio.TimeoutError:
                self.logger.warning('Timeout waiting for ICE candidates, falling back to ignore trickle.')
                async def ignore_trickle(c): pass
                scrypted_offer = await scrypted_session.createLocalDescription('offer', scrypted_setup, ignore_trickle)
            self.logger.debug('Setting remote description on plugin session.')
            await plugin_session.setRemoteDescription(scrypted_offer)
            self.logger.debug('Creating local description (answer) from plugin session.')
            plugin_answer = await plugin_session.createLocalDescription()
            self.logger.debug('Setting remote description (answer) on Scrypted session.')
            await scrypted_session.setRemoteDescription(plugin_answer, scrypted_setup)
            self.logger.debug('RTC signaling session established successfully.')
            return ArloCameraWebRTCSessionControl(plugin_session)
        except Exception as e:
            self.logger.error(f'Error in startRTCSignalingSession: {e}', exc_info=True)
            raise

    async def turnOn(self):
        try:
            await self.provider.arlo.charge_notification_led_on(self.arlo_basestation, self.arlo_device)
        except Exception as e:
            self.logger.error(f'Error turning charge notification LED on: {e}', exc_info=True)

    async def turnOff(self):
        try:
            await self.provider.arlo.charge_notification_led_off(self.arlo_basestation, self.arlo_device)
        except Exception as e:
            self.logger.error(f'Error turning charge notification LED off: {e}', exc_info=True)