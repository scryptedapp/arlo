from __future__ import annotations

import asyncio

from typing import TYPE_CHECKING

import scrypted_sdk
from scrypted_sdk.types import (
    Device, DeviceProvider, Setting, Settings, SettingValue,
    SecuritySystem, SecuritySystemMode, Readme, ScryptedInterface, ScryptedDeviceType
)

from .base import ArloDeviceBase
from .siren import ArloSiren

if TYPE_CHECKING:
    from .basestation import ArloBasestation
    from .camera import ArloCamera
    from .provider import ArloProvider


class ArloBaseVirtualSecuritySystem(ArloDeviceBase, SecuritySystem, Settings, Readme):
    SUPPORTED_MODES = [
        SecuritySystemMode.AwayArmed.value,
        SecuritySystemMode.HomeArmed.value,
        SecuritySystemMode.Disarmed.value
    ]

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider, auto_init: bool = True) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider, auto_init=auto_init)
        self.task_manager = self.provider.task_manager

    async def _delayed_init(self) -> None:
        await super()._delayed_init()
        for _ in range(100):
            if self.stop_subscriptions:
                return
            try:
                if self.storage is not None:
                    break
                else:
                    await asyncio.sleep(0.1)
            except Exception as e:
                self.logger.debug(f'Delayed init failed for ArloBaseVirtualSecuritySystem  storage, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error(f'Delayed init exceeded iteration limit for ArloBaseVirtualSecuritySystem  storage, giving up.')
            return
        for _ in range(100):
            if self.stop_subscriptions:
                return
            try:
                mode = self.mode
                if mode is None or mode not in self.SUPPORTED_MODES:
                    await asyncio.sleep(0.1)
                    continue
                self.securitySystemState = {
                    'supportedModes': self.SUPPORTED_MODES,
                    'mode': mode,
                }
                return
            except Exception as e:
                self.logger.debug(f'Delayed init failed for ArloBaseVirtualSecuritySystem security system state, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error(f'Delayed init exceeded iteration limit for ArloBaseVirtualSecuritySystem security system state, giving up.')
            return

    @property
    def mode(self) -> str:
        raise NotImplementedError()

    @mode.setter
    def mode(self, mode: str) -> None:
        raise NotImplementedError()

    def get_applicable_interfaces(self) -> list[str]:
        return [
            ScryptedInterface.SecuritySystem.value,
            ScryptedInterface.DeviceProvider.value,
            ScryptedInterface.Settings.value,
            ScryptedInterface.Readme.value,
        ]

    def get_device_type(self) -> str:
        return ScryptedDeviceType.SecuritySystem.value

    async def getSettings(self) -> list[Setting]:
        return [
            {
                'key': 'mode',
                'title': 'Arm Mode',
                'description': self._mode_description(),
                'value': self.mode,
                'choices': self.SUPPORTED_MODES,
            },
        ]

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key != 'mode':
            raise ValueError(f'invalid setting {key}')
        try:
            self.storage.setItem('mode', value)
            self.securitySystemState = {
                **self.securitySystemState,
                'mode': value,
            }
            self.task_manager.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None), tag=f'settings_update:{self.nativeId}', owner=self)
        except Exception as e:
            self.logger.error(f'Error setting mode: {e}')

    async def getReadmeMarkdown(self) -> str:
        return self._readme_markdown().strip()

    def _mode_description(self) -> str:
        return 'Set the security system arm/disarm mode.'

    def _readme_markdown(self) -> str:
        return '# Virtual Security System\n\nThis is a virtual security system device.'

    async def armSecuritySystem(self, mode: SecuritySystemMode) -> None:
        if mode not in self.SUPPORTED_MODES:
            raise ValueError(f'invalid mode {mode}')
        try:
            self.logger.info(f'Arming {mode}')
            self.mode = mode
        except Exception as e:
            self.logger.error(f'Error arming security system: {e}')

    async def disarmSecuritySystem(self) -> None:
        try:
            self.logger.info('Disarming')
            self.mode = SecuritySystemMode.Disarmed.value
        except Exception as e:
            self.logger.error(f'Error disarming security system: {e}')


class ArloSirenVirtualSecuritySystem(ArloBaseVirtualSecuritySystem, DeviceProvider):
    parent: ArloBasestation | ArloCamera = None
    siren: ArloSiren | None = None

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider, parent: ArloBasestation | ArloCamera) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider)
        self.parent = parent
        self.siren = None

    @property
    def mode(self) -> str:
        mode = self.storage.getItem('mode')
        if mode is None or mode not in self.SUPPORTED_MODES:
            mode = SecuritySystemMode.Disarmed.value
        return mode

    @mode.setter
    def mode(self, mode: str) -> None:
        if mode not in self.SUPPORTED_MODES:
            raise ValueError(f'invalid mode {mode}')
        self.storage.setItem('mode', mode)
        self.securitySystemState = {
            **self.securitySystemState,
            'mode': mode,
        }
        self.task_manager.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None), tag=f'settings_update:{self.nativeId}', owner=self)

    async def putSetting(self, key: str, value: SettingValue) -> None:
        await super().putSetting(key, value)
        if self.mode == SecuritySystemMode.Disarmed.value:
            if not self.siren:
                self._create_siren()
            await self.siren.turnOff()

    def get_builtin_child_device_manifests(self) -> list[Device]:
        if not self.parent.has_siren:
            return []
        if not self.siren:
            self._create_siren()
        return [
            self.siren.get_device_manifest(
                name=f'{self.arlo_device["deviceName"]} Siren',
                interfaces=self.siren.get_applicable_interfaces(),
                device_type=self.siren.get_device_type(),
                provider_native_id=self.nativeId,
                native_id=self.siren.nativeId,
            )
        ]

    async def getDevice(self, nativeId: str) -> ArloDeviceBase:
        if not nativeId.endswith('siren'):
            return None
        if not self.siren:
            self._create_siren()
        return self.siren
    
    async def armSecuritySystem(self, mode: SecuritySystemMode) -> None:
        await super().armSecuritySystem(mode)
        if mode == SecuritySystemMode.Disarmed.value:
            if not self.siren:
                self._create_siren()
            await self.siren.turnOff()

    async def disarmSecuritySystem(self) -> None:
        await super().disarmSecuritySystem()
        if not self.siren:
                self._create_siren()
        await self.siren.turnOff()

    def _create_siren(self) -> None:
        siren_id = f'{self.arlo_device["deviceId"]}.siren'
        if not self.siren:
            self.siren = ArloSiren(siren_id, self.arlo_device, self.arlo_basestation, self.arlo_properties, self.provider, self)

    def _mode_description(self) -> str:
        return 'If disarmed, the associated siren will not be physically triggered even if toggled.'

    def _readme_markdown(self) -> str:
        return """
# Virtual Security System for Arlo Sirens

This device is a virtual security system provided by the Arlo Scrypted plugin. It grants Arm/Disarm semantics to help prevent accidental or unwanted triggering of the real physical siren through integrations such as HomeKit.

When the system is Disarmed, any triggers of the siren will be ignored. To allow the siren to trigger, set the Arm Mode to any of the Armed options. Changing the mode only affects this Scrypted device and does not modify your Arlo cloud or account settings.

If synced to HomeKit, the siren will appear as a switch within the same security system accessory. To use the siren as a standalone switch, disable syncing of the virtual security system and enable syncing of the siren, then manually arm the virtual security system in Scrypted.
""".strip()


class ArloModeVirtualSecuritySystem(ArloBaseVirtualSecuritySystem):
    ARLO_TO_SCRYPTED = {
        'armAway': SecuritySystemMode.AwayArmed.value,
        'armHome': SecuritySystemMode.HomeArmed.value,
        'standby': SecuritySystemMode.Disarmed.value,
    }
    SCRYPTED_TO_ARLO = {v: k for k, v in ARLO_TO_SCRYPTED.items()}
    _init_completed: bool = False

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider, auto_init=False)
        self._ready_event.set()

    def complete_init(self) -> None:
        if self._init_completed:
            return
        self.task_manager.create_task(self._delayed_init(), tag=f'delayed_init:{self.nativeId}', owner=self)

    async def _delayed_init(self) -> None:
        for _ in range(100):
            try:
                scrypted_sdk.deviceManager.getDeviceState(self.nativeId)
                break
            except Exception as e:
                self.logger.debug(f'Delayed init failed for ArloModeVirtualSecuritySystem device state, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error(f'Delayed init exceeded iteration limit for ArloModeVirtualSecuritySystem device state, giving up.')
            return
        for _ in range(100):
            if self.stop_subscriptions:
                return
            try:
                self.securitySystemState = {
                    'supportedModes': self.SUPPORTED_MODES,
                    'mode': self.mode,
                }
                mode, revision = await self._get_initial_mode_and_revision()
                self._set_mode_and_revision(mode, revision)
                self._start_active_mode_subscription()
                self._init_completed = True
                return
            except Exception as e:
                self.logger.debug(f'Delayed init failed for ArloModeVirtualSecuritySystem security system state, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error(f'Delayed init exceeded iteration limit for ArloModeVirtualSecuritySystem security system state, giving up.')
            return

    async def _get_initial_mode_and_revision(self):
        resp = await self.provider.arlo.get_mode_and_revision()
        if self.provider.one_location:
            properties: dict = resp.get('properties')
            mode = properties.get('mode')
            revision = resp.get('revision')
        else:
            if self.location not in resp:
                raise KeyError(f'Location "{self.location}" not found in response: {resp}')
            location: dict = resp[self.location]
            properties: dict = location.get('properties')
            mode = properties.get('mode')
            revision = location.get('revision')
        if mode is None or revision is None:
            raise RuntimeError(f'Mode or revision missing in response: {resp}')
        return mode, revision

    def _set_mode_and_revision(self, arlo_mode: str, revision: str):
        scrypted_mode = self._arlo_to_scrypted_mode(arlo_mode)
        self.securitySystemState = {
            'supportedModes': self.SUPPORTED_MODES,
            'mode': scrypted_mode,
        }
        self.mode = scrypted_mode
        self.next_revision = str(int(revision) + 1)

    def _start_active_mode_subscription(self) -> None:
        def callback(mode_and_revision: dict):
            arlo_mode = mode_and_revision['properties']['mode']
            revision = mode_and_revision['revision']
            self._set_mode_and_revision(arlo_mode, revision)
            return self.stop_subscriptions
        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_active_mode_events,
            self.location, callback,
            event_key='active_mode_subscription'
        )

    @property
    def location(self) -> str:
        return self.nativeId.replace('.mvss', '')

    def _arlo_to_scrypted_mode(self, arlo_mode: str) -> str:
        return self.ARLO_TO_SCRYPTED.get(arlo_mode, arlo_mode)

    def _scrypted_to_arlo_mode(self, scrypted_mode: str) -> str:
        return self.SCRYPTED_TO_ARLO.get(scrypted_mode, scrypted_mode)

    @property
    def mode(self) -> str:
        mode = self.storage.getItem('mode')
        return self._arlo_to_scrypted_mode(mode)

    @mode.setter
    def mode(self, scrypted_mode: str) -> None:
        if scrypted_mode not in self.SUPPORTED_MODES:
            raise ValueError(f'invalid mode {scrypted_mode}')
        arlo_mode = self._scrypted_to_arlo_mode(scrypted_mode)
        self.storage.setItem('mode', arlo_mode)
        self.securitySystemState = {
            **self.securitySystemState,
            'mode': scrypted_mode,
        }
        self.task_manager.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None), tag=f'settings_update:{self.nativeId}', owner=self)

    @property
    def next_revision(self) -> str:
        return self.storage.getItem('next_revision')

    @next_revision.setter
    def next_revision(self, next_revision: str) -> None:
        self.storage.setItem('next_revision', next_revision)

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key != 'mode':
            raise ValueError(f'invalid setting {key}')
        self.logger.info(f'Setting Arlo Security Mode to {value}')
        arlo_mode = self._scrypted_to_arlo_mode(value)
        await self.provider.arlo.set_mode(arlo_mode, self.location, self.next_revision)
        self.mode = value
        if self.mode is None or self.mode not in self.SUPPORTED_MODES:
            raise ValueError(f'invalid mode {self.mode}')

    async def armSecuritySystem(self, mode: SecuritySystemMode) -> None:
        self.logger.info(f'Setting Arlo Security Mode to {mode}')
        arlo_mode = self._scrypted_to_arlo_mode(mode)
        await self.provider.arlo.set_mode(arlo_mode, self.location, self.next_revision)
        self.mode = mode
        if self.mode is None or self.mode not in self.SUPPORTED_MODES:
            raise ValueError(f'invalid mode {self.mode}')

    async def disarmSecuritySystem(self) -> None:
        self.logger.info(f'Setting Arlo Security Mode to {SecuritySystemMode.Disarmed.value}')
        arlo_mode = self._scrypted_to_arlo_mode(SecuritySystemMode.Disarmed.value)
        await self.provider.arlo.set_mode(arlo_mode, self.location, self.next_revision)
        self.mode = SecuritySystemMode.Disarmed.value
        if self.mode is None or self.mode not in self.SUPPORTED_MODES:
            raise ValueError(f'invalid mode {self.mode}')

    def _mode_description(self) -> str:
        return 'Change this value to change the Security Mode in your Arlo App.'

    def _readme_markdown(self) -> str:
        return """
# Virtual Security System for Arlo Security Modes

This device is a virtual security system provided by the Arlo Scrypted plugin. It allows you to control the Arm Away, Arm Home, and Disarm modes of your Arlo system through integrations such as HomeKit.

Changing the mode on this device will update the security mode in your Arlo cloud account, which may affect automations or routines you have configured in the Arlo app. Use this device to synchronize your Arlo security modes with your smart home integrations.
""".strip()