from __future__ import annotations

from typing import TYPE_CHECKING

from scrypted_sdk.types import OnOff, SecuritySystemMode, ScryptedInterface, ScryptedDeviceType

from .base import ArloDeviceBase

if TYPE_CHECKING:
    from .basestation import ArloBasestation
    from .provider import ArloProvider
    from .vss import ArloSirenVirtualSecuritySystem

class ArloSiren(ArloDeviceBase, OnOff):
    svss: ArloSirenVirtualSecuritySystem = None

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider, svss: ArloSirenVirtualSecuritySystem) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider)
        self.svss = svss

    def get_applicable_interfaces(self) -> list[str]:
        return [ScryptedInterface.OnOff.value]

    def get_device_type(self) -> str:
        return ScryptedDeviceType.Siren.value

    async def turnOn(self) -> None:
        try:
            self.logger.info('Turning on')
            if self.svss.securitySystemState.get('mode') == SecuritySystemMode.Disarmed.value:
                self.logger.info('Virtual security system is disarmed, ignoring trigger')
                self.on = True
                self.on = False
                self.svss.securitySystemState = {
                    **self.svss.securitySystemState,
                    'triggered': False,
                }
                return
            if isinstance(self.svss.parent, ArloBasestation):
                self.logger.debug('Parent device is a basestation')
                await self.provider.arlo.siren_on(self.arlo_basestation)
            else:
                self.logger.debug('Parent device is a camera')
                await self.provider.arlo.siren_on(self.arlo_basestation, self.arlo_device)
            self.on = True
            self.svss.securitySystemState = {
                **self.svss.securitySystemState,
                'triggered': True,
            }
        except Exception as e:
            self.logger.error(f'Error turning on siren: {e}')

    async def turnOff(self) -> None:
        try:
            self.logger.info('Turning off')
            if isinstance(self.svss.parent, ArloBasestation):
                await self.provider.arlo.siren_off(self.arlo_basestation)
            else:
                await self.provider.arlo.siren_off(self.arlo_basestation, self.arlo_device)
            self.on = False
            self.svss.securitySystemState = {
                **self.svss.securitySystemState,
                'triggered': False,
            }
        except Exception as e:
            self.logger.error(f'Error turning off siren: {e}')