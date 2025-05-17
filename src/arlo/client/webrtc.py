from __future__ import annotations

import asyncio
import logging
import re
import socket

from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer
from aiortc.rtp import RtpPacket
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from aiortc import MediaStreamTrack, RTCIceCandidate, RTCDtlsTransport, RTCIceTransport, RTCIceGatherer

UDP_PACKET_SIZE = 1200

class WebRTCManager:
    def __init__(self, logger: logging.Logger, ice_servers: list[dict[str, Any]], gather_candidates: bool = False) -> None:
        self.logger = logger
        self.gather_candidates = gather_candidates
        self.pc = RTCPeerConnection(
            configuration=RTCConfiguration([RTCIceServer(**ice) for ice in ice_servers]),
        )
        self.audio_rtp: socket.socket | None = None
        self._rtcp_task: asyncio.Task | None = None
        self._rtp_task: asyncio.Task | None = None
        self.ice_candidates = asyncio.Queue()
        self.peer_connected = asyncio.Event()
        self.local_description = asyncio.Event()
        self._rtp_handler_registered = False
        self._rtp_track: MediaStreamTrack | None = None
        self.start_time = asyncio.get_event_loop().time()
        self.logger.debug(f'WebRTCManager created with ICE servers: {ice_servers}')
        self._setup_callbacks()
        self._configure_logging()

    def _setup_callbacks(self):
        self.logger.debug('Setting up WebRTCManager callbacks.')

        @self.pc.on('connectionstatechange')
        async def on_connectionstatechange():
            self.logger.debug(f'Connection state changed: {self.pc.connectionState}')
            if self.pc.connectionState == 'disconnected':
                self.logger.info('Peer connection disconnected, closing.')
                await self.close()
            elif self.pc.connectionState == 'connected':
                self.logger.info('Peer connection connected.')
                self.print_time_since_creation()
                self.peer_connected.set()

        @self.pc.on('track')
        async def on_track(track: MediaStreamTrack):
            self.logger.info(f'Ignoring incoming {track.kind} track')
            async def discard():
                self.logger.debug(f'Discarding incoming {track.kind} track packets.')
                while True:
                    try:
                        await track.recv()
                    except Exception as e:
                        self.logger.debug(f'Stopped discarding {track.kind} track: {e}')
                        break
            asyncio.create_task(discard())

        @self.pc.on('signalingstatechange')
        async def on_signalingstatechange():
            self.logger.debug(f'Signaling state changed: {self.pc.signalingState}')

        @self.pc.on('icegatheringstatechange')
        async def on_icegatheringstatechange():
            self.logger.debug(f'ICE gathering state changed: {self.pc.iceGatheringState}')
            if self.pc.iceGatheringState == 'complete' and self.gather_candidates:
                await self.gather_ice_candidates()

    def _configure_logging(self):
        webrtc_logger: logging.Logger = logging.getLogger('aiortc')
        handler: logging.Handler = None
        for handler in list(webrtc_logger.handlers):
            webrtc_logger.removeHandler(handler)
        for handler in list(self.logger.handlers):
            webrtc_logger.addHandler(handler)
        webrtc_logger.setLevel(self.logger.level)
        webrtc_logger.propagate = False

    async def initialize_audio_rtp_listener(self) -> int:
        self.logger.debug('Initializing audio RTP listener.')
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(('127.0.0.1', 0))
        sock.setblocking(False)
        self.audio_rtp = sock
        port = sock.getsockname()[1]
        self.logger.debug(f'Audio RTP socket bound to udp://127.0.0.1:{port}')

        self.pc.addTransceiver('audio', direction='sendonly')
        sender = self.pc.getSenders()[-1]
        try:
            transport: RTCDtlsTransport = sender.transport
            ice_transport: RTCIceTransport = transport.transport
            ice_gatherer: RTCIceGatherer = ice_transport.iceGatherer
            orignal_getLocalCandidates = ice_gatherer.getLocalCandidates

            def filtered_getLocalCandidates():
                def is_ipv6(addr):
                    return addr is not None and ':' in addr
                return [
                    c for c in orignal_getLocalCandidates()
                    if ':' not in c.ip and '.local' not in c.ip and not is_ipv6(getattr(c, 'relatedAddress', None))
                ]

            ice_gatherer.getLocalCandidates = filtered_getLocalCandidates
            self.logger.debug('Patched ICE gatherer to filter IPv6 and .local candidates.')
        except Exception as e:
            self.logger.warning(f'Could not patch ICE gatherer: {e}')

        async def rtcp_reader():
            self.logger.debug('RTCP reader task waiting for peer to connect.')
            await self.wait_for_peer_connected()
            self.logger.debug('RTCP reader task started.')
            last_stats = {}
            try:
                while True:
                    current_stats = {}
                    for rtcp in await sender.getStats():
                        stat_id = getattr(rtcp, 'id', None)
                        if stat_id is None:
                            stat_id = type(rtcp).__name__
                        stat_repr = repr(rtcp)
                        current_stats[stat_id] = stat_repr
                    if current_stats != last_stats:
                        self.logger.debug(f'RTCP stats changed: {current_stats}')
                        last_stats = current_stats.copy()
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                self.logger.info('RTCP reader task cancelled.')

        async def rtp_reader_loop():
            self.logger.debug('RTP handler loop waiting for peer to connect.')
            await self.wait_for_peer_connected()
            self.logger.debug('RTP handler loop started.')
            loop = asyncio.get_event_loop()
            try:
                def rtp_handler():
                    try:
                        data, _ = self.audio_rtp.recvfrom(UDP_PACKET_SIZE)
                        self.logger.debug(f'Received RTP data: {len(data)} bytes')
                        pkt = RtpPacket.parse(data)
                        self.logger.debug(f'Parsed RTP packet: seq={pkt.sequence_number}, ts={pkt.timestamp}, payload_type={pkt.payload_type}')
                        packet_bytes = pkt.serialize()
                        transport: RTCDtlsTransport = sender.transport
                        asyncio.create_task(transport._send_rtp(packet_bytes))
                        self.logger.debug(f'Forwarded RTP packet seq={pkt.sequence_number} ts={pkt.timestamp} via sender._transport._rtp.send_rtp')
                    except Exception as e:
                        self.logger.warning(f'Failed to parse or forward RTP packet: {e}')
                loop.add_reader(self.audio_rtp.fileno(), rtp_handler)
                self._rtp_handler_registered = True
                self.logger.debug('RTP reader registered.')
                while True:
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                self.logger.info('RTP handler loop cancelled.')
            except Exception as e:
                self.logger.error(f'Exception in RTP handler loop: {e}')
            finally:
                if self.audio_rtp and self._rtp_handler_registered:
                    loop.remove_reader(self.audio_rtp.fileno())
                    self._rtp_handler_registered = False
                    self.logger.debug('RTP reader unregistered in cleanup.')

        self._rtcp_task = asyncio.create_task(rtcp_reader())
        self._rtp_task = asyncio.create_task(rtp_reader_loop())
        self.logger.info(f'Created audio RTP listener at udp://127.0.0.1:{port}')
        return port

    def print_time_since_creation(self):
        elapsed = asyncio.get_event_loop().time() - self.start_time
        self.logger.info(f'Time elapsed since creation of {self.__class__.__name__}: {elapsed:.2f}s')

    async def create_offer(self, replace_audio: bool = False) -> RTCSessionDescription:
        try:
            self.logger.debug('Creating WebRTC offer.')
            offer = await self.pc.createOffer()
            sdp = offer.sdp
            if replace_audio:
                self.logger.debug('Replacing audio payload type in SDP.')
                sdp = self._patch_opus_payload_type(sdp)
            patched_offer = RTCSessionDescription(sdp=sdp, type=offer.type)
            await self.pc.setLocalDescription(patched_offer)
            self.local_description.set()
            self.logger.debug(f'Offer created and local description set: {self.pc.localDescription}')
            return self.pc.localDescription
        except Exception as e:
            self.logger.error(f'Error creating offer: {e}')
            raise

    def _patch_opus_payload_type(self, sdp: str) -> str:
        sdp = re.sub(
            r'^(m=audio \d+ [A-Z/]+ )96',
            r'\g<1>97',
            sdp,
            count=1,
            flags=re.MULTILINE
        )
        sdp = re.sub(
            r'^a=rtpmap:96 opus/48000/2',
            'a=rtpmap:97 opus/48000/2',
            sdp,
            flags=re.MULTILINE
        )
        return sdp

    async def set_remote_description(self, desc: RTCSessionDescription):
        self.logger.debug(f'Setting remote description: {desc}')
        await self.pc.setRemoteDescription(desc)
        self.logger.debug('Remote description set.')

    async def add_ice_candidate(self, candidate: RTCIceCandidate):
        self.logger.debug(f'Adding ICE candidate: {candidate}')
        await self.pc.addIceCandidate(candidate)
        self.logger.debug('ICE candidate added.')

    async def wait_for_peer_connected(self):
        await self.peer_connected.wait()

    async def wait_for_local_description(self):
        await self.local_description.wait()

    async def gather_ice_candidates(self):
        self.logger.debug('Gathering ICE candidates.')
        await self.wait_for_local_description()
        sdp = self.pc.localDescription.sdp
        self.logger.debug(f'Local SDP for ICE candidate gathering:\n{sdp}')
        candidates = re.findall(r'a=candidate:.*', sdp)
        self.logger.debug(f'Found {len(candidates)} ICE candidates: {candidates}')
        for candidate in candidates:
            self.logger.debug(f'Adding ICE candidate to queue: {candidate}')
            await self.ice_candidates.put(candidate)
        await self.ice_candidates.put(None)

    async def get_next_ice_candidate(self) -> str | None:
        self.logger.debug('Waiting for next ICE candidate from queue.')
        try:
            candidate = await asyncio.wait_for(self.ice_candidates.get(), timeout=5)
            self.logger.debug(f'Got ICE candidate from queue: {candidate}')
            return candidate
        except asyncio.TimeoutError:
            self.logger.warning('Timeout waiting for ICE candidate.')
            return None

    async def close(self):
        self.logger.debug('Closing WebRTCManager.')
        if self._rtcp_task:
            self._rtcp_task.cancel()
            try:
                await self._rtcp_task
            except asyncio.CancelledError:
                pass
        if self._rtp_task:
            self._rtp_task.cancel()
            try:
                await self._rtp_task
            except asyncio.CancelledError:
                pass
        if self.audio_rtp:
            if self._rtp_handler_registered:
                loop = asyncio.get_event_loop()
                loop.remove_reader(self.audio_rtp.fileno())
                self._rtp_handler_registered = False
                self.logger.debug('RTP reader unregistered in close.')
            self.logger.debug('Closing audio RTP socket.')
            self.audio_rtp.close()
        await self.pc.close()
        self.logger.info('Closed WebRTC peer connection')