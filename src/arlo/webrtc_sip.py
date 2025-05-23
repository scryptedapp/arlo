from __future__ import annotations

import asyncio

from aiortc import RTCSessionDescription
from typing import Callable, Protocol, TYPE_CHECKING

from .client import SIPWebRTCManager, USER_AGENTS, WebRTCManager
from .util import BackgroundTaskMixin

if TYPE_CHECKING:
    from logging import Logger

    from .camera import ArloCamera
    from .intercom import ArloIntercom
    from .provider import ArloProvider

class BaseArloSignalingSession(BackgroundTaskMixin):
    def __init__(self, device: ArloCamera | ArloIntercom):
        super().__init__()
        self.logger: Logger = device.logger
        self.provider: ArloProvider = device.provider
        self.arlo_device: dict = device.arlo_device
        self.scrypted_session: RTCSignalingSession = None
        self.ice_servers: list[dict[str, str]] = None

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

    def _format_ice_servers(self) -> None:
        formatted = []
        for ice_server in self.ice_servers:
            entry = {'urls': [ice_server.get('url') or f"{ice_server.get('type')}:{ice_server.get('domain')}:{ice_server.get('port')}"]}
            if 'username' in ice_server:
                entry['username'] = ice_server['username']
            if 'credential' in ice_server:
                entry['credential'] = ice_server['credential']
            formatted.append(entry)
        self.ice_servers = formatted

    async def close(self):
        raise NotImplementedError("Subclasses must implement close() method.")

class BaseArloSessionControl:
    def __init__(self, arlo_session: BaseArloSignalingSession) -> None:
        self.arlo_session = arlo_session

    async def endSession(self):
        try:
            await self.arlo_session.close()
        except Exception as e:
            self.arlo_session.logger.error(f"Error ending session: {e}", exc_info=True)
            raise

class ArloCameraWebRTCSignalingSession(BaseArloSignalingSession):
    def __init__(self, camera: ArloCamera) -> None:
        super().__init__(camera)
        self.arlo_sip: SIPWebRTCManager = None
        self.sip_info: dict = None

    async def delayed_init(self):
        try:
            self.logger.debug("Fetching SIP info for camera WebRTC session.")
            self.sip_info = await self.provider.arlo.get_sip_info_v2(self.arlo_device)
            self.ice_servers = self.sip_info['iceServers']['data']
            self._format_ice_servers()
            self.logger.debug(f"SIP info and ICE servers set: {self.ice_servers}")
        except Exception as e:
            self.logger.error(f"Error in delayed_init: {e}", exc_info=True)
            raise

    async def setRemoteDescription(self, offer):
        try:
            self.logger.debug("Setting remote description for camera WebRTC session.")
            sip_call_info = self.sip_info['sipCallInfo']
            cleaned_offer_sdp = self._clean_sdp(offer['sdp'])
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
            self.arlo_sip = SIPWebRTCManager(
                self.logger,
                self.ice_servers,
                sip_cfg,
            )
            self.logger.debug("SIPWebRTCManager initialized for camera session.")
        except Exception as e:
            self.logger.error(f"Error in setRemoteDescription: {e}", exc_info=True)
            raise

    async def createLocalDescription(self):
        try:
            self.logger.debug("Creating local description (answer) for camera WebRTC session.")
            answer_sdp = await self.arlo_sip.start()
            cleaned_answer_sdp = self._clean_sdp(answer_sdp)
            self.logger.debug("Local description (answer) created successfully.")
            return {
                'sdp': cleaned_answer_sdp,
                'type': 'answer'
            }
        except Exception as e:
            self.logger.error(f"Error in createLocalDescription: {e}", exc_info=True)
            raise

    async def close(self):
        try:
            self.logger.debug("Closing camera WebRTC SIP session.")
            if self.arlo_sip is not None:
                await self.arlo_sip.close()
                self.arlo_sip = None
            self.logger.debug("Camera WebRTC SIP session closed.")
        except Exception as e:
            self.logger.error(f"Error in close: {e}", exc_info=True)
            raise

class ArloCameraWebRTCSessionControl(BaseArloSessionControl):
    def __init__(self, arlo_session: ArloCameraWebRTCSignalingSession) -> None:
        super().__init__(arlo_session)
        self.arlo_sip: SIPWebRTCManager = arlo_session.arlo_sip

    async def setPlayback(self, options):
        try:
            if options['audio']:
                await self.arlo_sip.start_talk()
            else:
                await self.arlo_sip.stop_talk()
        except Exception as e:
            self.arlo_session.logger.error(f"Error in setPlayback: {e}", exc_info=True)
            raise

class ArloIntercomWebRTCSignalingSession(BaseArloSignalingSession):
    def __init__(self, intercom: ArloIntercom) -> None:
        super().__init__(intercom)
        self.arlo_basestation: dict = intercom.arlo_basestation
        self.arlo_webrtc: WebRTCManager = None
        self.session_id: str = None
        self.answer: RTCSessionDescription = None
        self.local_description_set: bool = False
        self.stop_subscriptions: bool | None = None

    def __del__(self) -> None:
        self.stop_subscriptions = True
        self.cancel_pending_tasks()

    async def delayed_init(self) -> None:
        try:
            self.logger.debug("Starting push-to-talk session for intercom WebRTC.")
            self.session_id, self.ice_servers = await self.provider.arlo.start_push_to_talk(self.arlo_device)
            self._format_ice_servers()
            self.arlo_webrtc = WebRTCManager(
                logger=self.logger,
                ice_servers=self.ice_servers,
            )
            self._start_sdp_answer_subscription()
            self._start_candidate_answer_subscription()
            self.logger.debug("Intercom WebRTC session initialized.")
        except Exception as e:
            self.logger.error(f"Error in delayed_init: {e}", exc_info=True)
            raise

    def _start_sdp_answer_subscription(self) -> None:
        def callback(sdp):
            async def async_callback():
                try:
                    self.answer = RTCSessionDescription(sdp=sdp, type='answer')
                    await self.arlo_webrtc.set_local_description(self.answer)
                    self.local_description_set = True
                except Exception as e:
                    self.logger.error(f"Error in SDP answer subscription: {e}", exc_info=True)
                return self.stop_subscriptions
            asyncio.create_task(async_callback())
            return self.stop_subscriptions

        self._create_or_register_event_subscription(self.provider.arlo.subscribe_to_answer_sdp, self.arlo_device, callback)

    def _start_candidate_answer_subscription(self) -> None:
        def callback(candidate: str):
            async def async_callback():
                try:
                    if self.scrypted_session:
                        await self.scrypted_session.addIceCandidate({'candidate': candidate, 'sdpMid': '0', 'sdpMLineIndex': 0})
                except Exception as e:
                    self.logger.error(f"Error in candidate answer subscription: {e}", exc_info=True)
                return self.stop_subscriptions
            asyncio.create_task(async_callback())
            return self.stop_subscriptions

        self._create_or_register_event_subscription(self.provider.arlo.subscribe_to_answer_candidate, self.arlo_device, callback)

    def _create_or_register_event_subscription(self, subscribe_fn, *args, **kwargs):
        try:
            result = subscribe_fn(*args, **kwargs)
            if asyncio.iscoroutine(result):
                self.create_task(result)
            elif isinstance(result, asyncio.Task):
                self.register_task(result)
            else:
                raise TypeError('Event Subscription must return a coroutine or task.')
        except Exception as e:
            self.logger.error(f"Error in event subscription: {e}", exc_info=True)
            raise

    async def setRemoteDescription(self, offer) -> None:
        try:
            self.logger.debug("Setting remote description for intercom WebRTC session.")
            description = RTCSessionDescription(sdp=offer['sdp'], type='offer')
            await self.arlo_webrtc.set_remote_description(description)
            await self.provider.arlo.notify_push_to_talk_offer_sdp(
                self.arlo_basestation, self.arlo_device,
                self.session_id, offer['sdp']
            )
            self.logger.debug("Remote description set and push-to-talk offer notified.")
        except Exception as e:
            self.logger.error(f"Error in setRemoteDescription: {e}", exc_info=True)
            raise

    async def addIceCandidate(self, candidate) -> None:
        try:
            await self.arlo_webrtc.add_ice_candidate(candidate)
        except Exception as e:
            self.logger.error(f"Error in addIceCandidate: {e}", exc_info=True)
            raise

    async def close(self) -> None:
        try:
            self.logger.debug("Closing intercom WebRTC session.")
            if self.arlo_webrtc is not None:
                await self.arlo_webrtc.close()
                self.arlo_webrtc = None
            self.logger.debug("Intercom WebRTC session closed.")
        except Exception as e:
            self.logger.error(f"Error in close: {e}", exc_info=True)
            raise

class ArloIntercomWebRTCSessionControl(BaseArloSessionControl):
    pass

class ArloIntercomSIPSignalingSession(BaseArloSignalingSession):
    def __init__(self, intercom: ArloIntercom) -> None:
        super().__init__(intercom)
        self.arlo_sip: SIPWebRTCManager = None
        self.sip_info: dict = None

    async def delayed_init(self) -> None:
        try:
            self.logger.debug("Fetching SIP info for intercom SIP session.")
            self.sip_info = await self.provider.arlo.get_sip_info()
            self.ice_servers = self.sip_info['iceServers']['data']
            self._format_ice_servers()
            self.logger.debug(f"SIP info and ICE servers set: {self.ice_servers}")
        except Exception as e:
            self.logger.error(f"Error in delayed_init: {e}", exc_info=True)
            raise

    async def setRemoteDescription(self, offer) -> None:
        try:
            self.logger.debug("Setting remote description for intercom SIP session.")
            sip_call_info: dict = self.sip_info['sipCallInfo']
            cleaned_offer_sdp = self._clean_sdp(offer['sdp'])
            sip_cfg = {
                'DeviceID': self.arlo_device['deviceId'],
                'CallerURI': f'sip:{sip_call_info["id"]}@{sip_call_info["domain"]}:{sip_call_info["port"]}',
                'CalleeURI': sip_call_info['calleeUri'],
                'Password': sip_call_info['password'],
                'UserAgent': 'SIP.js/0.20.1',
                'WebsocketURI': f'wss://{sip_call_info["domain"]}:7443',
                'WebsocketOrigin': 'https://my.arlo.com',
                'WebsocketHeaders': {
                    'User-Agent': USER_AGENTS['linux']
                },
                'SDP': cleaned_offer_sdp,
            }
            self.arlo_sip = SIPWebRTCManager(
                self.logger,
                self.ice_servers,
                sip_cfg,
                True,
            )
            self.logger.debug("SIPWebRTCManager initialized for intercom SIP session.")
        except Exception as e:
            self.logger.error(f"Error in setRemoteDescription: {e}", exc_info=True)
            raise

    async def createLocalDescription(self) -> dict:
        try:
            self.logger.debug("Creating local description (answer) for intercom SIP session.")
            answer_sdp = await self.arlo_sip.start()
            cleaned_answer_sdp = self._clean_sdp(answer_sdp)
            self.logger.debug("Local description (answer) created successfully.")
            return {
                'sdp': cleaned_answer_sdp,
                'type': 'answer'
            }
        except Exception as e:
            self.logger.error(f"Error in createLocalDescription: {e}", exc_info=True)
            raise

    async def close(self) -> None:
        try:
            self.logger.debug("Closing intercom SIP session.")
            if self.arlo_sip is not None:
                await self.arlo_sip.close()
                self.arlo_sip = None
            self.logger.debug("Intercom SIP session closed.")
        except Exception as e:
            self.logger.error(f"Error in close: {e}", exc_info=True)
            raise

class ArloIntercomSIPSessionControl(BaseArloSessionControl):
    pass

class RTCSignalingSession(Protocol):
    async def createLocalDescription(self, type: str, setup: dict, sendIceCandidate: Callable = None) -> dict: ...
    async def setRemoteDescription(self, description: dict, setup: dict) -> None: ...
    async def addIceCandidate(self, candidate: dict) -> None: ...