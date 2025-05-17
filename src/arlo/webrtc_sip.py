from __future__ import annotations

import asyncio
import json

from aiortc import RTCSessionDescription
from aiortc.sdp import candidate_from_sdp
from typing import Callable, Protocol, TYPE_CHECKING

import scrypted_sdk
from scrypted_sdk import ScryptedMimeTypes
from scrypted_sdk.types import MediaObject

from .child_process import HeartbeatChildProcess
from .client import SIPWebRTCManager, UDP_PACKET_SIZE, USER_AGENTS, WebRTCManager
from .util import BackgroundTaskMixin

if TYPE_CHECKING:
    from .camera import ArloCamera

class ArloCameraIntercomSession(BackgroundTaskMixin):
    def __init__(self, camera: ArloCamera) -> None:
        super().__init__()
        self.camera = camera
        self.logger = camera.logger
        self.provider = camera.provider
        self.arlo_device = camera.arlo_device
        self.arlo_basestation = camera.arlo_basestation
        self.logger.debug('ArloCameraIntercomSession initialized.')

    async def initialize_push_to_talk(self, media: MediaObject) -> None:
        self.logger.debug('Called _initialize_push_to_talk (not implemented).')
        raise NotImplementedError('not implemented')

    async def shutdown(self) -> None:
        self.logger.debug('Called _shutdown (not implemented).')
        raise NotImplementedError('not implemented')

class ArloCameraWebRTCIntercomSession(ArloCameraIntercomSession):
    def __init__(self, camera: ArloCamera) -> None:
        super().__init__(camera)
        self.logger.debug('ArloCameraWebRTCIntercomSession initialized.')
        self.arlo_pc = None
        self.arlo_sdp_answered = False
        self.intercom_ffmpeg_subprocess = None
        self.stop_subscriptions: bool | None = None
        self._pending_tasks: list[asyncio.Task] = []
        self._start_sdp_answer_subscription()
        self._start_candidate_answer_subscription()

    def __del__(self) -> None:
        self.logger.debug('ArloCameraWebRTCIntercomSession __del__ called.')
        self.stop_subscriptions = True
        self.cancel_pending_tasks()

    def _start_sdp_answer_subscription(self) -> None:
        self.logger.debug('Starting SDP answer subscription.')
        def callback(sdp):
            async def async_callback():
                self.logger.debug(f'Received SDP answer: {sdp}')
                if self.arlo_pc and not self.arlo_sdp_answered:
                    if 'a=mid:' not in sdp:
                        sdp_mod = sdp + 'a=mid:0\r\n'
                    else:
                        sdp_mod = sdp
                    self.logger.info(f'Arlo response sdp:\n{sdp_mod}')
                    sdp_obj = RTCSessionDescription(sdp=sdp_mod, type='answer')
                    await self.arlo_pc.set_remote_description(sdp_obj)
                    self.arlo_sdp_answered = True
                return self.stop_subscriptions
            asyncio.create_task(async_callback())
            return self.stop_subscriptions

        self._create_or_register_event_subscription(self.provider.arlo.subscribe_to_answer_sdp, self.arlo_device, callback)

    def _start_candidate_answer_subscription(self) -> None:
        self.logger.debug('Starting candidate answer subscription.')
        def callback(candidate: str):
            async def async_callback():
                try:
                    self.logger.debug(f'Received ICE candidate: {candidate}')
                    if self.arlo_pc:
                        candidate_mod = candidate.strip()
                        if candidate_mod.startswith('a=candidate:'):
                            candidate_mod = candidate_mod[len('a=candidate:'):]
                        self.logger.info(f'Arlo response candidate: {candidate_mod}')
                        candidate_obj = candidate_from_sdp(candidate_mod)
                        candidate_obj.sdpMid = '0'
                        candidate_obj.sdpMLineIndex = 0
                        await self.arlo_pc.add_ice_candidate(candidate_obj)
                    return self.stop_subscriptions
                except Exception as e:
                    self.logger.error(f'Error processing ICE candidate: {e}')
                    return self.stop_subscriptions
            asyncio.create_task(async_callback())
            return self.stop_subscriptions

        self._create_or_register_event_subscription(self.provider.arlo.subscribe_to_answer_candidate, self.arlo_device, callback)

    def _create_or_register_event_subscription(self, subscribe_fn, *args, **kwargs):
        self.logger.debug(f'Registering event subscription: {subscribe_fn.__name__}')
        result = subscribe_fn(*args, **kwargs)
        if asyncio.iscoroutine(result):
            self.create_task(result)
        elif isinstance(result, asyncio.Task):
            self.register_task(result)
        else:
            raise TypeError('Event Subscription must return a coroutine or task.')

    async def initialize_push_to_talk(self, media: MediaObject) -> None:
        self.logger.debug('Initializing push to talk (WebRTC).')
        try:
            session_id, ice_servers = await self.provider.arlo.start_push_to_talk(self.arlo_device)
            ice_servers = self._format_ice_servers(ice_servers)
            self.arlo_pc = WebRTCManager(
                logger=self.logger,
                ice_servers=ice_servers,
                gather_candidates=True,
            )
        except Exception as e:
            self.logger.error(f'Failed to start push to talk: {e}')
            return
        ffmpeg_params = json.loads(await scrypted_sdk.mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput.value))
        self.logger.debug(f'Received ffmpeg params: {ffmpeg_params}')
        audio_port = await self.arlo_pc.initialize_audio_rtp_listener()
        ffmpeg_path = await scrypted_sdk.mediaManager.getFFmpegPath()
        ffmpeg_args = [
            '-y',
            '-hide_banner',
            '-loglevel', 'info',
            '-analyzeduration', '0',
            '-fflags', '-nobuffer',
            '-probesize', '500000',
            *ffmpeg_params['inputArguments'],
            '-acodec', 'libopus',
            '-af', 'pan=stereo|c0=c0|c1=c0,adelay=0:all=true',
            '-async', '1',
            '-flags', '+global_header',
            '-vbr', 'off',
            '-ar', '48k',
            '-b:a', '32k',
            '-bufsize', '96k',
            '-ac', '2',
            '-application', 'lowdelay',
            '-dn', '-sn', '-vn',
            '-frame_duration', '20',
            '-f', 'rtp',
            '-flush_packets', '1',
            f'rtp://127.0.0.1:{audio_port}?pkt_size={UDP_PACKET_SIZE}',
        ]
        self.logger.debug(f'Starting ffmpeg at {ffmpeg_path} with \'{" ".join(ffmpeg_args)}\'')
        self.intercom_ffmpeg_subprocess = HeartbeatChildProcess('FFmpeg', self.camera.info_logger.logger_server_port, ffmpeg_path, *ffmpeg_args)
        self.intercom_ffmpeg_subprocess.start()
        self.sdp_answered = False
        offer = await self.arlo_pc.create_offer(replace_audio=True)
        offer_sdp = offer.sdp
        self.logger.info(f'Arlo offer sdp:\n{offer_sdp}')
        await self.provider.arlo.notify_push_to_talk_offer_sdp(
            self.arlo_basestation, self.arlo_device,
            session_id, offer_sdp
        )

        async def trickle_candidates():
            count = 0
            try:
                while True:
                    candidate = await self.arlo_pc.get_next_ice_candidate()
                    if candidate:
                        self.logger.debug(f'Sending candidate to Arlo: {candidate}')
                        await self.provider.arlo.notify_push_to_talk_offer_candidate(
                            self.arlo_basestation, self.arlo_device,
                            session_id, candidate,
                        )
                        count += 1
                    else:
                        self.logger.debug(f'End of candidates, found {count} candidate(s)')
                        break
            except Exception:
                self.logger.exception('Exception while processing trickle candidates')
        asyncio.create_task(trickle_candidates())

    def _format_ice_servers(self, ice_servers):
        formatted = []
        for ice in ice_servers:
            entry = {'urls': [ice['url']]}
            if 'username' in ice:
                entry['username'] = ice['username']
            if 'credential' in ice:
                entry['credential'] = ice['credential']
            formatted.append(entry)
        return formatted

    async def shutdown(self) -> None:
        self.logger.debug('Shutting down WebRTC intercom session.')
        if self.intercom_ffmpeg_subprocess is not None:
            self.intercom_ffmpeg_subprocess.stop()
            self.intercom_ffmpeg_subprocess = None
        if self.arlo_pc is not None:
            await self.arlo_pc.close()
            self.arlo_pc = None

class ArloCameraSIPIntercomSession(ArloCameraIntercomSession):
    def __init__(self, camera: ArloCamera) -> None:
        super().__init__(camera)
        self.logger.debug('ArloCameraSIPIntercomSession initialized.')
        self.arlo_sip = None
        self.intercom_ffmpeg_subprocess = None

    async def initialize_push_to_talk(self, media: MediaObject) -> None:
        self.logger.debug('Initializing push to talk (SIP).')
        sip_info = await self.provider.arlo.get_sip_info()
        self.logger.debug(f'Received SIP info: {sip_info}')
        sip_call_info: dict = sip_info['sipCallInfo']
        ice_servers: list[dict[str, str]] = sip_info['iceServers']['data']
        ice_servers = [
            {
                'urls': [f'{ice_server["type"]}:{ice_server["domain"]}:{ice_server["port"]}'],
                'username': ice_server.get('username', ''),
                'credential': ice_server.get('credential', ''),
            }
            for ice_server in ice_servers
        ]
        self.logger.debug(f'Will use ice servers: {[ice["urls"] for ice in ice_servers]}')
        sip_cfg = {
            'DeviceID': self.camera.nativeId,
            'CallerURI': f'sip:{sip_call_info["id"]}@{sip_call_info["domain"]}:{sip_call_info["port"]}',
            'CalleeURI': sip_call_info['calleeUri'],
            'Password': sip_call_info['password'],
            'UserAgent': 'SIP.js/0.20.1',
            'WebsocketURI': f'wss://{sip_call_info["domain"]}:7443',
            'WebsocketOrigin': 'https://my.arlo.com',
            'WebsocketHeaders': {
                'User-Agent': USER_AGENTS['linux']
            },
        }
        self.arlo_sip = SIPWebRTCManager(
            self.logger,
            ice_servers,
            sip_cfg,
        )
        ffmpeg_params = json.loads(await scrypted_sdk.mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput.value))
        self.logger.debug(f'Received ffmpeg params: {ffmpeg_params}')
        audio_port = await self.arlo_sip.initialize_audio_rtp_listener()
        ffmpeg_path = await scrypted_sdk.mediaManager.getFFmpegPath()
        ffmpeg_args = [
            '-y',
            '-hide_banner',
            '-loglevel', 'info',
            '-analyzeduration', '0',
            '-fflags', '-nobuffer',
            '-probesize', '500000',
            *ffmpeg_params['inputArguments'],
            '-acodec', 'libopus',
            '-af', 'pan=stereo|c0=c0|c1=c0,adelay=0:all=true',
            '-async', '1',
            '-flags', '+global_header',
            '-vbr', 'off',
            '-ar', '48k',
            '-b:a', '32k',
            '-bufsize', '96k',
            '-ac', '2',
            '-application', 'lowdelay',
            '-dn', '-sn', '-vn',
            '-frame_duration', '20',
            '-f', 'rtp',
            '-flush_packets', '1',
            f'rtp://127.0.0.1:{audio_port}?pkt_size={UDP_PACKET_SIZE}',
        ]
        self.logger.debug(f"Starting ffmpeg at {ffmpeg_path} with '{' '.join(ffmpeg_args)}'")
        self.intercom_ffmpeg_subprocess = HeartbeatChildProcess('FFmpeg', self.camera.info_logger.logger_server_port, ffmpeg_path, *ffmpeg_args)
        self.intercom_ffmpeg_subprocess.start()

        try:
            asyncio.create_task(self.arlo_sip.start(replace_audio=True))
        except Exception as e:
            self.logger.error(f'Failed to start SIP call: {e}')
            return

    async def shutdown(self) -> None:
        self.logger.debug('Shutting down SIP intercom session.')
        if self.intercom_ffmpeg_subprocess is not None:
            self.intercom_ffmpeg_subprocess.stop()
            self.intercom_ffmpeg_subprocess = None
        if self.arlo_sip is not None:
            await self.arlo_sip.close()
            self.arlo_sip = None

class ArloCameraRTCSignalingSession(BackgroundTaskMixin):
    def __init__(self, camera: ArloCamera) -> None:
        super().__init__()
        self.camera = camera
        self.provider = camera.provider
        self.logger = camera.logger
        self.scrypted_session: RTCSignalingSession = None
        self.arlo_sip: SIPWebRTCManager = None
        self.sip_info = None
        self.logger.debug('ArloCameraRTCSignalingSession initialized.')

    async def delayed_init(self) -> None:
        self.logger.debug('Fetching SIP info for RTC signaling session.')
        self.sip_info = await self.provider.arlo.get_sip_info_v2(self.camera.arlo_device)
        self.logger.debug(f'Received SIP info: {self.sip_info}')

    def __del__(self) -> None:
        self.logger.debug('ArloCameraRTCSignalingSession __del__ called.')
        self.stop_subscriptions = True
        self.cancel_pending_tasks()

    async def createLocalDescription(self, type, setup, sendIceCandidate=None) -> dict:
        self.logger.debug(f'createLocalDescription called with type: {type}, setup: {setup}')
        if type == 'offer':
            raise Exception('can only create answers in ArloCameraRTCSignalingSession.createLocalDescription')
        if self.arlo_sip is None:
            raise Exception('need to initialize sip with setRemoteDescription first')
        answer_sdp = await self.arlo_sip.start()
        cleaned_answer_sdp = self._clean_sdp(answer_sdp)
        self.logger.debug(f'Returning answer SDP: {cleaned_answer_sdp}')
        return {
            'sdp': cleaned_answer_sdp,
            'type': 'answer'
        }

    async def setRemoteDescription(self, description, setup) -> None:
        self.logger.debug(f'setRemoteDescription called with description: {description}, setup: {setup}')
        if description['type'] != 'offer':
            raise Exception('can only accept offers in ArloCameraRTCSignalingSession.createLocalDescription')
        sip_call_info = self.sip_info['sipCallInfo']
        ice_servers: list[dict[str, str]] = self.sip_info['iceServers']['data']
        ice_servers = [
            {
                'urls': [f'{ice_server["type"]}:{ice_server["domain"]}:{ice_server["port"]}'],
                'username': ice_server.get('username', ''),
                'credential': ice_server.get('credential', ''),
            }
            for ice_server in ice_servers
        ]
        cleaned_offer_sdp = self._clean_sdp(description['sdp'])
        sip_cfg = {
            'DeviceID': sip_call_info['deviceId'],
            'CallerURI': f'sip:{sip_call_info["id"]}@{sip_call_info["domain"]}:{sip_call_info["port"]}',
            'CalleeURI': sip_call_info['calleeUri'],
            'Password': sip_call_info['password'],
            'UserAgent': 'SIP.js/0.21.1',
            'WebsocketURI': f'wss://{sip_call_info["domain"]}:7443',
            'WebsocketOrigin': 'https://my.arlo.com',
            'WebsocketHeaders': {
                'User-Agent': USER_AGENTS['firefox']
            },
            'SDP': cleaned_offer_sdp,
        }
        self.logger.debug(f'Initializing SIPWebRTCManager with config: {sip_cfg}')
        self.arlo_sip = SIPWebRTCManager(
            self.logger,
            ice_servers,
            sip_cfg,
            full_sip_webrtc=True,
        )

    def _clean_sdp(self, sdp: str) -> str:
        self.logger.debug('Cleaning SDP.')
        lines = sdp.split('\n')
        lines = [line.strip() for line in lines]
        section = []
        for line in lines:
            added = False
            if line.startswith('a=candidate:'):
                if line.count(':') <= 1 and '.local' not in line:
                    section.append(line)
                    added = True
            else:
                section.append(line)
                added = True
            if not added:
                self.logger.debug(f'Filtered out candidate: {line}')
        ret = '\r\n'.join(section)
        self.logger.debug(f'Cleaned SDP result: {ret}')
        return ret

class ArloCameraRTCSessionControl:
    def __init__(self, arlo_session: ArloCameraRTCSignalingSession) -> None:
        self.arlo_session = arlo_session
        self.logger = arlo_session.logger

    async def getRefreshAt(self) -> int:
        pass

    async def extendSession(self) -> None:
        pass

    async def endSession(self) -> None:
        self.logger.info('Ending RTC session')
        await self.arlo_session.arlo_sip.close()

    async def setPlayback(self, options) -> None:
        self.logger.debug(f'setPlayback options {options}')
        if options['audio']:
            self.logger.info('Starting intercom')
            await self.arlo_session.arlo_sip.start_talk()
        else:
            self.logger.info('Stopping intercom')
            await self.arlo_session.arlo_sip.stop_talk()

class RTCSignalingSession(Protocol):
    async def createLocalDescription(self, type: str, setup: dict, sendIceCandidate: Callable = None) -> dict: ...
    async def setRemoteDescription(self, description: dict, setup: dict) -> None: ...
    async def addIceCandidate(self, candidate: dict) -> None: ...