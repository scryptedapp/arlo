from __future__ import annotations

import asyncio

from typing import Callable, Protocol, TYPE_CHECKING

from .client import SIPManager, USER_AGENTS

if TYPE_CHECKING:
    from logging import Logger

    from .camera import ArloCamera
    from .intercom import ArloIntercom


class BaseArloSignalingSession():
    def __init__(self, device: ArloCamera | ArloIntercom):
        self.logger: Logger = device.logger
        self.provider = device.provider
        self.arlo_device: dict = device.arlo_device
        self.scrypted_session: RTCSignalingSession = None
        self.ice_servers: list[dict[str, str]] = None
        self.task_manager = self.provider.task_manager
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
            entry = {'urls': [ice_server.get('url') or f'{ice_server.get("type")}:{ice_server.get("domain")}:{ice_server.get("port")}']}
            if 'username' in ice_server:
                entry['username'] = ice_server['username']
            if 'credential' in ice_server:
                entry['credential'] = ice_server['credential']
            formatted.append(entry)
        self.ice_servers = formatted

    def _patch_sdp(self, sdp: str) -> str:
        def parse_sections(sdp: str):
            lines = sdp.splitlines()
            header = []
            sections = []
            current = []
            for line in lines:
                if line.startswith('m='):
                    if current:
                        sections.append(current)
                    current = [line]
                elif not sections and not current:
                    header.append(line)
                else:
                    current.append(line)
            if current:
                sections.append(current)
            return header, sections
        header, sections = parse_sections(sdp)
        patched_sections = []
        section: list[list[str]] = []
        for i, section in enumerate(sections):
            mline = section[0]
            is_rejected = str(mline).split()[1] == '0'
            has_mid = any(str(l).startswith('a=mid:') for l in section)
            if not has_mid:
                c_idx = next((j for j, l in enumerate(section) if str(l).startswith('c=')), None)
                insert_at = c_idx + 1 if c_idx is not None else 1
                section.insert(insert_at, f'a=mid:{i}')
            if is_rejected:
                minimal = [section[0]]
                c_line = next((l for l in section if str(l).startswith('c=')), None)
                if c_line:
                    minimal.append(c_line)
                mid_line = next((l for l in section if str(l).startswith('a=mid:')), None)
                if mid_line:
                    minimal.append(mid_line)
                minimal.append('a=inactive')
                patched_sections.append(minimal)
            else:
                patched_sections.append(section)
        patched_sdp = '\r\n'.join(header)
        for section in patched_sections:
            patched_sdp += '\r\n' + '\r\n'.join(section)
        patched_sdp += '\r\n'
        return patched_sdp

    async def close(self):
        raise NotImplementedError('Subclasses must implement close() method.')


class BaseArloSessionControl:
    def __init__(self, arlo_session: BaseArloSignalingSession, on_end: Callable[[], object] | None = None) -> None:
        self.arlo_session = arlo_session
        self._on_end = on_end

    async def endSession(self):
        try:
            await self.arlo_session.close()
        except Exception as e:
            self.arlo_session.logger.error(f'Error ending session: {e}', exc_info=True)
            raise
        finally:
            try:
                if self._on_end:
                    self._on_end()
            except Exception:
                pass


class ArloCameraWebRTCSignalingSession(BaseArloSignalingSession):
    def __init__(self, camera: ArloCamera) -> None:
        super().__init__(camera)
        self.arlo_sip: SIPManager = None
        self.sip_info: dict = None

    async def delayed_init(self):
        try:
            self.logger.debug('Fetching SIP info for camera WebRTC session.')
            self.sip_info = await self.provider.arlo.get_sip_info_v2(self.arlo_device)
            self.ice_servers = self.sip_info['iceServers']['data']
            self._format_ice_servers()
            self.logger.debug(f'SIP info and ICE servers set: {self.ice_servers}')
        except Exception as e:
            self.logger.error(f'Error in delayed_init: {e}', exc_info=True)
            raise

    async def setRemoteDescription(self, offer):
        try:
            self.logger.debug('Setting remote description for camera WebRTC session.')
            sip_call_info = self.sip_info['sipCallInfo']
            offer_sdp = self._clean_sdp(offer['sdp'])
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
                'SDP': offer_sdp,
            }
            self.arlo_sip = SIPManager(
                self.logger,
                sip_cfg,
                provider=self.provider,
            )
            self.logger.debug('SIPManager initialized for camera session.')
        except Exception as e:
            self.logger.error(f'Error in setRemoteDescription: {e}', exc_info=True)
            raise

    async def createLocalDescription(self):
        try:
            self.logger.debug('Creating local description (answer) for camera WebRTC session.')
            answer_sdp = await self.arlo_sip.start()
            answer_sdp = self._patch_sdp(answer_sdp)
            answer_sdp = self._clean_sdp(answer_sdp)
            self.logger.debug('Local description (answer) created successfully.')
            return {
                'sdp': answer_sdp,
                'type': 'answer'
            }
        except Exception as e:
            self.logger.error(f'Error in createLocalDescription: {e}', exc_info=True)
            raise

    async def close(self):
        try:
            self.logger.debug('Closing camera WebRTC SIP session.')
            if self.arlo_sip is not None:
                await self.arlo_sip.close()
                self.arlo_sip = None
            self.logger.debug('Camera WebRTC SIP session closed.')
        except Exception as e:
            self.logger.error(f'Error in close: {e}', exc_info=True)
            raise


class ArloCameraWebRTCSessionControl(BaseArloSessionControl):
    def __init__(self, arlo_session: ArloCameraWebRTCSignalingSession, on_end: Callable[[], object] | None = None) -> None:
        super().__init__(arlo_session, on_end=on_end)
        self.arlo_sip: SIPManager = arlo_session.arlo_sip

    async def setPlayback(self, options):
        try:
            if options['audio']:
                await self.arlo_sip.start_talk()
            else:
                await self.arlo_sip.stop_talk()
        except Exception as e:
            self.arlo_session.logger.error(f'Error in setPlayback: {e}', exc_info=True)
            raise


class ArloIntercomWebRTCSignalingSession(BaseArloSignalingSession):
    active_event_subscriptions: dict[str, asyncio.Task] = None

    def __init__(self, intercom: ArloIntercom) -> None:
        super().__init__(intercom)
        self.arlo_basestation: dict = intercom.arlo_basestation
        self.session_id: str = None
        self.answer: dict = None
        self.stop_subscriptions: bool | None = None

    def __del__(self) -> None:
        try:
            self.stop_subscriptions = True
        except Exception:
            pass
        try:
            if self.provider and self.provider.loop is not None and not self.provider.loop.is_closed() and self.provider.loop.is_running():
                asyncio.run_coroutine_threadsafe(self.close(), self.provider.loop)
                return
        except Exception:
            pass
        try:
            self.task_manager.cancel_by_owner(self)
        except Exception:
            pass

    async def delayed_init(self) -> None:
        try:
            self.logger.debug('Starting push-to-talk session for intercom WebRTC.')
            self.session_id, self.ice_servers = await self.provider.arlo.start_push_to_talk(self.arlo_device)
            self._format_ice_servers()
            self._start_sdp_answer_subscription()
            self._start_candidate_answer_subscription()
            self.logger.debug('Intercom WebRTC session initialized.')
        except Exception as e:
            self.logger.error(f'Error in delayed_init: {e}', exc_info=True)
            raise

    def _start_sdp_answer_subscription(self) -> None:
        def callback(sdp):
            async def async_callback(sdp=sdp):
                try:
                    sdp = self._patch_sdp(sdp)
                    self.answer = {'sdp': sdp, 'type': 'answer'}
                except Exception as e:
                    self.logger.error(f'Error in SDP answer subscription: {e}', exc_info=True)
                return self.stop_subscriptions
            self.task_manager.create_task(async_callback(), tag='webrtc-intercom-answer-sdp', owner=self)
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_answer_sdp,
            self.arlo_device, callback,
            event_key='intercom_answer_sdp'
        )

    def _start_candidate_answer_subscription(self) -> None:
        def callback(candidate: str):
            async def async_callback():
                try:
                    if self.scrypted_session:
                        await self.scrypted_session.addIceCandidate({'candidate': candidate, 'sdpMid': '0', 'sdpMLineIndex': 0})
                except Exception as e:
                    self.logger.error(f'Error in candidate answer subscription: {e}', exc_info=True)
                return self.stop_subscriptions
            self.task_manager.create_task(async_callback(), tag='webrtc-intercom-answer-candidate', owner=self)
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_answer_candidate,
            self.arlo_device, callback,
            event_key='intercom_answer_candidate'
        )

    def _create_or_register_event_subscription(self, subscribe_fn, *args, event_key=None, **kwargs):
        if self.active_event_subscriptions is None:
            self.active_event_subscriptions = {}
        key = event_key or getattr(subscribe_fn, '__name__', str(subscribe_fn))
        existing = self.active_event_subscriptions.get(key)
        if existing and (isinstance(existing, list) or not getattr(existing, 'done', lambda: False)()):
            self.logger.debug(f'Event subscription "{key}" already running for device {self.arlo_device["deviceId"]}.')
            return
        result = subscribe_fn(*args, **kwargs)
        if isinstance(result, (list, tuple, set)):
            tasks = []
            for item in result:
                if isinstance(item, asyncio.Task):
                    self.task_manager.register(item, tag=key, owner=self)
                    tasks.append(item)
                else:
                    tasks.append(self.task_manager.create_task(item, tag=key, owner=self))
            self.active_event_subscriptions[key] = tasks
            return
        task = self.task_manager.create_task(result, tag=key, owner=self)
        self.active_event_subscriptions[key] = task

    async def setRemoteDescription(self, offer) -> None:
        try:
            self.logger.debug('Setting remote description for intercom WebRTC session.')
            offer_sdp = offer['sdp']
            await self.provider.arlo.notify_push_to_talk_offer_sdp(
                self.arlo_basestation, self.arlo_device,
                self.session_id, offer_sdp
            )
            self.logger.debug('Remote description set and push-to-talk offer notified.')
        except Exception as e:
            self.logger.error(f'Error in setRemoteDescription: {e}', exc_info=True)
            raise

    async def close(self) -> None:
        try:
            self.stop_subscriptions = True
            try:
                await self.task_manager.cancel_and_await_by_owner(self)
            except Exception:
                pass
            self.logger.debug('Intercom WebRTC session closed.')
        except Exception as e:
            self.logger.error(f'Error in close: {e}', exc_info=True)
            raise


class ArloIntercomWebRTCSessionControl(BaseArloSessionControl):
    pass


class ArloIntercomSIPSignalingSession(BaseArloSignalingSession):
    def __init__(self, intercom: ArloIntercom) -> None:
        super().__init__(intercom)
        self.arlo_sip: SIPManager = None
        self.sip_info: dict = None

    async def delayed_init(self) -> None:
        try:
            self.logger.debug('Fetching SIP info for intercom SIP session.')
            self.sip_info = await self.provider.arlo.get_sip_info()
            self.ice_servers = self.sip_info['iceServers']['data']
            self._format_ice_servers()
            self.logger.debug(f'SIP info and ICE servers set: {self.ice_servers}')
        except Exception as e:
            self.logger.error(f'Error in delayed_init: {e}', exc_info=True)
            raise

    async def setRemoteDescription(self, offer) -> None:
        try:
            self.logger.debug('Setting remote description for intercom SIP session.')
            sip_call_info: dict = self.sip_info['sipCallInfo']
            offer_sdp = self._clean_sdp(offer['sdp'])
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
                'SDP': offer_sdp,
            }
            self.arlo_sip = SIPManager(
                self.logger,
                sip_cfg,
                provider=self.provider,
            )
            self.logger.debug('SIPManager initialized for intercom SIP session.')
        except Exception as e:
            self.logger.error(f'Error in setRemoteDescription: {e}', exc_info=True)
            raise

    async def createLocalDescription(self) -> dict:
        try:
            self.logger.debug('Creating local description (answer) for intercom SIP session.')
            sdp = await self.arlo_sip.start()
            sdp = self._patch_sdp(sdp)
            sdp = self._clean_sdp(sdp)
            self.logger.debug('Local description (answer) created successfully.')
            return {
                'sdp': sdp,
                'type': 'answer'
            }
        except Exception as e:
            self.logger.error(f'Error in createLocalDescription: {e}', exc_info=True)
            raise

    async def close(self) -> None:
        try:
            self.logger.debug('Closing intercom SIP session.')
            if self.arlo_sip is not None:
                await self.arlo_sip.close()
                self.arlo_sip = None
            self.logger.debug('Intercom SIP session closed.')
        except Exception as e:
            self.logger.error(f'Error in close: {e}', exc_info=True)
            raise


class ArloIntercomSIPSessionControl(BaseArloSessionControl):
    pass


class RTCSignalingSession(Protocol):
    async def createLocalDescription(self, type: str, setup: dict, sendIceCandidate: Callable = None) -> dict: ...
    async def setRemoteDescription(self, description: dict, setup: dict) -> None: ...
    async def addIceCandidate(self, candidate: dict) -> None: ...