from __future__ import annotations

import asyncio
import json

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
from cryptography import x509
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
        self.device_state: str = 'available' if self.arlo_properties.get('state', '') == 'idle' else 'unavailable'
        self.reboot_time: datetime = datetime.now()
        self.svss: ArloSirenVirtualSecuritySystem | None = None
        self._start_device_state_subscription()
        if not self.arlo_properties:
            self.create_task(self.refresh_device())

    async def _delayed_init(self) -> None:
        await super()._delayed_init()
        for _ in range(100):
            if self.stop_subscriptions:
                return
            try:
                if self.has_local_live_streaming:
                    await self._check_certificates()
                if self.has_local_live_streaming:
                    await self._mdns()
                return
            except Exception as e:
                self.logger.debug(f'Delayed init failed for ArloBasestation {self.nativeId}, will try again: {e}')
                await asyncio.sleep(0.1)
        else:
            self.logger.error(f'Delayed init exceeded iteration limit for ArloBasestation {self.nativeId}, giving up.')
            return

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
            self.arlo_device, callback,
            event_key='device_state_subscription'
        )

    async def _check_certificates(self) -> None:
        self.logger.debug('Checking if Certificates are created with Arlo')
        if not self.peer_cert or not self.device_cert or not self.ica_cert:
            self.logger.debug('Certificates have not been created with Arlo, proceeding with Certificate Creation')
            await self._create_certificates()
            return
        if not self._check_certificate_and_key_match():
            self.logger.debug('Certificates exist but do not match the expected keys, generating new keypair and creating new certificates.')
            self.provider.generate_arlo_keypair()
            await self._create_certificates()
            return
        self.logger.debug('Certificates have been created with Arlo and match the expected keys, skipping Certificate Creation')

    def _check_certificate_and_key_match(self) -> bool:
        key_pem = self.provider.arlo_private_key
        cert_pem = self.peer_cert
        if not key_pem or not cert_pem:
            self.logger.debug('Missing certificate or private key for match check.')
            return False
        try:
            private_key = serialization.load_pem_private_key(
                key_pem.encode(), password=None, backend=default_backend()
            )
            cert_obj = x509.load_pem_x509_certificate(cert_pem.encode(), default_backend())
            pubkey_cert = cert_obj.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo
            )
            pubkey_key = private_key.public_key().public_bytes(
                serialization.Encoding.PEM,
                serialization.PublicFormat.SubjectPublicKeyInfo
            )
            match = pubkey_cert == pubkey_key
            return match
        except Exception as e:
            self.logger.warning(f'Error checking peer certificate and private key match: {e}')
            return False

    async def _create_certificates(self) -> None:
        certificates = await self.provider.arlo.create_certificates(self.arlo_basestation, ''.join(self.provider.arlo_public_key[27:-25].splitlines()))
        if certificates:
            self.logger.debug('Certificates have been created with Arlo, parsing certificates')
            self._parse_certificates(certificates)
        else:
            self.logger.error('Failed to create Certificates with Arlo')

    def _parse_certificates(self, certificates: dict) -> None:
        peerCert = certificates['certsData'][0]['peerCert']
        deviceCert = certificates['certsData'][0]['deviceCert']
        icaCert = certificates['icaCert']
        if peerCert and deviceCert and icaCert:
            self.logger.debug('Certificates have been parsed, storing certificates')
            self._store_certificates(peerCert, deviceCert, icaCert)
        else:
            if not peerCert:
                self.logger.error('Failed to parse peer Certificate')
            if not deviceCert:
                self.logger.error('Failed to parse device Certificate')
            if not icaCert:
                self.logger.error('Failed to parse ICA Certificate')

    def _store_certificates(self, peerCert: str, deviceCert: str, icaCert: str) -> None:
        peerCert = f'-----BEGIN CERTIFICATE-----\n{chr(10).join([peerCert[idx:idx+64] for idx in range(len(peerCert)) if idx % 64 == 0])}\n-----END CERTIFICATE-----'
        deviceCert = f'-----BEGIN CERTIFICATE-----\n{chr(10).join([deviceCert[idx:idx+64] for idx in range(len(deviceCert)) if idx % 64 == 0])}\n-----END CERTIFICATE-----'
        icaCert = f'-----BEGIN CERTIFICATE-----\n{chr(10).join([icaCert[idx:idx+64] for idx in range(len(icaCert)) if idx % 64 == 0])}\n-----END CERTIFICATE-----'
        self.storage.setItem('peer_cert', peerCert)
        self.storage.setItem('device_cert', deviceCert)
        self.storage.setItem('ica_cert', icaCert)
        self.logger.debug('Certificates have been stored with Scrypted')

    async def _mdns(self) -> None:
        self.storage.setItem('mdns_boolean', False)
        self.storage.setItem('ip', '')
        self.storage.setItem('host_name', '')
        self.logger.debug('Checking if Basestation is found in mDNS.')
        self.storage.setItem('mdns_boolean', bool(self.provider.mdns_services.get(self.arlo_device['deviceId'])))
        if self.mdns_boolean == True:
            self.logger.debug('Basestation found in mDNS, setting IP Address and Hostname.')
            basestation: dict = self.provider.mdns_services[self.arlo_device['deviceId']]
            self.storage.setItem('ip', basestation.get('address'))
            self.storage.setItem('host_name', basestation.get('server'))
        else:
            self.logger.error('Basestation not found in mDNS, manual input needed under basestation settings.')

    @property
    def has_siren(self) -> bool:
        return self._has_capability('Siren', 'ResourceTypes')

    @property
    def has_local_live_streaming(self) -> bool:
        return self._has_capability('supported', 'sipLiveStream') and self.provider.arlo.user_id == self.arlo_device['owner']['ownerId']

    @property
    def can_restart(self) -> bool:
        return self.provider.arlo.user_id == self.arlo_device['owner']['ownerId']

    @property
    def ip(self) -> str:
        return self.storage.getItem('ip')

    @property
    def host_name(self) -> str:
        return self.storage.getItem('host_name')

    @property
    def mdns_boolean(self) -> bool:
        return self.storage.getItem('mdns_boolean')

    @property
    def peer_cert(self) -> str:
        return self.storage.getItem('peer_cert')

    @property
    def device_cert(self) -> str:
        return self.storage.getItem('device_cert')

    @property
    def ica_cert(self) -> str:
        return self.storage.getItem('ica_cert')

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
                await self.onDeviceEvent(ScryptedInterface.DeviceProvider.value, None)
                self.logger.debug(f'Basestation {self.nativeId} and children refreshed and updated in Scrypted.')
            except Exception as e:
                self.logger.error(f'Error refreshing basestation {self.nativeId}: {e}', exc_info=True)
        except asyncio.CancelledError:
            pass

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
        if self.has_local_live_streaming:
            result.append(
                {
                    'group': 'General',
                    'key': 'ip_addr',
                    'title': 'IP Address',
                    'description': 'This is the IP Address of the basestation pulled from mDNS. ' + \
                                   'This will be used for cameras that support local streaming. ' + \
                                   'Note that the basestation must be in the same network as Scrypted for this to work. ' + \
                                   'If this is empty, it means mDNS failed to find your basestation, ' + \
                                   'You will have to input the IP Address into this field manually.',
                    'value': self.ip,
                    'readonly': self.mdns_boolean,
                },
            )
            result.append(
                {
                    'group': 'General',
                    'key': 'host_name',
                    'title': 'Hostname',
                    'description': 'This is the Hostname of the basestation pulled from mDNS. ' + \
                                   'This will be used for cameras that support local streaming. ' + \
                                   'Note that the basestation must be in the same network as Scrypted for this to work.'
                                   'If this is empty, it means mDNS failed to find your basestation, ' + \
                                   'You will have to input the Hostname into this field manually, ' + \
                                   'Usually the model including the domain, i.e. "VMB5000.local" or "VMB5000-2.local" ' + \
                                   'if you have mutliple of the same model basestation.',
                    'value': self.host_name,
                    'readonly': self.mdns_boolean,
                },
            )
        result.append(
            {
                'group': 'General',
                'key': 'print_debug',
                'title': 'Debug Info',
                'description': 'Prints information about this device to console.',
                'type': 'button',
            },
        )
        if self.can_restart:
            result.append(
                {
                    'group': 'General',
                    'key': 'restart_device',
                    'title': 'Restart Device',
                    'description': 'Restarts the Device.',
                    'type': 'button',
                },
            )
        return result

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if key == 'print_debug':
            self.logger.debug(f'Device Capabilities: {json.dumps(self.arlo_capabilities)}')
            self.logger.debug(f'Device Smart Features: {json.dumps(self.arlo_smart_features)}')
            self.logger.debug(f'Device Properties: {json.dumps(self.arlo_properties)}')
            self.logger.debug(f'Peer Certificate:\n{self.peer_cert}')
            self.logger.debug(f'Device Certificate:\n{self.device_cert}')
            self.logger.debug(f'ICA Certificate:\n{self.ica_cert}')
            self.logger.debug(f'Device State: {self.device_state}')
        elif key == 'restart_device':
            self.logger.debug('Restarting Device')
            self.reboot_time = datetime.now()
            await self.provider.arlo.restart_device(self.arlo_device['deviceId'])
        elif key in ['ip', 'host_name']:
            self.storage.setItem(key, value)
        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)