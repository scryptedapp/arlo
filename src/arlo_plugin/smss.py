"""Created new smss.py based on existing vss.py and cleaned out code that was not needed for the siren."""
from __future__ import annotations

import asyncio
from typing import List, TYPE_CHECKING

from scrypted_sdk.types import Device, DeviceProvider, Setting, Settings, SettingValue, SecuritySystem, SecuritySystemMode, Readme, ScryptedInterface, ScryptedDeviceType

from .base import ArloDeviceBase
from .util import async_print_exception_guard

if TYPE_CHECKING:
    # https://adamj.eu/tech/2021/05/13/python-type-hints-how-to-fix-circular-imports/
    from .provider import ArloProvider

class ArloSecurityModeSecuritySystem(ArloDeviceBase, SecuritySystem, Settings, Readme, DeviceProvider):
    """A security system that controls the Active Security Mode in the Arlo App."""

    SUPPORTED_MODES = [SecuritySystemMode.AwayArmed.value, SecuritySystemMode.HomeArmed.value, SecuritySystemMode.Disarmed.value]

    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, provider: ArloProvider, parent: str) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, provider=provider)
        """Sets the parent as the nativeId passed through the call from provider.py."""
        self.parent = parent
        self.create_task(self.delayed_init())

    """Storage Location for holding the location code required to pass back on the put request."""
    @property
    def location(self) -> str:
        location = self.provider.arlo.GetLocation()
        return location

    @location.setter
    def location(self, location: str) -> None:
        self.storage.setItem("location", location)

    """Storage Location for holding the next revision code required to pass back on the put request."""
    @property
    def next_revision(self) -> str:
        next_revision = str(int(self.provider.arlo.GetNextRevision()) + 1)
        return next_revision

    @next_revision.setter
    def next_revision(self, next_revision: str) -> None:
        self.storage.setItem("next_revision", next_revision)

    """Storage Location for holding the current security mode from the Arlo API."""
    @property
    def mode(self) -> str:
        mode = self.provider.arlo.GetCurrentMode()

        """Converts the Arlo Modes to the Homekit Modes."""
        if mode == "armAway":
            mode = SecuritySystemMode.AwayArmed.value
        elif mode == "armHome":
            mode = SecuritySystemMode.HomeArmed.value
        elif mode == "standby":
            mode = SecuritySystemMode.Disarmed.value

        if mode is None or mode not in ArloSecurityModeSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {mode}")
        return mode

    @mode.setter
    def mode(self, mode: str) -> None:
        if mode not in ArloSecurityModeSecuritySystem.SUPPORTED_MODES:
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
                """Check if securitySystemState is initialized and wait if it is not ready."""
                if self.securitySystemState is None:
                    await asyncio.sleep(0.1)
                self.securitySystemState = {
                    "supportedModes": ArloSecurityModeSecuritySystem.SUPPORTED_MODES,
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
                "title": "Arlo Security Mode",
                "description": "Change this value to Change the Security Mode in Your Arlo App.",
                "value": self.mode,
                "choices": ArloSecurityModeSecuritySystem.SUPPORTED_MODES,
            },
        ]

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key != "mode":
            raise ValueError(f"invalid setting {key}")

        """This starts configuring the variables to go into the put request to change the Security Mode through the Arlo API."""
        self.logger.info(f"Setting Arlo Security Mode to {value}")

        if value == SecuritySystemMode.AwayArmed.value:
            setmode: SecuritySystemMode = "armAway"
        elif value == SecuritySystemMode.HomeArmed.value:
            setmode: SecuritySystemMode = "armHome"
        elif value == SecuritySystemMode.Disarmed.value:
            setmode: SecuritySystemMode = "standby"

        """Calling the Arlo API put request to change the Security Mode."""
        self.provider.arlo.SetMode(setmode, self.location, self.next_revision)

        self.storage.setItem("mode", value)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": value,
        }

        if self.mode is None or self.mode not in ArloSecurityModeSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {self.mode}")

        self.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None))

    async def getReadmeMarkdown(self) -> str:
        return """
# Security System for Arlo Security Modes

This security system device is provided by the Arlo Scrypted plugin. Its purpose is to grant security system semantics of Arm Away/Arm Home/Standby of the Arlo App Security Modes through integrations such as Homekit.

Making changes to this device will perform changes to Arlo cloud and your Arlo account, it is possible that in using this device that you can change the security mode outside of the Arlo App which will affect any automations or routines you have configured in the Arlo App.
""".strip()

    """Using the same configurations of the get and set settings for the Homekit calls to arm and disarm the Security System."""
    @async_print_exception_guard
    async def armSecuritySystem(self, mode: SecuritySystemMode) -> None:
        self.logger.info(f"Setting Arlo Security Mode to {mode}")

        if mode == SecuritySystemMode.AwayArmed.value:
            setmode: SecuritySystemMode = "armAway"
        elif mode == SecuritySystemMode.HomeArmed.value:
            setmode: SecuritySystemMode = "armHome"

        self.provider.arlo.SetMode(setmode, self.location, self.next_revision)

        self.storage.setItem("mode", mode)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": mode,
        }

        if self.mode is None or self.mode not in ArloSecurityModeSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {self.mode}")

        self.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None))

    @async_print_exception_guard
    async def disarmSecuritySystem(self) -> None:
        self.logger.info(f"Setting Arlo Security Mode to {SecuritySystemMode.Disarmed.value}")

        setmode: SecuritySystemMode = "standby"

        self.provider.arlo.SetMode(setmode, self.location, self.next_revision)

        self.storage.setItem("mode", SecuritySystemMode.Disarmed.value)
        self.securitySystemState = {
            **self.securitySystemState,
            "mode": SecuritySystemMode.Disarmed.value,
        }

        if self.mode is None or self.mode not in ArloSecurityModeSecuritySystem.SUPPORTED_MODES:
            raise ValueError(f"invalid mode {self.mode}")

        self.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None))
