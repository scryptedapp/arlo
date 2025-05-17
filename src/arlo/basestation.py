from __future__ import annotations

import json

from typing import TYPE_CHECKING

from scrypted_sdk import ScryptedDeviceBase
from scrypted_sdk.types import Device, DeviceProvider, Setting, SettingValue, Settings, ScryptedInterface, ScryptedDeviceType

from .base import ArloDeviceBase
from .vss import ArloBaseVirtualSecuritySystem, ArloSirenVirtualSecuritySystem

if TYPE_CHECKING:
    from .provider import ArloProvider

class ArloBasestation(ArloDeviceBase, DeviceProvider, Settings):
    svss: ArloBaseVirtualSecuritySystem | None = None

    def __init__(self, nativeId: str, arlo_basestation: dict, provider: ArloProvider) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_basestation, arlo_basestation=arlo_basestation, provider=provider)
        self.svss = None

    @property
    def has_siren(self) -> bool:
        return self._has_capability('Siren', 'ResourceTypes')

    def get_applicable_interfaces(self) -> list[str]:
        return [
            ScryptedInterface.DeviceProvider.value,
            ScryptedInterface.Settings.value,
        ]

    def get_device_type(self) -> str:
        return ScryptedDeviceType.DeviceProvider.value

    def get_builtin_child_device_manifests(self) -> list[Device]:
        if not self.has_siren:
            return []
        if not self.svss:
            self._create_svss()
        manifests = [
            self.svss.get_device_manifest(
                name=f'{self.arlo_device["deviceName"]} Siren Virtual Security System',
                interfaces=self.svss.get_applicable_interfaces(),
                device_type=self.svss.get_device_type(),
                provider_native_id=self.nativeId,
                native_id=self.svss.nativeId,
            )
        ]
        manifests.extend(self.svss.get_builtin_child_device_manifests())
        return manifests

    async def getDevice(self, nativeId: str) -> ScryptedDeviceBase:
        if not nativeId.startswith(self.nativeId):
            return await self.provider.getDevice(nativeId)
        if not nativeId.endswith('svss'):
            return None
        if not self.svss:
            self._create_svss()
        return self.svss

    def _create_svss(self) -> None:
        svss_id = f'{self.arlo_device["deviceId"]}.svss'
        if not self.svss:
            self.svss = ArloSirenVirtualSecuritySystem(svss_id, self.arlo_device, self.arlo_basestation, self.provider, self)

    async def getSettings(self) -> list[Setting]:
        return [
            {
                'group': 'General',
                'key': 'print_debug',
                'title': 'Debug Info',
                'description': 'Prints information about this device to console.',
                'type': 'button',
            }
        ]

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key == 'print_debug':
            self.logger.info(f'Device Capabilities: {json.dumps(self.arlo_capabilities)}')
            self.logger.info(f'Device Smart Features: {json.dumps(self.arlo_smart_features)}')
        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)