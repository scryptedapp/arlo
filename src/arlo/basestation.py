from __future__ import annotations

import asyncio
import json

from datetime import datetime, timedelta
from typing import TYPE_CHECKING

import scrypted_sdk
from scrypted_sdk import ScryptedDeviceBase
from scrypted_sdk.types import Device, DeviceProvider, Setting, SettingValue, Settings, ScryptedInterface, ScryptedDeviceType

from .base import ArloDeviceBase
from .vss import ArloSirenVirtualSecuritySystem

if TYPE_CHECKING:
    from .provider import ArloProvider

class ArloBasestation(ArloDeviceBase, DeviceProvider, Settings):
    device_state: str = None
    reboot_time: datetime = None
    svss: ArloSirenVirtualSecuritySystem | None = None

    def __init__(self, nativeId: str, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_basestation, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider)
        self.device_state = 'available' if self.arlo_properties.get('state', '') == 'idle' else 'unavailable'
        self.reboot_time = datetime.now()
        self.svss = None
        self._start_device_state_subscription()
        if not self.arlo_properties:
            self.create_task(self.refresh_device())

    def _start_device_state_subscription(self) -> None:
        def callback(device_state: str):
            if device_state == 'available' and self.reboot_time and datetime.now() - self.reboot_time < timedelta(seconds=30):
                return self.stop_subscriptions
            self.device_state = device_state
            if device_state == 'available':
                self.reboot_time = None
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_device_state_events,
            self.arlo_device, callback
        )

    @property
    def has_siren(self) -> bool:
        return self._has_capability('Siren', 'ResourceTypes')

    @property
    def can_restart(self) -> bool:
        return self.provider.arlo.user_id == self.arlo_device["owner"]["ownerId"]

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
    
    async def refresh_device(self):
        try:
            try:
                self.arlo_properties = await self.provider._get_device_properties(self.arlo_device)
                if self.has_siren:
                    if not self.svss:
                        self._create_svss()
                    if self.svss:
                        self.svss.arlo_properties = self.arlo_properties
                        if hasattr(self.svss, 'siren') and self.svss.siren:
                            self.svss.siren.arlo_properties = self.arlo_properties
                manifests = [self.get_device_manifest()]
                manifests.extend(self.get_builtin_child_device_manifests())
                for manifest in manifests:
                    await scrypted_sdk.deviceManager.onDeviceDiscovered(manifest)
                self.logger.info(f"Basestation {self.nativeId} and children refreshed and updated in Scrypted.")
            except Exception as e:
                self.logger.error(f"Error refreshing basestation {self.nativeId}: {e}", exc_info=True)
        except asyncio.CancelledError:
            self.logger.info("Device refresh task cancelled.")

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
            self.svss = ArloSirenVirtualSecuritySystem(svss_id, self.arlo_device, self.arlo_basestation, self.arlo_properties, self.provider, self)

    async def getSettings(self) -> list[Setting]:
        result = []
        result.append(
            {
                "group": "General",
                "key": "print_debug",
                "title": "Debug Info",
                "description": "Prints information about this device to console.",
                "type": "button",
            },
        )
        if self.can_restart:
            result.append(
                {
                    "group": "General",
                    "key": "restart_device",
                    "title": "Restart Device",
                    "description": "Restarts the Device.",
                    "type": "button",
                },
            )
        return result

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key == 'print_debug':
            self.logger.info(f'Device Capabilities: {json.dumps(self.arlo_capabilities)}')
            self.logger.info(f'Device Smart Features: {json.dumps(self.arlo_smart_features)}')
            self.logger.info(f'Device Properties: {json.dumps(self.arlo_properties)}')
            self.logger.info(f'Device State: {self.device_state}')
        elif key == "restart_device":
            self.logger.info("Restarting Device")
            self.reboot_time = datetime.now()
            await self.provider.arlo.restart_device(self.arlo_device["deviceId"])
        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)