from __future__ import annotations

import asyncio
import logging

from typing import TYPE_CHECKING

import scrypted_sdk
from scrypted_sdk.types import ScryptedDeviceType, ScryptedInterface

from .base import ArloDeviceBase
from .webrtc_sip import (
    ArloIntercomSIPSessionControl,
    ArloIntercomSIPSignalingSession,
    ArloIntercomWebRTCSessionControl,
    ArloIntercomWebRTCSignalingSession,
    RTCSignalingSession,
)

if TYPE_CHECKING:
    from .camera import ArloCamera
    from .provider import ArloProvider

class ArloIntercom(ArloDeviceBase):
    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, provider: ArloProvider, camera: ArloCamera) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, provider=provider)
        self.camera = camera

    def get_applicable_interfaces(self) -> list[str]:
        return [ScryptedInterface.RTCSignalingChannel.value]

    def get_device_type(self) -> str:
        return ScryptedDeviceType.Speaker.value

    async def startRTCSignalingSession(self, scrypted_session: RTCSignalingSession):
        try:
            self.logger.debug("Starting RTC signaling session for intercom.")
            if self.camera.uses_sip_push_to_talk:
                self.logger.debug("Using SIP push-to-talk for intercom session.")
                plugin_session = ArloIntercomSIPSignalingSession(self)
            else:
                self.logger.debug("Using WebRTC for intercom session.")
                plugin_session = ArloIntercomWebRTCSignalingSession(self)
            await plugin_session.delayed_init()
            plugin_session.scrypted_session = scrypted_session
            scrypted_setup = {
                'type': 'offer',
                'audio': {'direction': 'recvonly'},
                'configuration': {
                    'iceServers': plugin_session.ice_servers,
                    'iceCandidatePoolSize': 0,
                }
            }
            if isinstance(plugin_session, ArloIntercomWebRTCSignalingSession):
                try:
                    self.logger.debug("Creating local description with ICE candidate trickle.")
                    async def send_ice_candidate(candidate):
                        try:
                            await self.provider.arlo.notify_push_to_talk_offer_candidate(
                                self.arlo_basestation, self.arlo_device,
                                plugin_session.session_id, candidate,
                            )
                            self.logger.debug(f"Sent ICE candidate: {candidate}")
                        except Exception as e:
                            self.logger.error(f"Error sending ICE candidate: {e}", exc_info=True)
                    try:
                        scrypted_offer = await asyncio.wait_for(
                            scrypted_session.createLocalDescription('offer', scrypted_setup, send_ice_candidate),
                            timeout=3
                        )
                    except asyncio.TimeoutError:
                        self.logger.warning("Timeout waiting for ICE candidates, falling back to ignore trickle.")
                        async def ignore_trickle(c): pass
                        scrypted_offer = await scrypted_session.createLocalDescription('offer', scrypted_setup, ignore_trickle)
                    await plugin_session.setRemoteDescription(scrypted_offer)
                    self.logger.debug("Waiting for local description to be set by plugin session.")
                    while not plugin_session.local_description_set:
                        await asyncio.sleep(0.1)
                    await scrypted_session.setRemoteDescription(plugin_session.answer, scrypted_setup)
                    self.logger.debug("WebRTC signaling session established.")
                    return ArloIntercomWebRTCSessionControl(plugin_session)
                except Exception as e:
                    self.logger.error(f"Error in WebRTC signaling session: {e}", exc_info=True)
                    raise
            else:
                try:
                    try:
                        scrypted_offer = await asyncio.wait_for(
                            scrypted_session.createLocalDescription('offer', scrypted_setup),
                            timeout=3
                        )
                    except asyncio.TimeoutError:
                        self.logger.warning("Timeout waiting for ICE candidates, falling back to ignore trickle.")
                        async def ignore_trickle(c): pass
                        scrypted_offer = await scrypted_session.createLocalDescription('offer', scrypted_setup, ignore_trickle)
                    await plugin_session.setRemoteDescription(scrypted_offer)
                    plugin_answer = await plugin_session.createLocalDescription()
                    await scrypted_session.setRemoteDescription(plugin_answer, scrypted_setup)
                    self.logger.debug("SIP signaling session established.")
                    return ArloIntercomSIPSessionControl(plugin_session)
                except Exception as e:
                    self.logger.error(f"Error in SIP signaling session: {e}", exc_info=True)
                    raise
        except Exception as e:
            self.logger.error(f"Failed to start RTC signaling session: {e}", exc_info=True)
            raise

    def speaker(self):
        try:
            self.logger.debug("Getting speaker device from system manager.")
            return scrypted_sdk.systemManager.getDeviceById(self.getScryptedProperty("id"))
        except Exception as e:
            self.logger.error(f"Error getting speaker device: {e}", exc_info=True)
            raise