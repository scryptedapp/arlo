from __future__ import annotations

from typing import TYPE_CHECKING

from scrypted_sdk.types import OnOff, ScryptedInterface, ScryptedDeviceType

from .base import ArloDeviceBase

if TYPE_CHECKING:
    from .camera import ArloCamera
    from .provider import ArloProvider

class ArloBaseLight(ArloDeviceBase, OnOff):
    camera: ArloCamera = None

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider, camera: ArloCamera = None) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider)
        self.camera = camera

    def get_applicable_interfaces(self) -> list[str]:
        return [ScryptedInterface.OnOff.value]

    def get_device_type(self) -> str:
        return ScryptedDeviceType.Light.value

    async def turnOn(self) -> None:
        try:
            await self._set_light_state(True)
        except Exception as e:
            self.logger.error(f'Error turning on light: {e}')

    async def turnOff(self) -> None:
        try:
            await self._set_light_state(False)
        except Exception as e:
            self.logger.error(f'Error turning off light: {e}')

    async def _set_light_state(self, state: bool) -> None:
        raise NotImplementedError('Subclasses must implement _set_light_state')

class ArloSpotlight(ArloBaseLight):
    async def _set_light_state(self, state: bool) -> None:
        self.logger.info('Turning spotlight %s', 'on' if state else 'off')
        if state:
            await self.provider.arlo.spotlight_on(self.arlo_basestation, self.arlo_device)
        else:
            await self.provider.arlo.spotlight_off(self.arlo_basestation, self.arlo_device)
        self.on = state

class ArloFloodlight(ArloBaseLight):
    async def _set_light_state(self, state: bool) -> None:
        self.logger.info('Turning floodlight %s', 'on' if state else 'off')
        if state:
            await self.provider.arlo.floodlight_on(self.arlo_basestation, self.arlo_device)
        else:
            await self.provider.arlo.floodlight_off(self.arlo_basestation, self.arlo_device)
        self.on = state

class ArloNightlight(ArloBaseLight):
    def __init__(self, nativeId: str, arlo_device: dict, arlo_properties: dict, provider: ArloProvider, camera: ArloCamera = None) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_device, arlo_properties=arlo_properties, provider=provider, camera=camera)

    async def _set_light_state(self, state: bool) -> None:
        self.logger.info('Turning nightlight %s', 'on' if state else 'off')
        if state:
            await self.provider.arlo.nightlight_on(self.arlo_device)
        else:
            await self.provider.arlo.nightlight_off(self.arlo_device)
        self.on = state