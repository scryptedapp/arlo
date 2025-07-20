from __future__ import annotations

from typing import TYPE_CHECKING

from scrypted_sdk.types import BinarySensor, ScryptedInterface, ScryptedDeviceType

from .camera import ArloCamera

if TYPE_CHECKING:
    from .provider import ArloProvider

class ArloDoorbell(ArloCamera, BinarySensor):
    def __init__(self, nativeId: str, arlo_device: dict, arlo_basestation: dict, arlo_properties: dict, provider: ArloProvider) -> None:
        super().__init__(nativeId=nativeId, arlo_device=arlo_device, arlo_basestation=arlo_basestation, arlo_properties=arlo_properties, provider=provider)
        self._start_doorbell_subscription()

    def _start_doorbell_subscription(self) -> None:
        def callback(doorbell_pressed):
            self.binaryState = doorbell_pressed
            return self.stop_subscriptions

        self._create_or_register_event_subscription(
            self.provider.arlo.subscribe_to_doorbell_events,
            self.arlo_device, callback,
            event_key='doorbell_subscription'
        )

    def get_device_type(self) -> str:
        return ScryptedDeviceType.Doorbell.value

    def get_applicable_interfaces(self) -> list[str]:
        camera_interfaces = super().get_applicable_interfaces()
        if ScryptedInterface.BinarySensor.value not in camera_interfaces:
            camera_interfaces.append(ScryptedInterface.BinarySensor.value)
        return camera_interfaces