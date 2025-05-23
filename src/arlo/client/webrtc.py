from __future__ import annotations

import asyncio
import logging

from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from aiortc import RTCIceCandidate, RTCSessionDescription

class WebRTCManager:
    def __init__(self, logger: logging.Logger, ice_servers: list[dict[str, Any]]) -> None:
        self.logger = logger
        try:
            self.pc = RTCPeerConnection(
                configuration=RTCConfiguration([RTCIceServer(**ice) for ice in ice_servers]),
            )
            self.start_time = asyncio.get_event_loop().time()
            self.logger.debug(f'WebRTCManager created with ICE servers: {ice_servers}')
            self._setup_callbacks()
            self._configure_logging()
        except Exception as e:
            self.logger.error(f"Error initializing WebRTCManager: {e}", exc_info=True)
            raise

    def _setup_callbacks(self):
        self.logger.debug('Setting up WebRTCManager callbacks.')

        @self.pc.on('connectionstatechange')
        async def on_connectionstatechange():
            try:
                self.logger.debug(f'Connection state changed: {self.pc.connectionState}')
                if self.pc.connectionState == 'disconnected':
                    self.logger.info('Peer connection disconnected, closing.')
                    await self.close()
                elif self.pc.connectionState == 'connected':
                    self.logger.info('Peer connection connected.')
                    self.print_time_since_creation()
            except Exception as e:
                self.logger.error(f"Error in connectionstatechange callback: {e}", exc_info=True)

    def _configure_logging(self):
        try:
            webrtc_logger: logging.Logger = logging.getLogger('aiortc')
            handler: logging.Handler = None
            for handler in list(webrtc_logger.handlers):
                webrtc_logger.removeHandler(handler)
            for handler in list(self.logger.handlers):
                webrtc_logger.addHandler(handler)
            webrtc_logger.setLevel(self.logger.level)
            webrtc_logger.propagate = False
            self.logger.debug("aiortc logging configured.")
        except Exception as e:
            self.logger.error(f"Error configuring aiortc logging: {e}", exc_info=True)

    def print_time_since_creation(self):
        try:
            elapsed = asyncio.get_event_loop().time() - self.start_time
            self.logger.info(f'Time elapsed since creation of {self.__class__.__name__}: {elapsed:.2f}s')
        except Exception as e:
            self.logger.error(f"Error printing time since creation: {e}", exc_info=True)

    async def set_remote_description(self, description: 'RTCSessionDescription'):
        try:
            self.logger.debug(f'Setting remote description: {description}')
            await self.pc.setRemoteDescription(description)
            self.logger.debug('Remote description set.')
        except Exception as e:
            self.logger.error(f"Error setting remote description: {e}", exc_info=True)
            raise

    async def set_local_description(self, description: 'RTCSessionDescription'):
        try:
            self.logger.debug(f'Setting local description: {description}')
            await self.pc.setLocalDescription(description)
            self.logger.debug('Local description set.')
        except Exception as e:
            self.logger.error(f"Error setting local description: {e}", exc_info=True)
            raise

    async def add_ice_candidate(self, candidate: 'RTCIceCandidate'):
        try:
            self.logger.debug(f'Adding ICE candidate: {candidate}')
            await self.pc.addIceCandidate(candidate)
            self.logger.debug('ICE candidate added.')
        except Exception as e:
            self.logger.error(f"Error adding ICE candidate: {e}", exc_info=True)
            raise

    async def close(self):
        try:
            self.logger.debug('Closing WebRTCManager.')
            await self.pc.close()
            self.logger.info('Closed WebRTC peer connection')
        except Exception as e:
            self.logger.error(f"Error closing WebRTCManager: {e}", exc_info=True)
            raise