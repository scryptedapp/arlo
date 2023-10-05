from __future__ import annotations

import asyncio
from typing import List, TYPE_CHECKING

from scrypted_sdk.types import Device, DeviceProvider, Setting, Settings, SettingValue, SecuritySystem, SecuritySystemMode, Readme, ScryptedInterface, ScryptedDeviceType

from .base import ArloDeviceBase
from .util import async_print_exception_guard

if TYPE_CHECKING:
    # https://adamj.eu/tech/2021/05/13/python-type-hints-how-to-fix-circular-imports/
    from .provider import ArloProvider

class ArloModeVirtualSecuritySystem(ArloDeviceBase, SecuritySystem, Settings, Readme, DeviceProvider):
    """A virtual, emulated security system that controls the Routines Mode in the Arlo App."""

    SUPPORTED_MODES = [SecuritySystemMode.AwayArmed.value, SecuritySystemMode.HomeArmed.value, SecuritySystemMode.Disarmed.value]

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, provider: ArloProvider, parent: str) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, provider=provider)
        self.parent = parent
        self.create_task(self.delayed_init())

    @property
    def mode_location(self) -> str:
        _mode_location = self.storage.getItem("mode_location")
        if _mode_location is None:
            _mode_location = ""
            self.storage.setItem("mode_location", _mode_location)
        return _mode_location

    @property
    def mode_revision(self) -> str:
        _mode_revision = self.storage.getItem("mode_revision")
        if _mode_revision is None:
            _mode_revision = ""
            self.storage.setItem("mode_revision", _mode_revision)
        return _mode_revision

    @property
    def mode(self) -> str:
        self.logger.info("Getting Current Arlo Security Mode")

        mode_location_revision = self.provider.arlo.GetMode()
        mode = mode_location_revision[0]
        self.storage.setItem("mode_location", mode_location_revision[1])
        self.storage.setItem("mode_revision", str(int(mode_location_revision[2]) + 1))

        if mode == "armAway":
            mode = SecuritySystemMode.AwayArmed.value
        elif mode == "armHome":
            mode = SecuritySystemMode.HomeArmed.value
        elif mode == "standby":
            mode = SecuritySystemMode.Disarmed.value

        self.securitySystemState = {
            **self.securitySystemState,
            "mode": mode,
        }

        if mode is None or mode not in ArloModeVirtualSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {mode}")
        return mode

    @mode.setter
    def mode(self, mode: str) -> None:
        self.storage.setItem("mode", mode)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": mode,
        }
        self.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None))

    async def delayed_init(self) -> None:
        iterations = 1
        while not self.stop_subscriptions:
            if iterations > 100:
                self.logger.error("Delayed init exceeded iteration limit, giving up")
                return

            try:
                self.securitySystemState = {
                    "supportedModes": ArloModeVirtualSecuritySystem.SUPPORTED_MODES,
                    "mode": self.mode,
                }
                return
            except Exception as e:
                self.logger.debug(f"Delayed init failed, will try again: {e}")
                await asyncio.sleep(0.1)
            iterations += 1

    def get_applicable_interfaces(self) -> List[str]:
        return [
            ScryptedInterface.SecuritySystem.value,
            ScryptedInterface.DeviceProvider.value,
            ScryptedInterface.Settings.value,
            ScryptedInterface.Readme.value,
        ]

    def get_device_type(self) -> str:
        return ScryptedDeviceType.SecuritySystem.value

    async def getSettings(self) -> List[Setting]:
        return [
            {
                "key": "mode",
                "title": "Arm Mode",
                "description": "Change this value to Change the Mode in Your Arlo App.",
                "value": self.mode,
                "choices": ArloModeVirtualSecuritySystem.SUPPORTED_MODES,
            },
        ]

    @async_print_exception_guard
    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key != "mode":
            raise ValueError(f"invalid setting {key}")

        self.logger.info("Setting Arlo Security Mode")

        newmode = value

        if newmode == SecuritySystemMode.AwayArmed.value:
            newmode = "armAway"
        elif newmode == SecuritySystemMode.HomeArmed.value:
            newmode = "armHome"
        elif newmode == SecuritySystemMode.Disarmed.value:
            newmode = "standby"

        self.provider.arlo.SetMode(newmode, self.mode_location, self.mode_revision)

        if newmode == "armAway":
            newmode = SecuritySystemMode.AwayArmed.value
        elif newmode == "armHome":
            newmode = SecuritySystemMode.HomeArmed.value
        elif newmode == "standby":
            newmode = SecuritySystemMode.Disarmed.value

        self.storage.setItem("mode", newmode)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": newmode,
        }

        if self.mode is None or self.mode not in ArloModeVirtualSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {self.mode}")

    async def getReadmeMarkdown(self) -> str:
        return """
# Virtual Security System for Arlo Security Modes

This security system device is not a real physical device, but a virtual, emulated device provided by the Arlo Scrypted plugin. Its purpose is to grant security system semantics of Arm Away/Arm Home/Disarm of the Arlo App Routines through integrations such as Homekit.

Making changes to this device will perform changes to Arlo cloud and your Arlo account, it is possible that in using this device that you can change the mode outside of the Arlo App which will affect any automations or routines you have.
""".strip()

    @async_print_exception_guard
    async def armSecuritySystem(self, mode: SecuritySystemMode) -> None:
        self.logger.info("Setting Arlo Security Mode")

        newmode = mode

        if newmode == SecuritySystemMode.AwayArmed.value:
            newmode = "armAway"
        elif newmode == SecuritySystemMode.HomeArmed.value:
            newmode = "armHome"
        elif newmode == SecuritySystemMode.Disarmed.value:
            newmode = "standby"

        self.provider.arlo.SetMode(newmode, self.mode_location, self.mode_revision)

        if newmode == "armAway":
            newmode = SecuritySystemMode.AwayArmed.value
        elif newmode == "armHome":
            newmode = SecuritySystemMode.HomeArmed.value
        elif newmode == "standby":
            newmode = SecuritySystemMode.Disarmed.value

        self.storage.setItem("mode", newmode)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": newmode,
        }

        if self.mode is None or self.mode not in ArloModeVirtualSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {self.mode}")

    @async_print_exception_guard
    async def disarmSecuritySystem(self) -> None:
        self.logger.info("Setting Arlo Security Mode")

        newmode = "standby"

        self.provider.arlo.SetMode(newmode, self.mode_location, self.mode_revision)

        newmode = SecuritySystemMode.Disarmed.value

        self.storage.setItem("mode", newmode)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": newmode,
        }

        if self.mode is None or self.mode not in ArloModeVirtualSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {self.mode}")
