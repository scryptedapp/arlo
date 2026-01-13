import aiohttp
import asyncio
import email
import email.utils
import imaplib
import logging
import random
import re
import requests
import time
import uuid

from bs4 import BeautifulSoup
from collections import defaultdict, OrderedDict
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime
from typing import Any, Awaitable, Callable

import scrypted_sdk
from scrypted_sdk import ScryptedDeviceBase
from scrypted_sdk.types import (
    DeviceProvider,
    ScryptedDeviceType,
    ScryptedInterface,
    Setting,
    SettingValue,
    Settings,
)

from .base import ArloDeviceBase
from .basestation import ArloBasestation
from .camera import ArloCamera
from .client import ArloClient, ArloAsyncBrowser
from .doorbell import ArloDoorbell
from .logging import ScryptedDeviceLoggerMixin, StdoutLoggerFactory
from .vss import ArloModeVirtualSecuritySystem
from .util import TaskManager


DEVICE_TYPE_BASESTATION = 'basestation'
DEVICE_TYPE_SIREN = 'siren'
DEVICE_TYPE_CAMERA = 'camera'
DEVICE_TYPE_ARLOQ = 'arloq'
DEVICE_TYPE_ARLOQS = 'arloqs'
DEVICE_TYPE_DOORBELL = 'doorbell'
PLUGIN_VERSION = 1


class ArloProvider(
    DeviceProvider,
    ScryptedDeviceBase,
    ScryptedDeviceLoggerMixin,
    Settings
):
    arlo_event_stream_transport_choices = ['MQTT']
    mfa_strategy_choices = ['Manual', 'IMAP']
    plugin_log_level_choices = {
        'Info': logging.INFO,
        'Debug': logging.DEBUG,
        'Extra Debug': logging.DEBUG,
    }

    def __init__(self, nativeId: str = None) -> None:
        super().__init__(nativeId=nativeId)
        self.logger_name = 'Arlo Provider'
        self._arlo: ArloClient = None
        self.arlo_cameras: dict = {}
        self.arlo_basestations: dict = {}
        self.arlo_mvss: dict = {}
        self.scrypted_devices: dict[str, ArloDeviceBase] = {}
        self.all_device_ids: list[str] = []
        self.initialize_lock = asyncio.Lock()
        self._restart_lock = asyncio.Lock()
        self._login_lock = asyncio.Lock()
        self._login_future: asyncio.Future = None
        self._imap_ready_event: asyncio.Event = asyncio.Event()
        try:
            self.loop: asyncio.AbstractEventLoop = asyncio.get_running_loop()
        except RuntimeError:
            self.loop: asyncio.AbstractEventLoop = asyncio.get_event_loop()
        self._http_session: aiohttp.ClientSession | None = None
        self._http_session_lock = asyncio.Lock()
        self._set_login_futures()
        self.full_reset_needed: bool = False
        self.device_lock = asyncio.Lock()
        self.cleanup_devices: bool = False
        self._check_and_migrate_storage()
        self._propagate_log_level()
        self.task_manager = TaskManager(self.loop)
        self.task_manager.create_task(self._initialize_plugin(), tag='initialize_plugin', owner=self)

    def print(self, *args, **kwargs) -> None:
        print(*args, **kwargs)

    def _propagate_log_level(self) -> None:
        try:
            self.print(f'Setting plugin log level to {self.plugin_log_level}')
            log_level = self.get_current_log_level()
            self.storage.setItem('extra_debug_logging', 'true' if self.plugin_log_level == 'Extra Debug' else 'false')
            self.logger.setLevel(log_level)
            for device in self.scrypted_devices.values():
                device.logger.setLevel(log_level)
            if self.arlo:
                StdoutLoggerFactory.get_logger(name='Arlo Client').setLevel(log_level)
                if self.arlo.request:
                    self.arlo.request.set_logging()
        except Exception as e:
            self.logger.error(f'Error setting log level: {e}', exc_info=True)

    def get_current_log_level(self) -> int:
        return ArloProvider.plugin_log_level_choices[self.plugin_log_level]

    def _check_and_migrate_storage(self):
        self.logger.info(f'[Migration] Checking for migration...')
        stored_version = self.storage.getItem('plugin_version')
        if stored_version is not None:
            stored_version = int(stored_version)
        if stored_version is None:
            self.logger.info(f'[Migration] First install: setting plugin_version to {PLUGIN_VERSION}')
            self.storage.setItem('plugin_version', PLUGIN_VERSION)
            self.cleanup_devices = False
        elif stored_version < PLUGIN_VERSION:
            self.logger.info(f'[Migration] Upgrading plugin version {stored_version} → {PLUGIN_VERSION}')
            self._migrate_storage()
            self.cleanup_devices = True
        else:
            self.logger.info(f'[Migration] Plugin version matches ({PLUGIN_VERSION}), no migration needed.')
            self.cleanup_devices = False

    def _migrate_storage(self) -> None:
        self.logger.info('[Migration] Migrating storage keys and values...')
        migrations = [
            ('arlo_transport', 'arlo_event_stream_transport',
            lambda v: v if v in ArloProvider.arlo_event_stream_transport_choices else 'MQTT'),
            ('refresh_interval', 'event_stream_refresh_interval', None),
            ('mode_enabled', 'mvss_enabled', lambda v: str(v).lower()),
            ('plugin_verbosity', 'plugin_log_level',
            lambda v: {'Normal': 'Info', 'Verbose': 'Debug', 'Verbose Debug': 'Extra Debug'}.get(v, 'Info')),
        ]
        for old_key, new_key, map_fn in migrations:
            value = self.storage.getItem(old_key)
            if value is not None:
                new_value = map_fn(value) if map_fn else value
                self.logger.info(f'[Migration] Migrating {old_key}="{value}" → {new_key}="{new_value}"')
                self.storage.setItem(new_key, new_value)
            self.storage.removeItem(old_key)
        old_only_keys = ['arlo_auth_headers', 'last_mfa']
        for key in old_only_keys:
            if self.storage.getItem(key) is not None:
                self.logger.info(f'[Migration] Removing deprecated key: {key}')
                self.storage.removeItem(key)
        defaults = {
            'arlo_device_id': str(uuid.uuid4()),
            'extra_debug_logging': 'false',
            'device_discovery_interval': 15,
            'device_refresh_interval': 240,
            'arlo_discovery_in_progress': 'false',
            'disable_plugin': 'false',
            'arlo_public_key': None,
            'arlo_private_key': None,
            'mdns_services': {},
        }
        for key, default in defaults.items():
            if self.storage.getItem(key) is None:
                self.logger.info(f'[Migration] Setting default for key: {key}="{default}"')
                self.storage.setItem(key, default)

    async def _initialize_plugin(self) -> None:
        if self.initialize_lock.locked():
            self.logger.debug('Plugin initialization already in progress, waiting for it to complete.')
            return
        async with self.initialize_lock:
            if self.disable_plugin:
                self.logger.info('Plugin has been disabled. Will not initialize Arlo client.')
                self.logger.info('To re-enable the plugin, uncheck the "Disable Arlo Plugin" setting.')
                return
            try:
                self.full_reset_needed = True
                await self.onDeviceEvent(ScryptedInterface.Settings.value, None)
                await self._force_devices_load()
                if not self.arlo_device_id:
                    self.logger.debug(f'Setting up Arlo plugin Device ID.')
                    _ = self.arlo_device_id
                    self.logger.debug(f'Using Device ID: {self.arlo_device_id}')
                else:
                    self.logger.debug(f'Arlo plugin Device ID already set: {self.arlo_device_id}')
                if not self.arlo_username or not self.arlo_password:
                    self.logger.info('Arlo Cloud username or password not set. Waiting for user to enter credentials.')
                    return
                self.task_manager.cancel_all_except(tag='initialize_plugin', owner=self)
                self.logger.info('Initializing Arlo plugin...')
                self.task_manager.create_task(self._login(), tag='login', owner=self)
                self.task_manager.create_task(self._periodic_discovery(), tag='periodic_discovery', owner=self)
                self.task_manager.create_task(self._periodic_refresh(), tag='periodic_refresh', owner=self)
                await self.onDeviceEvent(ScryptedInterface.Settings.value, None)
            except Exception as e:
                self.logger.error(f'Error during plugin initialization: {e}', exc_info=True)

    async def _force_devices_load(self) -> None:
        self.logger.debug('Forcing plugin to load saved devices...')
        manifest = {
            'info': {
                'model': 'Dummy',
                'manufacturer': 'Arlo',
                'firmware': '1.0',
                'serialNumber': '000',
            },
            'nativeId': 'Dummy',
            'name': 'Dummy',
            'interfaces': [ScryptedInterface.Camera.value],
            'type': ScryptedDeviceType.Camera.value,
            'providerNativeId': None,
        }
        await scrypted_sdk.deviceManager.onDeviceDiscovered(manifest)
        await scrypted_sdk.deviceManager.onDeviceRemoved('Dummy')

    async def _periodic_discovery(self):
        if self.device_discovery_interval == 0:
            self.logger.debug('Device discovery interval is 0; periodic discovery will not run.')
            return
        try:
            await asyncio.sleep(self.device_discovery_interval * 60)
            while True:
                try:
                    self.storage.setItem('arlo_discovery_in_progress', 'true')
                    self.logger.info('Running periodic device discovery...')
                    await self._device_handler(True)
                except Exception as e:
                    self.logger.error(f'Error during periodic device discovery: {e}', exc_info=True)
                finally:
                    self.storage.setItem('arlo_discovery_in_progress', 'false')
                    if self.arlo and self.arlo.event_stream:
                        self.arlo.event_stream.process_buffered_events()
                await asyncio.sleep(self.device_discovery_interval * 60)
        except asyncio.CancelledError:
            pass

    async def _periodic_refresh(self):
        if self.device_refresh_interval == 0:
            self.logger.debug('Device refresh interval is 0; periodic refresh will not run.')
            return
        try:
            await asyncio.sleep(self.device_refresh_interval * 60)
            while True:
                try:
                    self.logger.info('Running periodic device refresh...')
                    async with self.device_lock:
                        for device in self.scrypted_devices.values():
                            if isinstance(device, ArloModeVirtualSecuritySystem):
                                continue
                            try:
                                await device.refresh_device()
                            except Exception as e:
                                self.logger.error(f'Error refreshing {device.arlo_device["deviceName"]}: {e}', exc_info=True)
                except Exception as e:
                    self.logger.error(f'Error during periodic device refresh: {e}', exc_info=True)
                await asyncio.sleep(self.device_refresh_interval * 60)
        except asyncio.CancelledError:
            pass

    async def get_http_session(self) -> aiohttp.ClientSession:
        async with self._http_session_lock:
            if self._http_session is not None and not self._http_session.closed:
                return self._http_session
            timeout = aiohttp.ClientTimeout(total=30)
            connector = aiohttp.TCPConnector(limit=20, ttl_dns_cache=300)
            self._http_session = aiohttp.ClientSession(timeout=timeout, connector=connector)
            return self._http_session

    async def close_http_session(self) -> None:
        session: aiohttp.ClientSession | None
        async with self._http_session_lock:
            session = self._http_session
            self._http_session = None
        if session is None or session.closed:
            return
        try:
            await session.close()
        except Exception:
            self.logger.debug('Error closing shared aiohttp session', exc_info=True)

    @property
    def arlo(self) -> ArloClient:
        return self._arlo

    @property
    def arlo_cookies(self) -> str:
        cookies = self.storage.getItem('arlo_cookies')
        if cookies is None:
            cookies = None
            self.storage.setItem('arlo_cookies', cookies)
        return cookies

    @property
    def arlo_device_id(self) -> str:
        device_id = self.storage.getItem('arlo_device_id')
        if device_id is None:
            device_id = str(uuid.uuid4())
            self.storage.setItem('arlo_device_id', device_id)
        return device_id

    @property
    def arlo_user_id(self) -> str:
        user_id = self.storage.getItem('arlo_user_id')
        if user_id is None:
            user_id = ''
            self.storage.setItem('arlo_user_id', user_id)
        return user_id

    @property
    def arlo_event_stream_transport(self) -> str:
        event_stream_transport = self.storage.getItem('arlo_event_stream_transport')
        if event_stream_transport is None or event_stream_transport not in ArloProvider.arlo_event_stream_transport_choices:
            event_stream_transport = 'MQTT'
            self.storage.setItem('arlo_event_stream_transport', event_stream_transport)
        return event_stream_transport

    @property
    def arlo_password(self) -> str:
        return self.storage.getItem('arlo_password')

    @property
    def arlo_username(self) -> str:
        return self.storage.getItem('arlo_username')

    @property
    def event_stream_refresh_interval(self) -> int:
        interval = self.storage.getItem('event_stream_refresh_interval')
        if interval is None:
            interval = 90
            self.storage.setItem('event_stream_refresh_interval', interval)
        return int(interval)

    @property
    def arlo_discovery_in_progress(self) -> bool:
        arlo_discovery_in_progress = self.storage.getItem('arlo_discovery_in_progress')
        if arlo_discovery_in_progress is None:
            arlo_discovery_in_progress = 'false'
            self.storage.setItem('arlo_discovery_in_progress', arlo_discovery_in_progress)
        return str(arlo_discovery_in_progress).lower() == 'true'

    @property
    def extra_debug_logging(self) -> bool:
        logging_value = self.storage.getItem('extra_debug_logging')
        if logging_value is None:
            logging_value = 'false'
            self.storage.setItem('extra_debug_logging', logging_value)
        return str(logging_value).lower() == 'true'

    @property
    def hidden_devices(self) -> list[str]:
        hidden = self.storage.getItem('hidden_devices')
        if hidden is None:
            hidden = []
            self.storage.setItem('hidden_devices', hidden)
        return hidden

    @property
    def hidden_device_ids(self) -> list[str]:
        return [
            m.group(1)
            for id in self.hidden_devices
            if (m := re.match(r'.*\((.*)\)$', id)) is not None
        ]

    @property
    def imap_mfa_host(self) -> str:
        return self.storage.getItem('imap_mfa_host')

    @property
    def imap_mfa_interval(self) -> int:
        interval = self.storage.getItem('imap_mfa_interval')
        if interval is None:
            interval = 10
            self.storage.setItem('imap_mfa_interval', interval)
        if int(interval) > 13:
            interval = 13
            self.storage.setItem('imap_mfa_interval', interval)
        return int(interval)

    @property
    def imap_mfa_use_local_index(self) -> bool:
        use_local_index = self.storage.getItem('imap_mfa_use_local_index')
        if use_local_index is None:
            use_local_index = 'false'
            self.storage.setItem('imap_mfa_use_local_index', use_local_index)
        return str(use_local_index).lower() == 'true'

    @property
    def imap_mfa_password(self) -> str:
        return self.storage.getItem('imap_mfa_password')

    @property
    def imap_mfa_port(self) -> int:
        port = self.storage.getItem('imap_mfa_port')
        if port is None:
            port = 993
            self.storage.setItem('imap_mfa_port', port)
        return int(port)

    @property
    def imap_mfa_sender(self) -> str:
        sender = self.storage.getItem('imap_mfa_sender')
        if sender is None or sender == '':
            sender = 'do_not_reply@arlo.com'
            self.storage.setItem('imap_mfa_sender', sender)
        return sender

    @property
    def imap_mfa_username(self) -> str:
        return self.storage.getItem('imap_mfa_username')

    @property
    def mfa_strategy(self) -> str:
        strategy = self.storage.getItem('mfa_strategy')
        if strategy is None or strategy not in ArloProvider.mfa_strategy_choices:
            strategy = 'Manual'
            self.storage.setItem('mfa_strategy', strategy)
        return strategy

    @property
    def mvss_enabled(self) -> bool:
        mvss = self.storage.getItem('mvss_enabled')
        if mvss is None:
            mvss = 'false'
            self.storage.setItem('mvss_enabled', mvss)
        return str(mvss).lower() == 'true'

    @property
    def plugin_log_level(self) -> str:
        log_level = self.storage.getItem('plugin_log_level')
        if log_level not in ArloProvider.plugin_log_level_choices:
            log_level = 'Info'
            self.storage.setItem('plugin_log_level', log_level)
        return log_level

    @property
    def one_location(self) -> bool:
        one_location = self.storage.getItem('one_location')
        if one_location is None:
            one_location = 'false'
            self.storage.setItem('one_location', one_location)
        return str(one_location).lower() == 'true'

    @property
    def device_discovery_interval(self) -> int:
        val = self.storage.getItem('device_discovery_interval')
        if val is None:
            val = 15
            self.storage.setItem('device_discovery_interval', val)
        return int(val)

    @property
    def device_refresh_interval(self) -> int:
        val = self.storage.getItem('device_refresh_interval')
        if val is None:
            val = 240
            self.storage.setItem('device_refresh_interval', val)
        return int(val)

    @property
    def disable_plugin(self) -> bool:
        try:
            disable_plugin = self.storage.getItem('disable_plugin')
            if disable_plugin is None:
                disable_plugin = 'false'
                self.storage.setItem('disable_plugin', disable_plugin)
            return str(disable_plugin).lower() == 'true'
        except Exception as e:
            self.logger.warning(f'Could not get disable_plugin setting: {e}')
            return False

    @property
    def mdns_services(self) -> dict:
        return self.storage.getItem('mdns_services')

    @property
    def plugin_version(self) -> int | None:
        version = self.storage.getItem('plugin_version')
        if version is not None:
            try:
                return int(version)
            except (ValueError, TypeError):
                self.logger.warning(f'Invalid plugin_version value in storage: {version}')
                return None
        return None

    @property
    def arlo_public_key(self) -> str:
        public_key = self.storage.getItem('arlo_public_key')
        if public_key is None:
            self.generate_arlo_keypair()
            public_key = self.storage.getItem('arlo_public_key')
        return public_key

    @property
    def arlo_private_key(self) -> str:
        private_key = self.storage.getItem('arlo_private_key')
        if private_key is None:
            self.generate_arlo_keypair()
            private_key = self.storage.getItem('arlo_private_key')
        return private_key

    def generate_arlo_keypair(self) -> None:
        public_key, private_key = self._generate_rsa_keys()
        self.storage.setItem('arlo_public_key', public_key)
        self.storage.setItem('arlo_private_key', private_key)

    def _generate_rsa_keys(self) -> tuple[str, str]:
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend()
        )
        private_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        )
        public_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )
        return public_pem.decode(), private_pem.decode()

    async def _login(self) -> None:
        run_login = False
        login_future: asyncio.Future | None = None
        async with self._login_lock:
            if self._login_future and not self._login_future.done():
                login_future = self._login_future
            else:
                login_future = self.loop.create_future()
                self._login_future = login_future
                run_login = True
        if not run_login:
            self.logger.debug('Login already in progress, waiting for it to complete.')
            await login_future
            return
        try:
            if self.full_reset_needed:
                await self._reset_arlo_client()
                arlo = ArloClient(self)
            else:
                arlo = self.arlo if self.arlo is not None else ArloClient(self)
            self._set_login_futures()
            arlo.browser_authenticated = self._browser_authenticated
            arlo.mfa_state_future = self._mfa_state_future
            arlo.mfa_loop_future = self._mfa_loop_future
            arlo.mfa_code_future = self._mfa_code_future
            self.logger.debug('Setup ArloClient and MFA futures.')
            login_task = self.task_manager.create_task(arlo.login(), tag='login-arlo', owner=self)
            self.logger.debug('Waiting for MFA state from Arlo Cloud...')
            mfa_state: str = await self._mfa_state_future
            browser_authenticated: bool = await self._browser_authenticated
            if not browser_authenticated:
                mfa_start_time = time.time()
                await self._mfa_loop_future
                if mfa_state == 'ENABLED':
                    if self.mfa_strategy == 'IMAP':
                        self.logger.debug('Using IMAP strategy for MFA code retrieval.')
                        self.task_manager.create_task(self._imap_mfa_loop(arlo, mfa_start_time), tag='mfa', owner=self)
                    elif self.mfa_strategy == 'Manual':
                        self.logger.debug('Using Manual strategy for MFA code retrieval.')
                        self.task_manager.create_task(self._manual_mfa_loop(), tag='mfa', owner=self)
            await login_task
            if arlo.logged_in:
                await self._on_login_success(arlo)
                if login_future is not None and not login_future.done():
                    login_future.set_result(True)
                return
            else:
                self.logger.error('Arlo Cloud login failed, retrying in 10 seconds.')
                await asyncio.sleep(10)
                if login_future is not None and not login_future.done():
                    login_future.set_result(False)
        except asyncio.CancelledError:
            if login_future is not None and not login_future.done():
                login_future.set_result(False)
            await asyncio.sleep(10)
        except Exception as e:
            self.logger.exception(f'Exception during login: {e}')
            if login_future is not None and not login_future.done():
                login_future.set_exception(e)
            await asyncio.sleep(10)
        finally:
            if login_future is not None and not login_future.done():
                login_future.set_result(False)

    async def _reset_arlo_client(self) -> None:
        if self.arlo is not None:
            try:
                await self.arlo.restart()
            except Exception as e:
                self.logger.warning(f'Error restarting Arlo client: {e}')
        self._arlo = None

    def _set_login_futures(self) -> None:
        self._browser_authenticated: asyncio.Future[bool] = self.loop.create_future()
        self._mfa_code_future: asyncio.Future[str] = self.loop.create_future()
        self._mfa_loop_future: asyncio.Future[None] = self.loop.create_future()
        self._mfa_state_future: asyncio.Future[str] = self.loop.create_future()

    async def _cleaning_up_login_tasks(self) -> None:
        self.logger.debug('Cleaning up login and MFA tasks.')
        await self.task_manager.cancel_and_await_by_tag('mfa', owner=self)
        await self.task_manager.cancel_and_await_by_tag('login-arlo', owner=self)
        await self.task_manager.cancel_and_await_by_tag('login', owner=self)

    async def _imap_mfa_loop(self, arlo: ArloClient, mfa_start_time: float) -> None:
        if not self._imap_settings_ready():
            self.logger.info('IMAP MFA settings not ready, waiting for user input.')
            await self._imap_ready_event.wait()
        self.logger.debug('IMAP MFA Loop started.')
        mfa_code = await self._poll_imap_for_mfa_code(mfa_start_time)
        if mfa_code:
            if not self._mfa_code_future.done():
                self._mfa_code_future.set_result(mfa_code)
            self.logger.debug('IMAP MFA code sent to Arlo client.')
            return
        if not arlo.logged_in:
            self.logger.error('IMAP MFA Loop failed. Restarting plugin.')
            await self.request_restart('plugin')

    async def _manual_mfa_loop(self) -> None:
        self.manual_mfa_signal: asyncio.Queue[str] = asyncio.Queue()
        self.logger.debug('Manual MFA Loop started.')
        try:
            self.logger.info('Waiting for manual MFA code input.')
            mfa_code = await asyncio.wait_for(self.manual_mfa_signal.get(), timeout=278)
            if mfa_code:
                if not self._mfa_code_future.done():
                    self._mfa_code_future.set_result(mfa_code)
                self.logger.debug('Manual MFA code sent to Arlo client.')
                return
            else:
                self.logger.error('Manual MFA code was not provided. Restarting plugin.')
        except asyncio.TimeoutError:
            self.logger.error('Manual MFA code not entered within 5 minutes. Restarting plugin.')
        await self.request_restart('plugin')

    async def _on_login_success(self, arlo: ArloClient) -> None:
        self._arlo = arlo
        if self.full_reset_needed:
            await self.task_manager.cancel_and_await_by_tag('refresh', owner=self)
            self.task_manager.create_task(self._refresh_login_loop(), tag='refresh', owner=self)
            await self._do_arlo_setup()
            self.full_reset_needed = False

    async def _refresh_login_loop(self) -> None:
        hard_interval_days = self.imap_mfa_interval if self.mfa_strategy == 'IMAP' else 14
        hard_interval = hard_interval_days * 24 * 60 * 60
        elapsed = 0
        try:
            while True:
                interval = 6600 + random.randint(-300, 300)
                sleep_time = min(interval, hard_interval - elapsed)
                await asyncio.sleep(sleep_time)
                elapsed += sleep_time
                if elapsed >= hard_interval:
                    self.logger.debug('Hard MFA refresh interval reached, forcing full login.')
                    async with self.device_lock:
                        await self.arlo.cancel_heartbeat()
                        await self._initialize_plugin()
                    break
                else:
                    self.logger.debug('Session refresh interval reached, re-logging in.')
                    async with self.device_lock:
                        self.arlo.finialized_login = False
                        self.arlo.token = None
                        self.arlo.logged_in = False
                        await self.arlo.cancel_heartbeat()
                        await self._login()
                        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)
        except asyncio.CancelledError:
            pass

    def _imap_settings_ready(self) -> bool:
        ready = all([
            self.imap_mfa_host,
            self.imap_mfa_interval,
            self.imap_mfa_password,
            self.imap_mfa_port,
            self.imap_mfa_sender,
            self.imap_mfa_username,
        ])
        if ready:
            self._imap_ready_event.set()
            return True
        else:
            self._imap_ready_event.clear()
            return False

    async def _poll_imap_for_mfa_code(self, mfa_start_time: float) -> str:
        code = None
        self.logger.debug('Starting IMAP polling for MFA code.')
        code = await self.loop.run_in_executor(None, self._poll_imap_for_mfa_code_sync, mfa_start_time)
        if code:
            self.logger.debug(f'Found MFA code: {code}')
        else:
            self.logger.debug('IMAP polling finished. No MFA code found.')
        return code

    def _poll_imap_for_mfa_code_sync(self, mfa_start_time: float) -> str:
        def _minute_floor(times: float) -> datetime:
            return datetime.fromtimestamp(times).replace(second=0, microsecond=0)

        mfa_start_time_clean = _minute_floor(mfa_start_time)
        code = None
        imap = None
        try:
            imap = imaplib.IMAP4_SSL(self.imap_mfa_host, self.imap_mfa_port)
            imap.login(self.imap_mfa_username, self.imap_mfa_password)
            first = True
            for attempt in range(1, 25):
                wait_time = min(2 ** (((attempt - 1) // 5) + 1), 60)
                self.logger.debug(f'IMAP search attempt {attempt}/24')
                if not first:
                    try:
                        imap.close()
                    except Exception:
                        pass
                else:
                    first = False
                imap.select('INBOX')
                msg_ids: list[bytes]
                typ, msg_ids = imap.search(None, 'FROM', f'"{self.imap_mfa_sender}"')
                if typ == 'OK' and msg_ids and msg_ids[0]:
                    msg_id_list = msg_ids[0].split()
                    for msg_id in reversed(msg_id_list):
                        typ, msg_data = imap.fetch(msg_id, '(RFC822)')
                        if typ != 'OK':
                            continue
                        msg = email.message_from_bytes(msg_data[0][1])
                        date_tuple = email.utils.parsedate_tz(msg.get('Date'))
                        msg_time = email.utils.mktime_tz(date_tuple) if date_tuple else None
                        if msg_time:
                            msg_time_clean = _minute_floor(msg_time)
                            if msg_time_clean < mfa_start_time_clean:
                                self.logger.debug(f'No email found yet, will retry after {wait_time}s.')
                                break
                        found = None
                        for part in msg.walk():
                            if part.get_content_type() == 'text/plain':
                                text = part.get_payload(decode=True).decode(errors='ignore')
                                found = self._extract_mfa_code_from_text(text)
                            elif part.get_content_type() == 'text/html':
                                html = part.get_payload(decode=True).decode(errors='ignore')
                                soup = BeautifulSoup(html, 'html.parser')
                                for line in soup.get_text().splitlines():
                                    found = self._extract_mfa_code_from_text(line)
                                    if found:
                                        break
                            if found:
                                code = found
                                break
                        if code:
                            break
                    if code:
                        break
                    time.sleep(wait_time)
                    continue
                typ, msg_ids = imap.search(None, 'ALL')
                if typ == 'OK' and msg_ids and msg_ids[0]:
                    msg_id_list = msg_ids[0].split()
                    for msg_id in reversed(msg_id_list):
                        typ, msg_data = imap.fetch(msg_id, '(RFC822)')
                        if typ != 'OK':
                            continue
                        msg = email.message_from_bytes(msg_data[0][1])
                        date_tuple = email.utils.parsedate_tz(msg.get('Date'))
                        msg_time = email.utils.mktime_tz(date_tuple) if date_tuple else None
                        if msg_time:
                            msg_time_clean = _minute_floor(msg_time)
                            if msg_time_clean < mfa_start_time_clean:
                                self.logger.debug(f'No emails found yet, will retry after {wait_time}s.')
                                break
                        if msg.get('From') and self.imap_mfa_sender.lower() in msg.get('From').lower():
                            found = None
                            for part in msg.walk():
                                if part.get_content_type() == 'text/plain':
                                    text = part.get_payload(decode=True).decode(errors='ignore')
                                    found = self._extract_mfa_code_from_text(text)
                                elif part.get_content_type() == 'text/html':
                                    html = part.get_payload(decode=True).decode(errors='ignore')
                                    soup = BeautifulSoup(html, 'html.parser')
                                    for line in soup.get_text().splitlines():
                                        found = self._extract_mfa_code_from_text(line)
                                        if found:
                                            break
                                if found:
                                    code = found
                                    break
                            if code:
                                break
                    if code:
                        break
                    time.sleep(wait_time)
                    continue
                self.logger.debug(f'No emails found yet, will retry after {wait_time}s.')
                time.sleep(wait_time)
        except Exception as e:
            self.logger.warning(f'IMAP polling error: {e}', exc_info=True)
        finally:
            if imap:
                try:
                    imap.logout()
                except Exception:
                    pass
        return code

    def _extract_mfa_code_from_text(self, text: str) -> str:
        match = re.search(r'\b(\d{6})\b', text)
        return match.group(1) if match else None

    async def _do_arlo_setup(self) -> None:
        try:
            self.storage.setItem('arlo_discovery_in_progress', 'true')
            self.arlo_cameras = {}
            self.arlo_basestations = {}
            self.arlo_mvss = {}
            self.all_device_ids = []
            self.scrypted_devices = {}
            await self.arlo.subscribe()
            async with self.device_lock:
                if self.cleanup_devices:
                    await self._cleanup_devices()
                    self.cleanup_devices = False
                    self.storage.setItem('plugin_version', PLUGIN_VERSION)
                await self.mdns()
            await self._device_handler()
        except requests.exceptions.HTTPError:
            self.logger.exception('HTTP error during Arlo login')
            self.logger.error('Will retry with fresh login')
            await self.arlo.cancel_heartbeat()
            await self._initialize_plugin()
        except Exception:
            self.logger.exception('Unexpected error during Arlo setup')
        finally:
            self.storage.setItem('arlo_discovery_in_progress', 'false')
            if self.arlo and self.arlo.event_stream:
                self.arlo.event_stream.process_buffered_events()
            self.logger.info('Arlo plugin initialized.')

    def request_restart(self, scope: str = 'plugin') -> None:
        try:
            scope_map = {
                'plugin': lambda: asyncio.run_coroutine_threadsafe(self._request_plugin_restart(clear_cookies=False), self.loop),
                'restart': lambda: asyncio.run_coroutine_threadsafe(self._handle_restart(restart=True), self.loop),
                'relogin': lambda: asyncio.run_coroutine_threadsafe(self._handle_restart(relogin=True), self.loop),
                'refresh_login_loop': lambda: asyncio.run_coroutine_threadsafe(self._handle_restart(refresh_login_loop=True), self.loop),
                'event_stream': lambda: asyncio.run_coroutine_threadsafe(self._handle_restart(event_stream=True), self.loop),
            }
            action = scope_map.get(scope)
            if action:
                action()
            else:
                asyncio.run_coroutine_threadsafe(self._request_plugin_restart(clear_cookies=False), self.loop)
        except Exception as e:
            self.logger.error(f'Failed to request restart for scope {scope}: {e}', exc_info=True)

    async def _request_plugin_restart(self, clear_cookies: bool) -> None:
        try:
            await self._shutdown(clear_cookies=clear_cookies)
        except Exception as e:
            self.logger.warning(f'Error during internal shutdown before requestRestart: {e}', exc_info=True)
        try:
            await scrypted_sdk.deviceManager.requestRestart()
        except Exception as e:
            self.logger.warning(f'Error requesting plugin restart: {e}', exc_info=True)

    async def _handle_restart(
        self,
        *,
        restart: bool = False,
        relogin: bool = False,
        refresh_login_loop: bool = False,
        event_stream: bool = False,
    ) -> None:
        try:
            async with self._restart_lock:
                if refresh_login_loop:
                    await self.task_manager.cancel_and_await_by_tag('refresh', owner=self)
                    if self.arlo and self.arlo.logged_in:
                        self.task_manager.create_task(self._refresh_login_loop(), tag='refresh', owner=self)
                elif restart or relogin:
                    async with self.device_lock:
                        if relogin:
                            self.logger.info('Forcing account relogin.')
                            await self._shutdown_locked(clear_cookies=False)
                            await self._initialize_plugin()
                        if restart:
                            self.logger.info('Forcing full restart.')
                            await self._shutdown_locked(clear_cookies=True)
                            await self._initialize_plugin()
                elif event_stream:
                    async with self.device_lock:
                        if self.arlo and self.arlo.logged_in:
                            self.arlo.event_stream_transport = self.arlo_event_stream_transport
                            await self.arlo.unsubscribe()
                        await self._subscribe_to_event_stream()
                else:
                    self.logger.error('No valid restart scope provided.')
                return
        except Exception as e:
            self.logger.error(f'Error during handle restart: {e}', exc_info=True)

    async def _shutdown(self, clear_cookies: bool) -> None:
        async with self.device_lock:
            await self._shutdown_locked(clear_cookies=clear_cookies)

    async def _shutdown_locked(self, clear_cookies: bool) -> None:
        try:
            self.storage.setItem('arlo_discovery_in_progress', 'false')
        except Exception:
            pass
        try:
            await self.close_http_session()
        except Exception:
            pass
        if clear_cookies:
            self.storage.setItem('arlo_cookies', None)
        for device in list(self.scrypted_devices.values()):
            try:
                await device.close()
            except Exception:
                pass
        try:
            await self.task_manager.cancel_and_await_by_tag('initialize_plugin', owner=self)
            await self.task_manager.cancel_and_await_by_tag('periodic_discovery', owner=self)
            await self.task_manager.cancel_and_await_by_tag('periodic_refresh', owner=self)
            await self.task_manager.cancel_and_await_by_tag('refresh', owner=self)
        except Exception:
            pass
        try:
            await self._cleaning_up_login_tasks()
        except Exception:
            pass
        try:
            await self._reset_arlo_client()
        except Exception:
            pass
        self.logger.info('Provider shutdown finished')

    async def _device_handler(self, periodic_discovery: bool | None = None) -> None:
        async with self.device_lock:
            await self.discover_devices()
            await self._subscribe_to_event_stream(periodic_discovery)
            await self.create_devices()

    async def getSettings(self) -> list[Setting]:
        results: list[Setting] = [
            {
                'group': 'General',
                'key': 'arlo_username',
                'title': 'Arlo Username',
                'value': self.arlo_username,
            },
            {
                'group': 'General',
                'key': 'arlo_password',
                'title': 'Arlo Password',
                'type': 'password',
                'value': self.arlo_password,
            },
            {
                'group': 'General',
                'key': 'mfa_strategy',
                'title': 'Multi-Factor Strategy',
                'description': 'Mechanism to fetch the multi-factor code for Arlo login. Save after changing this field for more settings.',
                'value': self.mfa_strategy,
                'choices': self.mfa_strategy_choices,
            },
            {
                'group': 'General',
                'key': 'force_mfa_reauthentication',
                'title': 'Force Re-Authentication',
                'description': 'Forces the plugin to re-authenticate with Arlo, this resets the plugin and forces new multi-factor authentication.',
                'type': 'boolean',
                'value': False,
            }
        ]
        if self.mfa_strategy == 'Manual':
            results.extend([
                {
                    'group': 'Manual MFA',
                    'key': 'arlo_mfa_code',
                    'title': 'Multi-Factor Authentication Code',
                    'description': 'Enter the code sent by Arlo to your e-mail or phone number.',
                },
            ])
        else:
            results.extend([
                {
                    'group': 'IMAP MFA',
                    'key': 'imap_mfa_host',
                    'title': 'IMAP Hostname',
                    'value': self.imap_mfa_host,
                },
                {
                    'group': 'IMAP MFA',
                    'key': 'imap_mfa_port',
                    'title': 'IMAP Port',
                    'value': self.imap_mfa_port,
                },
                {
                    'group': 'IMAP MFA',
                    'key': 'imap_mfa_username',
                    'title': 'IMAP Username',
                    'value': self.imap_mfa_username,
                },
                {
                    'group': 'IMAP MFA',
                    'key': 'imap_mfa_password',
                    'title': 'IMAP Password',
                    'type': 'password',
                    'value': self.imap_mfa_password,
                },
                {
                    'group': 'IMAP MFA',
                    'key': 'imap_mfa_sender',
                    'title': 'IMAP Email Sender',
                    'description': 'The sender email address to search for when loading MFA codes. See plugin README for more details.',
                    'value': self.imap_mfa_sender,
                },
                {
                    'group': 'IMAP MFA',
                    'key': 'imap_mfa_interval',
                    'title': 'Refresh MFA Interval',
                    'description': 'Interval, in days, to refresh the MFA login session to Arlo Cloud. '
                                   'Must be a value greater than 0 and less than 14.',
                    'type': 'number',
                    'value': self.imap_mfa_interval,
                },
                {
                    'group': 'IMAP MFA',
                    'key': 'imap_mfa_use_local_index',
                    'title': 'Search Emails Locally',
                    'description': 'Enable this option to fetch all emails and search for MFA codes locally. '
                                   'This is useful when the IMAP server does not support searching for emails, or takes too long '
                                   'to index new emails.',
                    'type': 'boolean',
                    'value': self.imap_mfa_use_local_index,
                },
            ])
        results.extend([
            {
                'group': 'General',
                'key': 'arlo_event_stream_transport',
                'title': 'Underlying Event Stream Transport Protocol',
                'description': 'Arlo Cloud supports the MQTT protocol for reading events. '
                               'SSE Protocol has been disabled by Arlo and cannot be used.',
                'value': self.arlo_event_stream_transport,
                'choices': ArloProvider.arlo_event_stream_transport_choices,
            },
            {
                'group': 'General',
                'key': 'event_stream_refresh_interval',
                'title': 'Refresh Event Stream Interval',
                'description': 'Interval, in minutes, to refresh the underlying event stream connection to Arlo Cloud. '
                               'A value of 0 disables this feature.',
                'type': 'number',
                'value': self.event_stream_refresh_interval,
            },
            {
                'group': 'General',
                'key': 'device_discovery_interval',
                'title': 'Device Discovery Interval',
                'description': 'Interval, in minutes, to periodically discover and update devices from the Arlo Cloud. '
                               'A value of 0 disables this feature.',
                'type': 'number',
                'value': self.device_discovery_interval,
            },
            {
                'group': 'General',
                'key': 'device_refresh_interval',
                'title': 'Device Refresh Interval',
                'description': 'Interval, in minutes, to refresh all device properties from the Arlo Cloud. '
                               'A value of 0 disables this feature.',
                'type': 'number',
                'value': self.device_refresh_interval,
            },
            {
                'group': 'General',
                'key': 'plugin_log_level',
                'title': 'Logging Level',
                'description': 'Choose the logging level for the plugin. This will affect the amount of information logged to the console.',
                'value': self.plugin_log_level,
                'choices': list(ArloProvider.plugin_log_level_choices.keys()),
            },
            {
                'group': 'General',
                'key': 'hidden_devices',
                'title': 'Hidden Devices',
                'description': 'Select the Arlo devices to hide in this plugin. Hidden devices will be removed from Scrypted and will '
                               'not be re-added when the plugin reloads.',
                'value': self.hidden_devices,
                'choices': [id for id in self.all_device_ids],
                'multiple': True,
            },
            {
                'group': 'General',
                'key': 'mvss_enabled',
                'title': 'Allow Scrypted to Control Arlo Security Modes',
                'description': 'Enable allowing Scrypted to handle changing Security Modes in the Arlo App.',
                'type': 'boolean',
                'value': self.mvss_enabled,
            },
            {
                'group': 'General',
                'key': 'disable_plugin',
                'title': 'Disable Arlo Plugin',
                'description': 'Disables the Arlo Plugin.',
                'type': 'boolean',
                'value': self.disable_plugin,
            },
        ])
        return results

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if not self._validate_setting(key, value):
            await self.onDeviceEvent(ScryptedInterface.Settings.value, None)
            return
        if key in ('arlo_username', 'arlo_password'):
            prev_user, prev_pass = self.arlo_username, self.arlo_password
            self.storage.setItem(key, value)
            username, password = self.storage.getItem('arlo_username'), self.storage.getItem('arlo_password')
            if username and password and (username != prev_user or password != prev_pass):
                self.request_restart('restart')
        if key == 'arlo_mfa_code':
            if self._login_future and not self._login_future.done() and self.manual_mfa_signal:
                self.logger.debug(f'Entered MFA code: {value}')
                await self.manual_mfa_signal.put(value)
        elif key == 'force_mfa_reauthentication':
            if value:
                self.request_restart('restart')
        elif key == 'plugin_log_level':
            self.storage.setItem(key, value)
            self._propagate_log_level()
        elif key == 'arlo_event_stream_transport':
            self.storage.setItem(key, value)
            self.request_restart('event_stream')
        elif key == 'mfa_strategy':
            previous = self.mfa_strategy
            self.storage.setItem(key, value)
            self.request_restart('refresh_login_loop')
            if value == 'Manual' and previous != 'Manual':
                self._clear_imap_defaults()
        elif key == 'event_stream_refresh_interval':
            self.storage.setItem(key, value)
            if self.arlo and self.arlo.event_stream:
                self.arlo.event_stream.set_refresh_interval(self.event_stream_refresh_interval)
        elif key.startswith('imap_mfa'):
            if key == 'imap_mfa_use_local_index':
                self.storage.setItem(key, 'true' if value else 'false')
            else:
                self.storage.setItem(key, value)
            self._imap_settings_ready()
            self.request_restart('refresh_login_loop')
        elif key in ('hidden_devices', 'mvss_enabled'):
            self.storage.setItem(key, 'true' if (key == 'mvss_enabled' and value) else value)
            if self.arlo and self.arlo.logged_in:
                self.request_restart('relogin')
        elif key in ('device_refresh_interval', 'device_discovery_interval'):
            self.storage.setItem(key, str(value))
            periodic_map = {
                'device_refresh_interval': ('periodic_refresh', self._periodic_refresh),
                'device_discovery_interval': ('periodic_discovery', self._periodic_discovery),
            }
            tag, func = periodic_map[key]
            await self._restart_periodic_task(tag, func)
        elif key == 'disable_plugin':
            self.storage.setItem(key, str(value))
            verb = 'disabled' if value else 'enabled'
            self.logger.debug(f'Arlo plugin will be {verb}. Restarting...')
            self.request_restart('plugin')
        else:
            self.storage.setItem(key, value)
        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)

    def _validate_setting(self, key: str, val: SettingValue) -> bool:
        try:
            if key in ('device_discovery_interval', 'device_refresh_interval', 'event_stream_refresh_interval', 'imap_mfa_port'):
                v = int(val)
                if v < 0:
                    raise ValueError('must be nonnegative')
            elif key == 'imap_mfa_interval':
                v = int(val)
                if v < 1 or v > 13:
                    raise ValueError('must be between 1 and 13')
            elif key == 'plugin_log_level':
                if val not in ArloProvider.plugin_log_level_choices:
                    raise ValueError(f'must be one of {list(ArloProvider.plugin_log_level_choices.keys())}')
            elif key == 'arlo_event_stream_transport':
                if val not in ArloProvider.arlo_event_stream_transport_choices:
                    raise ValueError(f'must be one of {ArloProvider.arlo_event_stream_transport_choices}')
            elif key == 'mfa_strategy':
                if val not in ArloProvider.mfa_strategy_choices:
                    raise ValueError(f'must be one of {ArloProvider.mfa_strategy_choices}')
            elif key in ('disable_plugin', 'imap_mfa_use_local_index'):
                if isinstance(val, str) and val.lower() not in ('true', 'false'):
                    raise ValueError('must be boolean true/false')
        except ValueError as e:
            self.logger.error(f'Invalid value for {key}: "{val}" - {e}')
            return False
        return True

    def _clear_imap_defaults(self) -> None:
        try:
            self.storage.setItem('imap_mfa_host', None)
            self.storage.setItem('imap_mfa_username', None)
            self.storage.setItem('imap_mfa_password', None)
            self.storage.setItem('imap_mfa_sender', 'do_not_reply@arlo.com')
            self.storage.setItem('imap_mfa_interval', 10)
            self.storage.setItem('imap_mfa_port', 993)
            self.storage.setItem('imap_mfa_use_local_index', 'false')
        except Exception as e:
            self.logger.debug(f'Error clearing IMAP defaults: {e}')

    async def _restart_periodic_task(self, tag: str, coroutine: Callable[[], Awaitable]):
            await self.task_manager.cancel_and_await_by_tag(tag, owner=self)
            self.task_manager.create_task(coroutine(), tag=tag, owner=self)

    async def _cleanup_devices(self) -> None:
        self.logger.info('[Migration] Starting cleanup of plugin devices...')
        system_state: dict[str, dict[str, dict]] = scrypted_sdk.systemManager.getSystemState()
        if not system_state:
            self.logger.info('[Migration] No system state found for device cleanup.')
            return
        device_ids_nativeids: dict[str, str] = {
            device_id: device_info.get("nativeId", {}).get("value", "")
            for device_id, device_info in system_state.items()
        }

        def _matches(native_id: str) -> bool:
            return (
                native_id.endswith('.siren')
                or native_id.endswith('.vss')
                or native_id.endswith('.smss')
            )

        filtered: dict[str, str] = {
            device_id: native_id
            for device_id, native_id in device_ids_nativeids.items()
            if _matches(native_id)
        }
        if not filtered:
            self.logger.info('[Migration] No plugin devices found for device cleanup.')
            return

        def _sort_key(native_id: str) -> tuple[int, str]:
            if native_id.endswith('.siren'):
                return (0, native_id)
            if native_id.endswith('.vss'):
                return (1, native_id)
            if native_id.endswith('.smss'):
                return (2, native_id)
            return (3, native_id)

        sorted_items: list[tuple[str, str]] = sorted(filtered.items(), key=lambda item: _sort_key(item[1]))
        self.logger.info(f'[Migration] Found {len(sorted_items)} plugin devices to clean up.')
        for device_id, native_id in sorted_items:
            try:
                self.logger.info(f'[Migration] Removing plugin device: {native_id}')
                if device_id not in scrypted_sdk.systemManager.getSystemState():
                    self.logger.info(f'[Migration] Skipping removal; device already absent: {native_id}')
                    continue
                await scrypted_sdk.deviceManager.onDeviceRemoved(native_id)
            except Exception:
                self.logger.error(
                    f'[Migration] Error during cleanup for device {native_id})',
                    exc_info=True
                )
        self.logger.info('[Migration] Plugin device cleanup complete.')

    async def mdns(self) -> None:
        self.logger.debug('Initializing mDNS Discovery for basestation(s).')
        try:
            mdns = ArloAsyncBrowser(self.logger)
            await mdns.async_run()
            self.storage.setItem('mdns_services', mdns.services)
            if self.mdns_services:
                self.logger.debug(f'Basestation(s) found in mDNS.')
        except:
            self.logger.error('Basestation(s) not found in mDNS, manual input needed under basestation(s) settings.')

    async def discover_devices(self) -> None:
        try:
            await self._discover_devices()
        except Exception as e:
            self.logger.exception(f'Error discovering devices: {e}')
            raise

    async def _discover_devices(self) -> None:
        if not self.arlo or not self.arlo.logged_in:
            raise Exception('Arlo client not connected, cannot discover devices')
        self.logger.info('Discovering devices...')
        basestation_entries = []
        camera_entries = []
        mvss_entries = []
        all_ids_set = set()
        basestations = await self.arlo.get_devices([DEVICE_TYPE_BASESTATION, DEVICE_TYPE_SIREN], True)
        for basestation in sorted(basestations, key=lambda b: str(b['deviceName']).lower()):
            nativeId = basestation['deviceId']
            entry = f'{basestation["deviceName"]} ({nativeId})'
            if entry not in all_ids_set:
                all_ids_set.add(entry)
                basestation_entries.append(entry)
            self.logger.debug(f'Found basestation {basestation["deviceName"]}')
            if nativeId in self.arlo_basestations:
                self.logger.debug(f'Skipping basestation {basestation["deviceName"]} as it has already been added.')
                continue
            self.arlo_basestations[nativeId] = basestation
        self.arlo_basestations = OrderedDict(
            sorted(self.arlo_basestations.items(), key=lambda item: str(item[1]['deviceName']).lower())
        )
        basestation_discovered_count = len([k for k in self.arlo_basestations if k not in self.arlo_cameras])
        self.logger.debug(
            f'Found {basestation_discovered_count} basestation{"" if basestation_discovered_count == 1 else "s"}.'
        )
        cameras = await self.arlo.get_devices([DEVICE_TYPE_CAMERA, DEVICE_TYPE_ARLOQ, DEVICE_TYPE_ARLOQS, DEVICE_TYPE_DOORBELL], True)
        for camera in sorted(cameras, key=lambda c: str(c['deviceName']).lower()):
            nativeId = camera['deviceId']
            parentId = camera['parentId']
            entry = f'{camera["deviceName"]} ({nativeId})'
            if entry not in all_ids_set:
                all_ids_set.add(entry)
                camera_entries.append(entry)
            self.logger.debug(f'Found camera {camera["deviceName"]}')
            if nativeId != parentId and parentId not in self.arlo_basestations:
                self.logger.debug(f'Skipping camera {camera["deviceName"]} because its basestation was not found.')
                continue
            if nativeId in self.arlo_cameras:
                self.logger.debug(f'Skipping camera {camera["deviceName"]} as it has already been added.')
                continue
            if nativeId == parentId:
                self.arlo_basestations[nativeId] = camera
                self.arlo_basestations = OrderedDict(
                    sorted(self.arlo_basestations.items(), key=lambda item: str(item[1]['deviceName']).lower())
                )
            self.arlo_cameras[nativeId] = camera
        self.arlo_cameras = OrderedDict(
            sorted(self.arlo_cameras.items(), key=lambda item: str(item[1]['deviceName']).lower())
        )
        camera_discovered_count = len(self.arlo_cameras)
        self.logger.debug(f'Found {camera_discovered_count} camera{"" if camera_discovered_count == 1 else "s"}.')
        if self.mvss_enabled:
            locations = await self.arlo.get_locations()
            sorted_locations = dict(sorted(locations.items(), key=lambda item: item[1].lower()))
            self.storage.setItem('one_location', 'false' if len(locations) > 1 else 'true')
            for location in sorted_locations:
                nativeId = f'{location}.mvss'
                entry = f'Arlo Mode Virtual Security System {locations[location]} ({nativeId})'
                if entry not in all_ids_set:
                    all_ids_set.add(entry)
                    mvss_entries.append(entry)
                self.logger.debug(f'Found mode virtual security system Arlo Mode Virtual Security System {locations[location]}')
                if nativeId in self.arlo_mvss:
                    self.logger.debug(f'Skipping mode virtual security system Arlo Mode Virtual Security System {locations[location]} as it has already been added.')
                    continue
                self.arlo_mvss[nativeId] = {'location_name': locations[location], 'deviceName': f'Arlo Mode Virtual Security System {locations[location]}'}
            self.arlo_mvss = OrderedDict(
                sorted(self.arlo_mvss.items(), key=lambda item: str(item[1]['location_name']).lower())
            )
            mvss_discovered_count = len(self.arlo_mvss)
            self.logger.debug(f'Found {mvss_discovered_count} mode virtual security system{"" if mvss_discovered_count == 1 else "s"}.')
        self.all_device_ids = (
            sorted(basestation_entries, key=lambda x: str(x).lower()) +
            sorted(camera_entries, key=lambda x: str(x).lower()) +
            sorted(mvss_entries, key=lambda x: str(x).lower())
        )
        self.logger.info('Done discovering devices.')

    async def _subscribe_to_event_stream(self, periodic_discovery: bool | None = None) -> None:
        if self.arlo and self.arlo.logged_in:
            self.logger.info('Subscribing to Arlo event stream...')
            subscribe_args = [
                (self.arlo_basestations[camera['parentId']], camera)
                for camera in self.arlo_cameras.values()
            ]
            for attempt in range(2):
                try:
                    await self.arlo.subscribe(subscribe_args)
                    break
                except RuntimeError as e:
                    if attempt == 0:
                        self.logger.warning(f'Event stream failed to connect: {e}')
                        self.logger.debug('Retrying stream setup after short delay...')
                        await asyncio.sleep(5)
                    else:
                        self.logger.error('Stream still failed to connect after retry.')
                        raise
            if self.arlo.event_stream and not periodic_discovery:
                self.arlo.event_stream.set_refresh_interval(self.event_stream_refresh_interval)
            self.logger.info('Subscribed to Arlo event stream successfully.')
        else:
            self.logger.warning('Arlo client not logged in, cannot subscribe to event stream.')

    async def create_devices(self) -> None:
        try:
            await self._create_devices()
        except Exception as e:
            self.logger.exception(f'Error creating devices: {e}')
            raise

    async def _create_devices(self) -> None:
        if not self.arlo or not self.arlo.logged_in:
            raise Exception('Arlo client not connected, cannot create devices')
        self.logger.info('Creating devices...')
        provider_to_device_map = defaultdict(list)
        basestation_devices: list = []
        camera_devices: list = []
        mvss_devices: list = []
        for native_id, basestation in self.arlo_basestations.items():
            if native_id in self.arlo_cameras:
                continue
            try:
                if await self._register_device(native_id, basestation, provider_to_device_map):
                    basestation_devices.append(native_id)
            except Exception as e:
                self.logger.exception(f'Exception registering basestation {basestation["deviceName"]}: {e}')
        actual_basestations = len([k for k in self.arlo_basestations if k not in self.arlo_cameras])
        self._log_creation_mismatch('basestations', actual_basestations, len(basestation_devices))
        for native_id, camera in self.arlo_cameras.items():
            parent_id = camera['parentId']
            try:
                if await self._register_device(native_id, camera, provider_to_device_map, parent_id):
                    camera_devices.append(native_id)
            except Exception as e:
                self.logger.exception(f'Exception registering camera {camera["deviceName"]}: {e}')
        self._log_creation_mismatch('cameras', len(self.arlo_cameras), len(camera_devices))
        if self.mvss_enabled:
            for native_id, mvss in self.arlo_mvss.items():
                try:
                    if await self._register_device(native_id, mvss, provider_to_device_map, parent_id=None, location_name=mvss['location_name']):
                        mvss_devices.append(native_id)
                except Exception as e:
                    self.logger.exception(f'Exception registering mvss {mvss["deviceName"]}: {e}')
            self._log_creation_mismatch('mode virtual security systems', len(self.arlo_mvss), len(mvss_devices))
        await self._send_devices_to_scrypted(provider_to_device_map)
        self.logger.info('Done creating devices.')
        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)

    async def _register_device(
        self,
        native_id: str,
        device_dict: dict,
        provider_to_device_map: defaultdict[Any, list],
        parent_id: str = None,
        location_name: str = None
    ) -> bool:
        if native_id in self.hidden_device_ids:
            self.logger.debug(f'Skipping {device_dict["deviceName"]} as it is hidden.')
            return False
        existing_device = self.scrypted_devices.get(native_id)
        if existing_device:
            self.logger.debug(f'Device {device_dict["deviceName"]} already exists, skipping re-registration.')
            return True
        else:
            if native_id.endswith('mvss'):
                properties = {}
            else:
                properties = device_dict.get('properties', {})
                if not properties:
                    if parent_id:
                        properties = await self._get_device_properties(self.arlo_basestations[parent_id], device_dict)
                    else:
                        properties = await self._get_device_properties(device_dict)
            device = await self._get_device(native_id, properties)
            await device.wait_for_ready()
            if not device:
                self.logger.warning(f'Failed to create device for {device_dict["deviceName"]}, skipping registration.')
                return False
        if isinstance(device, ArloModeVirtualSecuritySystem):
            device.complete_init()
        if native_id.endswith('mvss') and location_name:
            info_overrides = {
                'model': 'Arlo Mode Virtual Security System',
                'manufacturer': 'Arlo',
                'firmware': '1.0',
                'serialNumber': '000',
            }
            device_manifest = device.get_device_manifest(
                name=f'Arlo Mode Virtual Security System {location_name}',
                info_overrides=info_overrides,
                native_id=native_id,
            )
        else:
            device_manifest = device.get_device_manifest()
        self.logger.debug(f'Interfaces for {device_dict["deviceName"]}: {device.get_applicable_interfaces()}')
        if parent_id is None or parent_id in self.hidden_device_ids or native_id == parent_id:
            self._append_unique(provider_to_device_map[None], device_manifest)
        else:
            self._append_unique(provider_to_device_map[parent_id], device_manifest)
        await scrypted_sdk.deviceManager.onDeviceDiscovered(device_manifest)
        for child_manifest in device.get_builtin_child_device_manifests():
            await scrypted_sdk.deviceManager.onDeviceDiscovered(child_manifest)
            self._append_unique(provider_to_device_map[child_manifest['providerNativeId']], child_manifest)
        return True

    def _log_creation_mismatch(self, kind: str, total: int, shown: int) -> None:
        singular = shown == 1
        singular_kind = kind[:-1]
        if total != shown:
            self.logger.info(f'Created {total} {singular_kind if singular else kind}, but{" " if shown == 0 else " only "}{shown} {"are" if not singular else "is"} shown.')
            reason = (
                f'some {kind} are hidden{"" if kind != "camera" else " or are Wi-Fi Cameras"}.'
                if total == 1 else
                f'a {singular_kind} is hidden{"" if singular_kind != "camera" else " or is a Wi-Fi Camera"}.'
            )
            self.logger.info(f'This could be because {reason}')
            self.logger.info(
                f'If a {singular_kind} is not hidden{"" if singular_kind != "camera" else " or is a Wi-Fi Camera"} but is still missing, ensure all {kind} are added correctly in the Arlo App.'
            )
        else:
            self.logger.info(f'Created {shown} {singular_kind if singular else kind}.')

    async def _send_devices_to_scrypted(self, provider_to_device_map: defaultdict[Any, list]) -> None:
        for provider_id in provider_to_device_map.keys():
            if provider_id is None:
                continue
            if '.' not in provider_id:
                for device_dict in (self.arlo_basestations, self.arlo_cameras):
                    device = device_dict.get(provider_id)
                    if device:
                        device_name = device['deviceName']
                self.logger.debug(f'Sending {device_name} and children to scrypted server')
            await scrypted_sdk.deviceManager.onDevicesChanged({
                'devices': provider_to_device_map[provider_id],
                'providerNativeId': provider_id,
            })
        if provider_to_device_map[None]:
            for _, device in self.arlo_mvss.items():
                device_name = device['deviceName']
                self.logger.debug(f'Sending {device_name} to scrypted server')
            await scrypted_sdk.deviceManager.onDevicesChanged({
                'devices': provider_to_device_map[None]
            })

    async def _get_device_properties(self, basestation: dict, camera: dict = None) -> dict:
        properties = {}
        try:
            properties = await asyncio.wait_for(self.arlo.trigger_properties(basestation, camera), timeout=10)
        except Exception as e:
            self.logger.error(f'Error while fetching properties for {camera["deviceId"] if camera else basestation["deviceId"]}: {e}')
        return properties

    def _append_unique(self, manifest_list: list[dict], manifest: dict) -> None:
        if not any(m.get('nativeId') == manifest.get('nativeId') for m in manifest_list):
            manifest_list.append(manifest)

    async def getDevice(self, nativeId: str) -> ArloDeviceBase:
        if not self.disable_plugin:
            all_devices = {**self.arlo_basestations, **self.arlo_cameras, **self.arlo_mvss}
            device = all_devices.get(nativeId)
            if device:
                device_name = device['deviceName']
                self.logger.debug(f'Scrypted requested to load device {device_name}')
            else:
                self.logger.debug(f'Scrypted requested to load device {nativeId}')
        return await self._get_device(nativeId)

    async def _get_device(self, nativeId: str, arlo_properties: dict | None = None) -> ArloDeviceBase:
        device = self.scrypted_devices.get(nativeId)
        if device:
            return device
        if arlo_properties is not None:
            self.logger.debug(f'Device {nativeId} not found, creating new device.')
            device = self._create_device(nativeId, arlo_properties)
            self.scrypted_devices[nativeId] = device
        else:
            self.logger.debug(f'Device {nativeId} not found, it has not been created yet.')
        return device

    def _create_device(self, nativeId: str, arlo_properties: dict) -> ArloDeviceBase:
        if nativeId not in self.arlo_cameras and nativeId not in self.arlo_basestations and nativeId not in self.arlo_mvss:
            self.logger.warning(f'Device {nativeId} not created, it has not been discovered yet.')
            return None
        if nativeId.endswith('mvss'):
            arlo_device = self.arlo_mvss[nativeId]
            arlo_basestation = self.arlo_mvss[nativeId]
            return ArloModeVirtualSecuritySystem(nativeId, arlo_device, arlo_basestation, arlo_properties, self)
        arlo_device = self.arlo_cameras.get(nativeId)
        if not arlo_device:
            arlo_device = self.arlo_basestations[nativeId]
            return ArloBasestation(nativeId, arlo_device, arlo_properties, self)
        if arlo_device['parentId'] not in self.arlo_basestations:
            self.logger.warning(f'Cannot create camera with nativeId {nativeId} when {arlo_device['parentId']} is not a valid basestation')
            return None
        arlo_basestation = self.arlo_basestations[arlo_device['parentId']]
        if arlo_device['deviceType'] == DEVICE_TYPE_DOORBELL:
            return ArloDoorbell(nativeId, arlo_device, arlo_basestation, arlo_properties, self)
        else:
            return ArloCamera(nativeId, arlo_device, arlo_basestation, arlo_properties, self)