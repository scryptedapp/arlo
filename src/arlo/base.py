from __future__ import annotations

import asyncio

from typing import TYPE_CHECKING

from scrypted_sdk import ScryptedDeviceBase
from scrypted_sdk.types import Device

from .logging import ScryptedDeviceLoggerMixin
from .util import BackgroundTaskMixin

if TYPE_CHECKING:
    from .provider import ArloProvider

class ArloDeviceBase(ScryptedDeviceBase, ScryptedDeviceLoggerMixin, BackgroundTaskMixin):
    nativeId: str = None
    arlo_device: dict = None
    arlo_basestation: dict = None
    arlo_properties: dict = None
    arlo_capabilities: dict = None
    arlo_smart_features: dict = None
    provider: ArloProvider = None
    stop_subscriptions: bool | None = None

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider, auto_init: bool = True) -> None:
        super().__init__(nativeId=nativeId)
        self.logger_name = nativeId
        self.nativeId = nativeId
        self.arlo_device = arlo_device
        self.arlo_basestation = arlo_basestation
        self.arlo_properties = arlo_properties
        self.provider = provider
        self.logger.setLevel(self.provider.get_current_log_level())
        self._ready_event = asyncio.Event()
        if auto_init:
            self.create_task(self._delayed_init())

    def __del__(self) -> None:
        self.stop_subscriptions = True
        self.cancel_pending_tasks()
        self._cleanup()

    async def _delayed_init(self) -> None:
        for _ in range(100):
            if self.stop_subscriptions:
                return
            try:
                await self._load_device_capabilities_and_smart_features()
                self._ready_event.set()
                return
            except Exception as e:
                self.logger.debug(f'Delayed init failed for ArloBaseDevice {self.nativeId}, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error(f'Delayed init exceeded iteration limit for ArloBaseDevice {self.nativeId}, giving up.')
            self._ready_event.set()
            return

    async def _load_device_capabilities_and_smart_features(self):
        if self.nativeId.endswith('mvss'):
            self.arlo_capabilities = {}
            self.arlo_smart_features = {}
            return
        try:
            self.arlo_capabilities = await self.provider.arlo.get_device_capabilities(self.arlo_device)
            self.arlo_smart_features = await self.provider.arlo.get_device_smart_features(self.arlo_device)
        except Exception as e:
            self.logger.warning(f'Could not load device capabilities and smart features: {e}')
            self.arlo_capabilities = {}
            self.arlo_smart_features = {}

    async def wait_for_ready(self) -> None:
        await self._ready_event.wait()

    def get_applicable_interfaces(self) -> list[str]:
        return []

    def get_device_type(self) -> str:
        return ''

    def get_device_manifest(
        self,
        name: str = None,
        interfaces: list = None,
        device_type: str = None,
        provider_native_id: str = None,
        info_overrides: dict = None,
        native_id: str = None,
    ) -> Device:
        if not provider_native_id:
            provider_native_id = None
            parent_id = self.arlo_device.get('parentId')
            device_id = self.arlo_device.get('deviceId')
            if parent_id and parent_id != device_id:
                provider_native_id = parent_id
            if provider_native_id in getattr(self.provider, 'hidden_device_ids', []):
                provider_native_id = None
        info = {
            'model': f'{self.arlo_device["modelId"]} {str(self.arlo_properties.get("hwVersion", "")).replace(self.arlo_device.get("modelId", ""), "") if self.arlo_properties else ""}'.strip(),
            'manufacturer': 'Arlo',
            'firmware': self.arlo_device.get('firmwareVersion'),
            'serialNumber': self.arlo_device['deviceId'],
        } if not self.nativeId.endswith('mvss') else info_overrides
        return {
            'info': info,
            'nativeId': native_id or self.arlo_device['deviceId'],
            'name': name or self.arlo_device['deviceName'],
            'interfaces': interfaces or self.get_applicable_interfaces(),
            'type': device_type or self.get_device_type(),
            'providerNativeId': provider_native_id,
        }

    def get_builtin_child_device_manifests(self) -> list[Device]:
        return []

    async def refresh_device(self) -> None:
        return None

    def _create_or_register_event_subscription(self, subscribe_fn, *args, **kwargs):
        result = subscribe_fn(*args, **kwargs)
        if asyncio.iscoroutine(result):
            self.create_task(result)
        elif isinstance(result, asyncio.Task):
            self.register_task(result)
        elif isinstance(result, (list, tuple, set)):
            for task in result:
                if asyncio.iscoroutine(task):
                    self.create_task(task)
                elif isinstance(task, asyncio.Task):
                    self.register_task(task)
                else:
                    raise TypeError('Event Subscription must return a coroutine or task.')
        elif isinstance(result, asyncio.Future):
            self.register_task(result)
        else:
            raise TypeError('Event Subscription must return a coroutine, task, or collection of them.')

    def _has_feature(self, feature: str) -> bool:
        if not self.arlo_smart_features:
            return False

        smartfeatures: dict = self.arlo_smart_features.get('planFeatures', {})
        return smartfeatures.get(feature, False)

    def _has_capability(self, capability: str, subCapability: str = None, subSubCapability: str = None) -> bool:
        if not self.arlo_capabilities:
            return False

        capabilities: dict = self.arlo_capabilities.get('Capabilities', {})

        if subCapability:
            capabilities = capabilities.get(subCapability, {})
        if subSubCapability:
            capabilities = capabilities.get(subSubCapability, {})

        return capability in capabilities
    
    def _get_capability(self, capability: str, subCapability: str = None, subSubCapability: str = None) -> str | dict | None:
        if not self.arlo_capabilities:
            return None

        capabilities: dict = self.arlo_capabilities.get('Capabilities', {})

        if subCapability:
            capabilities = capabilities.get(subCapability, {})
        if subSubCapability:
            capabilities = capabilities.get(subSubCapability, {})

        return capabilities.get(capability, None)

    def _cleanup(self) -> None:
        pass