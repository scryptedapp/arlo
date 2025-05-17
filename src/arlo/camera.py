from __future__ import annotations

import aiohttp
import asyncio
import json
import time

from async_timeout import timeout as async_timeout
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
    MediaObject,
    MotionSensor,
    ObjectDetectionTypes,
    ObjectDetector,
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
from .light import ArloBaseLight, ArloSpotlight, ArloFloodlight, ArloNightlight
from .logging import TCPLogServer
from .vss import ArloBaseVirtualSecuritySystem, ArloSirenVirtualSecuritySystem
from .webrtc_sip import (
    ArloCameraIntercomSession,
    ArloCameraSIPIntercomSession,
    ArloCameraWebRTCIntercomSession,
    ArloCameraRTCSessionControl,
    ArloCameraRTCSignalingSession,
    RTCSignalingSession,
)

if TYPE_CHECKING:
    from .provider import ArloProvider

class ArloCamera(ArloDeviceBase, Settings, Camera, VideoCamera, Brightness, ObjectDetector, DeviceProvider, VideoClips, MotionSensor, AudioSensor, Battery, Charger):
    SCRYPTED_TO_ARLO_BRIGHTNESS_MAP = {
        0: -2,
        25: -1,
        50: 0,
        75: 1,
        100: 2
    }
    ARLO_TO_SCRYPTED_BRIGHTNESS_MAP = {v: k for k, v in SCRYPTED_TO_ARLO_BRIGHTNESS_MAP.items()}

    timeout: int = 30
    intercom_session: ArloCameraIntercomSession = None
    light: ArloBaseLight = None
    svss: ArloBaseVirtualSecuritySystem = None
    picture_lock: asyncio.Lock = None
    last_picture: bytes = None
    last_picture_time: datetime = datetime(1970, 1, 1)
    info_logger: TCPLogServer
    debug_logger: TCPLogServer

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, provider: 'ArloProvider') -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, provider=provider)
        self.picture_lock = asyncio.Lock()
        self.info_logger = TCPLogServer(self, self.logger.info)
        self.debug_logger = TCPLogServer(self, self.logger.debug)

    async def _delayed_init(self) -> None:
        await super()._delayed_init()
        self._start_error_subscription()
        self._start_motion_subscription()
        self._start_audio_subscription()
        self._start_battery_subscription()
        self._start_brightness_subscription()
        self._start_smart_motion_subscription()
        if not self.has_battery:
            return
        for _ in range(100):
            if self.stop_subscriptions:
                return
            try:
                self.chargeState = ChargeState.Charging.value if self.wired_to_power else ChargeState.NotCharging.value
                return
            except Exception as e:
                self.logger.debug(f'Delayed init failed, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error('Delayed init exceeded iteration limit, giving up')
            return

    def _start_error_subscription(self) -> None:
        def callback(code, message):
            self.logger.error(f'Arlo returned error code {code} with message: {message}')
            return self.stop_subscriptions
        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_error_events,
            self.arlo_device, callback
        )

    def _start_motion_subscription(self) -> None:
        def callback(motion_detected):
            self.motionDetected = motion_detected
            return self.stop_subscriptions
        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_motion_events,
            self.arlo_device, callback, self.logger
        )

    def _start_audio_subscription(self) -> None:
        if not self.has_audio_sensor:
            return
        def callback(audio_detected):
            self.audioDetected = audio_detected
            return self.stop_subscriptions
        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_audio_events,
            self.arlo_device, callback, self.logger
        )

    def _start_battery_subscription(self) -> None:
        if not self.has_battery:
            return
        def callback(battery_level):
            self.batteryLevel = battery_level
            return self.stop_subscriptions
        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_battery_events,
            self.arlo_device, callback
        )

    def _start_brightness_subscription(self) -> None:
        def callback(brightness):
            self.brightness = ArloCamera.ARLO_TO_SCRYPTED_BRIGHTNESS_MAP[brightness]
            return self.stop_subscriptions
        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_brightness_events,
            self.arlo_device, callback
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
            self.arlo_device, callback
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
        if self.has_sip_webrtc_streaming:
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
        return results

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
        power_source: dict = self._get_capability('PowerSource')
        has_battery = 'Battery' in power_source
        has_ac = 'AC' in power_source
        if has_ac and not has_battery:
            return False
        if has_battery and has_ac:
            battery: dict = power_source.get('Battery')
            ac: dict = power_source.get('AC')
            battery_indicator = battery.get('indicatorVisible', True)
            ac_indicator = ac.get('indicatorVisible', True)
            if battery_indicator is False and ac_indicator is False:
                return False
        return True

    @property
    def has_push_to_talk(self) -> bool:
        return self._has_capability('fullDuplex', 'PushToTalk')

    @property
    def uses_sip_push_to_talk(self) -> bool:
        return self._has_capability('sip', 'PushToTalk', 'signal')

    @property
    def has_sip_webrtc_streaming(self) -> bool:
        return self._has_capability('SIPStreaming', 'Streaming')

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
        return result

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if not self._validate_setting(key, value):
            await self.onDeviceEvent(ScryptedInterface.Settings.value, None)
            return
        if key == 'wired_to_power':
            self.storage.setItem(key, value == 'true' or value is True)
            await self.provider.discover_devices()
        elif key in ['eco_mode', 'disable_eager_streams']:
            self.storage.setItem(key, value == 'true' or value is True)
        elif key == 'print_debug':
            self.logger.info(f'Device Capabilities: {json.dumps(self.arlo_capabilities)}')
            self.logger.info(f'Device Smart Features: {json.dumps(self.arlo_smart_features)}')
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

    async def getPictureOptions(self) -> list[ResponsePictureOptions]:
        return []

    async def takePicture(self, options: dict = None) -> MediaObject:
        self.logger.info('Taking picture')
        real_device: ArloCamera = await scrypted_sdk.systemManager.api.getDeviceById(self.getScryptedProperty('id'))
        msos = await real_device.getVideoStreamOptions()
        if any(['prebuffer' in m for m in msos]):
            self.logger.info('Getting snapshot from prebuffer')
            try:
                vs = await real_device.getVideoStream({'refresh': False})
            except Exception as e:
                self.logger.warning(f'Could not fetch from prebuffer due to: {e}')
                self.logger.warning('Will try to fetch snapshot from Arlo cloud')
            else:
                self.last_picture_time = datetime(1970, 1, 1)
                return vs
        async with self.picture_lock:
            if self.eco_mode and self.snapshot_throttle_interval > 0:
                if datetime.now() - self.last_picture_time <= timedelta(minutes=self.snapshot_throttle_interval):
                    self.logger.info('Using cached image')
                    return await scrypted_sdk.mediaManager.createMediaObject(self.last_picture, 'image/jpeg')
            pic_url = await asyncio.wait_for(self.provider.arlo.trigger_full_frame_snapshot(self.arlo_device), timeout=self.timeout)
            self.logger.debug(f'Got snapshot URL at {pic_url}')
            if pic_url is None:
                raise Exception('Error taking snapshot: no url returned')
            async with async_timeout(self.timeout):
                async with aiohttp.ClientSession() as session:
                    async with session.get(pic_url) as resp:
                        if resp.status != 200:
                            raise Exception(f'Unexpected status downloading snapshot image: {resp.status}')
                        self.last_picture = await resp.read()
                        self.last_picture_time = datetime.now()
            return await scrypted_sdk.mediaManager.createMediaObject(self.last_picture, 'image/jpeg')

    async def getVideoStreamOptions(self, id: str = None) -> list[ResponseMediaStreamOptions]:
        options = [
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
        if id is None:
            return options
        return next(iter([o for o in options if o['id'] == id]))

    async def _get_video_stream_url(self, container: str) -> str:
        self.logger.info(f'Requesting {container} stream')
        url = await asyncio.wait_for(self.provider.arlo.start_stream(self.arlo_device, mode=container, eager=not self.disable_eager_streams), timeout=self.timeout)
        self.logger.debug(f'Got {container} stream URL at {url}')
        return url

    async def getVideoStream(self, options: RequestMediaStreamOptions = {}) -> MediaObject:
        self.logger.debug('Entered getVideoStream')
        mso = await self.getVideoStreamOptions(id=options.get('id', 'default'))
        mso['refreshAt'] = round(time.time() * 1000) + 30 * 60 * 1000
        container = mso['container']
        url = await self._get_video_stream_url(container)
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

    async def startIntercom(self, media: MediaObject) -> None:
        self.logger.info('Starting intercom')
        if self.uses_sip_push_to_talk:
            self.intercom_session = ArloCameraSIPIntercomSession(self)
        else:
            self.intercom_session = ArloCameraWebRTCIntercomSession(self)
        await self.intercom_session.initialize_push_to_talk(media)
        self.logger.info('Intercom initialized')

    async def stopIntercom(self) -> None:
        self.logger.info('Stopping intercom')
        if self.intercom_session is not None:
            await self.intercom_session.shutdown()
            self.intercom_session = None

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
        return None

    def _create_light(self) -> None:
        if self.has_spotlight:
            light_id = f'{self.arlo_device["deviceId"]}.spotlight'
            self.light = ArloSpotlight(light_id, self.arlo_device, self.arlo_basestation, self.provider, self)
        elif self.has_floodlight:
            light_id = f'{self.arlo_device["deviceId"]}.floodlight'
            self.light = ArloFloodlight(light_id, self.arlo_device, self.arlo_basestation, self.provider, self)
        elif self.has_nightlight:
            light_id = f'{self.arlo_device["deviceId"]}.nightlight'
            self.light = ArloNightlight(light_id, self.arlo_device, self.provider, self)

    def _create_svss(self) -> None:
        if self.has_siren:
            svss_id = f'{self.arlo_device["deviceId"]}.svss'
            self.svss = ArloSirenVirtualSecuritySystem(svss_id, self.arlo_device, self.arlo_basestation, self.provider, self)

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
        self.logger.debug('Starting RTC signaling session.')
        plugin_session = ArloCameraRTCSignalingSession(self)
        await plugin_session.delayed_init()
        plugin_session.scrypted_session = scrypted_session
        raw_ice_servers: list[dict] = plugin_session.sip_info['iceServers']['data']
        ice_servers = [
            {
                'urls': [f'{ice_server["type"]}:{ice_server["domain"]}:{ice_server["port"]}'],
                'username': ice_server.get('username'),
                'credential': ice_server.get('credential'),
            }
            for ice_server in raw_ice_servers
        ]
        self.logger.debug(f'ICE servers from plugin session: {ice_servers}')
        scrypted_setup = {
            'type': 'offer',
            'audio': {'direction': 'sendrecv'},
            'video': {'direction': 'recvonly'},
            'configuration': {
                'iceServers': ice_servers,
                'iceCandidatePoolSize': 0,
            }
        }
        plugin_setup = {}
        try:
            self.logger.debug('Creating local description (offer) with Scrypted session.')
            scrypted_offer = await asyncio.wait_for(
                scrypted_session.createLocalDescription('offer', scrypted_setup),
                timeout=3
            )
        except asyncio.TimeoutError:
            self.logger.warning('Timeout waiting for Scrypted offer, using ignore_trickle fallback.')
            async def ignore_trickle(c): pass
            scrypted_offer = await scrypted_session.createLocalDescription('offer', scrypted_setup, ignore_trickle)
        self.logger.debug(f'Received Scrypted offer: {scrypted_offer}')
        await plugin_session.setRemoteDescription(scrypted_offer, plugin_setup)
        self.logger.debug('Creating local description (answer) with plugin session.')
        plugin_answer = await plugin_session.createLocalDescription('answer', plugin_setup)
        self.logger.info(f'Scrypted answer sdp:\n{plugin_answer["sdp"]}')
        self.logger.debug('Setting remote description on Scrypted session.')
        await scrypted_session.setRemoteDescription(plugin_answer, scrypted_setup)
        self.logger.debug('RTC signaling session complete, returning session control.')
        return ArloCameraRTCSessionControl(plugin_session)