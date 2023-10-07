"""Created new mvss.py based on existing vss.py and cleaned out code that was not needed for the siren."""
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
        """Sets the parent as the nativeId passed through the call from provider.py."""
        self.parent = parent
        self.create_task(self.delayed_init())

    """Storage Location for holding the location code required to pass back on the put request."""
    @property
    def mode_location(self) -> str:
        _mode_location = self.storage.getItem("mode_location")
        if _mode_location is None:
            _mode_location = ""
            self.storage.setItem("mode_location", _mode_location)
        return _mode_location

    """Storage Location for holding the revision code required to pass back on the put request."""
    @property
    def mode_revision(self) -> str:
        _mode_revision = self.storage.getItem("mode_revision")
        if _mode_revision is None:
            _mode_revision = ""
            self.storage.setItem("mode_revision", _mode_revision)
        return _mode_revision

    @property
    def mode(self) -> SecuritySystemMode:
        self.logger.info("Getting Current Arlo Security Mode")

        """Calls out to the Arlo API to get the current mode, location code, and revision number and brings them back and stores them."""
        mode_location_revision = self.provider.arlo.GetMode()
        mode: SecuritySystemMode = mode_location_revision[0]
        self.storage.setItem("mode_location", mode_location_revision[1])
        self.storage.setItem("mode_revision", str(int(mode_location_revision[2]) + 1))

        """Converts the Arlo Modes to the Homekit Modes."""
        if mode == "armAway":
            mode = SecuritySystemMode.AwayArmed.value
        elif mode == "armHome":
            mode = SecuritySystemMode.HomeArmed.value
        elif mode == "standby":
            mode = SecuritySystemMode.Disarmed.value

        """Required by Homekit to force set the mode of the Security System."""
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": mode,
        }

        if mode is None or mode not in ArloModeVirtualSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {mode}")
        return mode

    @mode.setter
    def mode(self, mode: SecuritySystemMode) -> None:
        if mode not in ArloModeVirtualSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {mode}")
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
                print(type(ArloModeVirtualSecuritySystem.SUPPORTED_MODES))
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
                "title": "Security Mode",
                "description": "Change this value to Change the Security Mode in Your Arlo App.",
                "value": self.mode,
                "choices": ArloModeVirtualSecuritySystem.SUPPORTED_MODES,
            },
        ]

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key != "mode":
            raise ValueError(f"invalid setting {key}")

        """This starts configuring the variables to go into the put request to change the Security Mode through the Arlo API."""
        self.logger.info("Setting Arlo Security Mode")

        newmode: SecuritySystemMode = value

        if newmode == SecuritySystemMode.AwayArmed.value:
            newmode = "armAway"
        elif newmode == SecuritySystemMode.HomeArmed.value:
            newmode = "armHome"
        elif newmode == SecuritySystemMode.Disarmed.value:
            newmode = "standby"

        """Calling the Arlo API put request to change the Security Mode."""
        self.provider.arlo.SetMode(newmode, self.mode_location, self.mode_revision)

        """Converting the Arlo Modes back to Homekit Modes and storing them and force setting the Security System."""
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

    """Using the same configurations of the get and set settings for the Homekit calls to arm and disarm the Security System."""
    @async_print_exception_guard
    async def armSecuritySystem(self, mode: SecuritySystemMode) -> None:
        self.logger.info("Setting Arlo Security Mode")

        newmode: SecuritySystemMode = mode

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

        newmode: SecuritySystemMode = "standby"

        self.provider.arlo.SetMode(newmode, self.mode_location, self.mode_revision)

        newmode = SecuritySystemMode.Disarmed.value

        self.storage.setItem("mode", newmode)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": newmode,
        }

        if self.mode is None or self.mode not in ArloModeVirtualSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {self.mode}")
