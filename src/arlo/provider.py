import asyncio
import email
import email.utils
import imaplib
import logging
import re
import requests
import time
import uuid

from bs4 import BeautifulSoup
from collections import defaultdict, OrderedDict
from typing import Any

import scrypted_sdk
from scrypted_sdk import ScryptedDeviceBase
from scrypted_sdk.types import Setting, SettingValue, Settings, DeviceProvider, ScryptedInterface, ScryptedDevice

from .base import ArloDeviceBase
from .basestation import ArloBasestation
from .camera import ArloCamera
from .client import ArloClient
from .doorbell import ArloDoorbell
from .logging import ScryptedDeviceLoggerMixin, StdoutLoggerFactory
from .vss import ArloModeVirtualSecuritySystem
from .util import BackgroundTaskMixin

DEVICE_TYPE_BASESTATION = 'basestation'
DEVICE_TYPE_SIREN = 'siren'
DEVICE_TYPE_CAMERA = 'camera'
DEVICE_TYPE_ARLOQ = 'arloq'
DEVICE_TYPE_ARLOQS = 'arloqs'
DEVICE_TYPE_DOORBELL = 'doorbell'

class ArloProvider(BackgroundTaskMixin, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceLoggerMixin, Settings):
    arlo_event_stream_transport_choices = ['MQTT']
    mfa_strategy_choices = ['Manual', 'IMAP']
    plugin_log_level_choices = {
        'Info': logging.INFO,
        'Debug': logging.DEBUG,
        'Extra Debug': logging.DEBUG,
    }

    def __init__(self, nativeId: str = None) -> None:
        super().__init__(nativeId=nativeId)
        self.logger_name = 'Provider'
        self._arlo: ArloClient = None
        self.arlo_cameras: dict = {}
        self.arlo_basestations: dict = {}
        self.arlo_mvss: dict = {}
        self.scrypted_devices: dict[str, ArloDeviceBase] = {}
        self.all_device_ids: set[str] = set()
        self.login_in_progress: bool = False
        self._login_task: asyncio.Task = None
        self._login_cancel_event: asyncio.Event = asyncio.Event()
        self._imap_ready_event: asyncio.Event = asyncio.Event()
        self._browser_authenticated: asyncio.Future[bool] = asyncio.get_event_loop().create_future()
        self._mfa_code_future: asyncio.Future[str] = asyncio.get_event_loop().create_future()
        self._mfa_loop_future: asyncio.Future[None] = asyncio.get_event_loop().create_future()
        self._mfa_state_future: asyncio.Future[str] = asyncio.get_event_loop().create_future()
        self.device_lock = asyncio.Lock()
        self.propagate_log_level()
        self.initialize_plugin()
        self.create_task(self.onDeviceEvent(ScryptedInterface.Settings.value, None))

    def print(self, *args, **kwargs) -> None:
        print(*args, **kwargs)

    def propagate_log_level(self) -> None:
        try:
            self.print(f'Setting plugin log level to {self.plugin_log_level}')
            log_level = self.get_current_log_level()
            self.storage.setItem('extra_debug_logging', 'true' if self.plugin_log_level == 'Extra Debug' else 'false')
            self.logger.setLevel(log_level)
            for _, device in self.scrypted_devices.items():
                device.logger.setLevel(log_level)
            arlo_client_logger: logging.Logger = StdoutLoggerFactory.get_logger(name='Client')
            arlo_client_logger.setLevel(log_level)
        except Exception as e:
            self.logger.error(f'Error setting log level: {e}', exc_info=True)

    def get_current_log_level(self) -> int:
        return ArloProvider.plugin_log_level_choices[self.plugin_log_level]

    def initialize_plugin(self) -> None:
        if not self.arlo_device_id:
            self.logger.info(f'Setting up Arlo plugin Device ID.')
            _ = self.arlo_device_id
            self.logger.debug(f'Using Device ID: {self.arlo_device_id}')
        else:
            self.logger.debug(f'Arlo plugin Device ID already set: {self.arlo_device_id}')
        if not self.arlo_username or not self.arlo_password:
            self.logger.info('Arlo Cloud username or password not set. Waiting for user to enter credentials.')
            return
        self.cancel_pending_tasks()
        self._login_cancel_event = asyncio.Event()
        self.logger.info('Initializing Arlo plugin and starting login process.')
        self._login_task = self.create_task(self.login(self._login_cancel_event), tag='login')

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
    def extra_debug_logging(self) -> bool:
        logging_val = self.storage.getItem('extra_debug_logging')
        if logging_val is None:
            logging_val = 'false'
            self.storage.setItem('extra_debug_logging', logging_val)
        return str(logging_val).lower() == 'true'

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

    async def login(self, cancel_event: asyncio.Event) -> None:
        if self.login_in_progress:
            self.logger.debug('Login already in progress, waiting for it to complete.')
            return
        self.login_in_progress = True
        try:
            while not cancel_event.is_set():
                try:
                    if self.arlo is not None:
                        self.logger.info('Resetting previous Arlo client.')
                        await self.reset_arlo_client()
                    arlo = ArloClient(self.storage)
                    arlo.browser_authenticated = self._browser_authenticated
                    arlo.mfa_code_future = self._mfa_code_future
                    arlo.mfa_state_future = self._mfa_state_future
                    arlo.mfa_loop_future = self._mfa_loop_future
                    self.logger.debug('Created new ArloClient and assigned MFA futures.')
                    login_task = self.create_task(arlo.login(), tag='login-arlo')
                    self.logger.info('Waiting for MFA state from Arlo Cloud...')
                    mfa_state: str = await self._mfa_state_future
                    self.logger.debug(f'Received MFA state: {mfa_state}')
                    browser_authenticated: bool = await self._browser_authenticated
                    if not browser_authenticated:
                        mfa_start_time = time.time()
                        await self._mfa_loop_future
                        if mfa_state == 'ENABLED':
                            if self.mfa_strategy == 'IMAP':
                                self.logger.info('Using IMAP strategy for MFA code retrieval.')
                                self.create_task(self.imap_mfa_loop(cancel_event, arlo, mfa_start_time), tag='mfa')
                            elif self.mfa_strategy == 'Manual':
                                self.logger.info('Using Manual strategy for MFA code retrieval.')
                                self.create_task(self.manual_mfa_loop(cancel_event, arlo), tag='mfa')
                    await login_task
                    if arlo.logged_in:
                        self.logger.info('Arlo Cloud login successful.')
                        await self.on_login_success(arlo)
                        return
                    else:
                        self.logger.error('Arlo Cloud login failed, retrying in 10 seconds.')
                except asyncio.CancelledError:
                    self.logger.warning('Login to Arlo Cloud was cancelled.')
                    return
                except Exception as e:
                    self.logger.exception(f'Exception during login: {e}')
                finally:
                    self.logger.debug('Cleaning up login and MFA tasks.')
                    await self.cancel_and_await_tasks_by_tag('mfa')
                    await self.cancel_and_await_tasks_by_tag('login-arlo')
                    await self.cancel_and_await_tasks_by_tag('login')
                    if self._login_cancel_event.is_set():
                        self._login_cancel_event.clear()
                await asyncio.sleep(10)
        finally:
            self.login_in_progress = False

    async def reset_arlo_client(self) -> None:
        if self.arlo is not None:
            try:
                await self.arlo.restart()
            except Exception as e:
                self.logger.warning(f'Error restarting Arlo client: {e}')
        self._arlo = None

    async def imap_mfa_loop(self, cancel_event: asyncio.Event, arlo: ArloClient, mfa_start_time: float) -> None:
        while not self.imap_settings_ready():
            if cancel_event.is_set():
                self.logger.debug('IMAP MFA loop cancelled before settings ready.')
                return
            self.logger.info('IMAP MFA settings not ready, waiting for user input.')
            await self._imap_ready_event.wait()
        self.logger.debug('IMAP MFA polling started.')
        mfa_code = await self.poll_imap_for_mfa_code(cancel_event, mfa_start_time)
        if mfa_code:
            if not self._mfa_code_future.done():
                self._mfa_code_future.set_result(mfa_code)
            self.logger.info('IMAP MFA code sent to Arlo client.')
            return
        if not arlo.logged_in and not cancel_event.is_set():
            self.logger.error('IMAP MFA failed or timed out. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()

    async def manual_mfa_loop(self, cancel_event: asyncio.Event, arlo: ArloClient) -> None:
        self.exit_manual_mfa()
        self.manual_mfa_signal = asyncio.Queue()
        self.logger.info(f'Starting manual MFA loop {id(self.manual_mfa_signal)}')
        mfa_code = await self.wait_for_manual_mfa_code(cancel_event)
        if mfa_code:
            if not self._mfa_code_future.done():
                self._mfa_code_future.set_result(mfa_code)
            self.logger.info('Manual MFA code sent to Arlo client.')
            return
        if not arlo.logged_in and not cancel_event.is_set():
            self.logger.error('Manual MFA failed or timed out. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()

    async def on_login_success(self, arlo: ArloClient) -> None:
        self._arlo = arlo
        await self.cancel_and_await_tasks_by_tag('refresh')
        self.create_task(self.refresh_login_loop(), tag='refresh')
        await self.do_arlo_setup()

    async def refresh_login_loop(self) -> None:
        interval_days = self.imap_mfa_interval if self.mfa_strategy == 'IMAP' else 14
        await asyncio.sleep(interval_days * 24 * 60 * 60)
        self.logger.info('MFA refresh interval reached, resetting client and re-logging in.')
        await self.reset_arlo_client()
        self.initialize_plugin()

    def imap_settings_ready(self) -> bool:
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

    async def poll_imap_for_mfa_code(self, cancel_event: asyncio.Event, mfa_start_time: float) -> str:
        code = None
        self.logger.info('Starting IMAP polling for MFA code.')
        loop = asyncio.get_running_loop()
        code = await loop.run_in_executor(None, self._poll_imap_for_mfa_code_sync, mfa_start_time, cancel_event)
        if code:
            self.logger.info(f'Found MFA code: {code}')
        else:
            self.logger.info('IMAP polling finished. No MFA code found.')
        return code

    def _poll_imap_for_mfa_code_sync(self, mfa_start_time: float, cancel_event: asyncio.Event) -> str:
        code = None
        imap = None
        try:
            imap = imaplib.IMAP4_SSL(self.imap_mfa_host, self.imap_mfa_port)
            imap.login(self.imap_mfa_username, self.imap_mfa_password)
            for attempt in range(1, 31):
                if cancel_event.is_set():
                    break
                wait_time = min(2 ** (((attempt - 1) // 5) + 1), 60)
                self.logger.info(f'IMAP search attempt {attempt}/30')
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
                        if msg_time and msg_time < mfa_start_time:
                            self.logger.info(f'No email found yet, will retry after {wait_time}s.')
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
                    if code or cancel_event.is_set():
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
                        if msg_time and msg_time < mfa_start_time:
                            self.logger.info(f'No emails found yet, will retry after {wait_time}s.')
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
                    if code or cancel_event.is_set():
                        break
                    time.sleep(wait_time)
                    continue
                self.logger.info(f'No emails found yet, will retry after {wait_time}s.')
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

    async def wait_for_manual_mfa_code(self, cancel_event: asyncio.Event) -> str:
        code_task = asyncio.create_task(self.manual_mfa_signal.get())
        cancel_task = asyncio.create_task(cancel_event.wait())
        done, pending = await asyncio.wait(
            [code_task, cancel_task],
            return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        if cancel_task in done and cancel_event.is_set():
            self.logger.info('Manual MFA wait cancelled.')
            return None
        if code_task in done:
            code = code_task.result()
            if code is None:
                self.logger.info('Manual MFA loop exit signal received.')
                return None
            return code
        return None

    def exit_manual_mfa(self) -> None:
        if hasattr(self, 'manual_mfa_signal') and self.manual_mfa_signal:
            try:
                self.manual_mfa_signal.put_nowait(None)
            except Exception:
                pass
        self.manual_mfa_signal = None

    async def do_arlo_setup(self) -> None:
        try:
            await self.arlo.subscribe()
            async with self.device_lock:
                await self.discover_devices()
                await self.subscribe_to_event_stream()
                await self.create_devices()
        except requests.exceptions.HTTPError:
            self.logger.exception('HTTP error during Arlo login')
            self.logger.error('Will retry with fresh login')
            await self.reset_arlo_client()
            self.initialize_plugin()
        except Exception:
            self.logger.exception('Unexpected error during Arlo setup')

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
                'title': 'Two Factor Strategy',
                'description': 'Mechanism to fetch the two factor code for Arlo login. Save after changing this field for more settings.',
                'value': self.mfa_strategy,
                'choices': self.mfa_strategy_choices,
            },
        ]
        if self.mfa_strategy == 'Manual':
            results.extend([
                {
                    'group': 'Manual MFA',
                    'key': 'arlo_mfa_code',
                    'title': 'Multi-Factor Authentication Code',
                    'description': 'Enter the code sent by Arlo to your e-mail or phone number.',
                },
                {
                    'group': 'Manual MFA',
                    'key': 'force_mfa_reauth',
                    'title': 'Force Manual MFA Re-Authentication',
                    'description': 'Resets the authentication flow of the plugin. Will also re-do Manual MFA.',
                    'value': False,
                    'type': 'boolean',
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
                    'value': self.imap_mfa_sender,
                    'description': 'The sender email address to search for when loading MFA codes. See plugin README for more details.',
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
                    'value': self.imap_mfa_use_local_index,
                    'type': 'boolean',
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
                'multiple': True,
                'choices': [id for id in self.all_device_ids],
            },
            {
                'group': 'General',
                'key': 'mvss_enabled',
                'title': 'Allow Scrypted to Control Arlo Security Modes',
                'description': 'Enable or Disable allowing Scrypted to handle changing Security Modes in the Arlo App.',
                'value': self.mvss_enabled,
                'type': 'boolean',
            },
        ])
        return results

    async def putSetting(self, key: str, value: SettingValue) -> None:
        if not self.validate_setting(key, value):
            await self.onDeviceEvent(ScryptedInterface.Settings.value, None)
            return
        skip_plugin_reset = False
        if key in ('arlo_username', 'arlo_password'):
            self.storage.setItem(key, value)
            username = self.storage.getItem('arlo_username')
            password = self.storage.getItem('arlo_password')
            skip_plugin_reset = not (username and password)
            if not skip_plugin_reset:
                self.login_in_progress = False
        elif key == 'arlo_mfa_code':
            if getattr(self, 'manual_mfa_signal', None):
                await self.manual_mfa_signal.put(value)
            skip_plugin_reset = True
        elif key == 'force_mfa_reauth':
            self.exit_manual_mfa()
        elif key == 'plugin_log_level':
            self.storage.setItem(key, value)
            self.propagate_log_level()
            skip_plugin_reset = value != 'Extra Debug'
        elif key == 'arlo_event_stream_transport':
            self.storage.setItem(key, value)
        elif key == 'mfa_strategy':
            self.storage.setItem(key, value)
        elif key == 'event_stream_refresh_interval':
            self.storage.setItem(key, value)
            if self.arlo and self.arlo.event_stream:
                self.arlo.event_stream.set_refresh_interval(self.event_stream_refresh_interval)
            skip_plugin_reset = True
        elif key.startswith('imap_mfa'):
            if key == 'imap_mfa_use_local_index':
                self.storage.setItem(key, 'true' if value else 'false')
            else:
                self.storage.setItem(key, value)
            skip_plugin_reset = not self.imap_settings_ready()
        elif key == 'hidden_devices':
            self.storage.setItem(key, value)
            if not self.arlo or not self.arlo.logged_in:
                skip_plugin_reset = True
        elif key == 'mvss_enabled':
            self.storage.setItem(key, 'true' if value else 'false')
            if not self.arlo or not self.arlo.logged_in:
                skip_plugin_reset = True
        else:
            self.storage.setItem(key, value)
        if not skip_plugin_reset:
            if not self.login_in_progress:
                await self.reset_arlo_client()
                self.initialize_plugin()
            else:
                self.logger.debug('Settings changed during login; skipping plugin reset to allow login to complete.')
        await self.onDeviceEvent(ScryptedInterface.Settings.value, None)

    def validate_setting(self, key: str, val: SettingValue) -> bool:
        try:
            if key == 'event_stream_refresh_interval':
                val = int(val)
                if val < 0:
                    raise ValueError('must be nonnegative')
            elif key == 'imap_mfa_port':
                val = int(val)
                if val < 0:
                    raise ValueError('must be nonnegative')
            elif key == 'imap_mfa_interval':
                val = int(val)
                if val < 1 or val > 13:
                    raise ValueError('must be between 1 and 13')
        except ValueError as e:
            self.logger.error(f'Invalid value for {key}: "{val}" - {e}')
            return False
        return True

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
        self.arlo_cameras = {}
        self.arlo_basestations = {}
        self.arlo_mvss = {}
        self.all_device_ids = set()
        self.scrypted_devices = {}
        basestations = await self.arlo.get_devices([DEVICE_TYPE_BASESTATION, DEVICE_TYPE_SIREN], True)
        for basestation in basestations:
            nativeId = basestation['deviceId']
            self.all_device_ids.add(f'{basestation["deviceName"]} ({nativeId})')
            self.logger.debug(f'Adding basestation {nativeId}')
            if nativeId in self.arlo_basestations:
                self.logger.info(f'Skipping basestation {nativeId} ({basestation["modelId"]}) as it has already been added.')
                continue
            self.arlo_basestations[nativeId] = basestation
        self.arlo_basestations = OrderedDict(
            sorted(self.arlo_basestations.items(), key=lambda item: str(item[1]['deviceName']).lower())
        )
        self.logger.debug(f'Found {len(self.arlo_basestations)} basestation(s).')
        cameras = await self.arlo.get_devices([DEVICE_TYPE_CAMERA, DEVICE_TYPE_ARLOQ, DEVICE_TYPE_ARLOQS, DEVICE_TYPE_DOORBELL], True)
        for camera in cameras:
            nativeId = camera['deviceId']
            parentId = camera['parentId']
            self.all_device_ids.add(f'{camera["deviceName"]} ({nativeId})')
            self.logger.debug(f'Adding camera {nativeId}')
            if nativeId != parentId and parentId not in self.arlo_basestations:
                self.logger.info(f'Skipping camera {nativeId} ({camera["modelId"]}) because its basestation was not found.')
                continue
            if nativeId in self.arlo_cameras:
                self.logger.info(f'Skipping camera {nativeId} ({camera["modelId"]}) as it has already been added.')
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
        self.logger.debug(f'Found {len(self.arlo_cameras)} camera(s).')
        if self.mvss_enabled:
            locations = await self.arlo.get_locations()
            self.storage.setItem('one_location', 'false' if len(locations) > 1 else 'true')
            for location in locations:
                nativeId = f'{location}.mvss'
                self.all_device_ids.add(f'Arlo Mode Virtual Security System {locations[location]} ({nativeId})')
                self.logger.debug(f'Adding mode virtual seciruty system {nativeId}')
                if nativeId in self.arlo_mvss:
                    self.logger.info(f'Skipping mode virtual security system {nativeId} as it has already been added.')
                    continue
                self.arlo_mvss[nativeId] = {'location_name': locations[location]}
            self.arlo_mvss = OrderedDict(
                sorted(self.arlo_mvss.items(), key=lambda item: str(item[1]['location_name']).lower())
            )
            self.logger.debug(f'Found {len(self.arlo_mvss)} mode virtual security system(s).')
        self.logger.debug('Done discovering devices.')

    async def subscribe_to_event_stream(self) -> None:
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
                        self.logger.info('Retrying stream setup after short delay...')
                        await asyncio.sleep(5)
                    else:
                        self.logger.error('Stream still failed to connect after retry.')
                        raise
            if self.arlo.event_stream:
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
                self.logger.info(f'Skipping basestation {native_id} as it is also a camera.')
                continue
            try:
                if await self._register_device(native_id, basestation, provider_to_device_map):
                    basestation_devices.append(native_id)
            except Exception as e:
                self.logger.exception(f'Exception registering basestation {native_id}: {e}')
        self._log_creation_mismatch('basestations', len(self.arlo_basestations), len(basestation_devices))
        for native_id, camera in self.arlo_cameras.items():
            parent_id = camera['parentId']
            try:
                if await self._register_device(native_id, camera, provider_to_device_map, parent_id):
                    camera_devices.append(native_id)
            except Exception as e:
                self.logger.exception(f'Exception registering camera {native_id}: {e}')
        self._log_creation_mismatch('cameras', len(self.arlo_cameras), len(camera_devices))
        if self.mvss_enabled:
            for native_id, mvss in self.arlo_mvss.items():
                try:
                    if await self._register_device(native_id, mvss, provider_to_device_map, parent_id=None, location_name=mvss['location_name']):
                        mvss_devices.append(native_id)
                except Exception as e:
                    self.logger.exception(f'Exception registering mvss {native_id}: {e}')
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
            self.logger.info(f'Skipping {native_id} as it is hidden.')
            return False
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
            self.logger.warning(f'Failed to create device for {native_id}')
            return False
        if isinstance(device, ArloModeVirtualSecuritySystem):
            device.complete_init()
        if native_id.endswith('mvss') and location_name:
            info_overrides = {
                'model': 'Arlo Security Mode Security System',
                'manufacturer': 'Arlo',
                'firmware': '1.0',
                'serialNumber': '000',
            }
            device_manifest = device.get_device_manifest(
                name=f'Arlo Security Mode Security System {location_name}',
                info_overrides=info_overrides,
                native_id=native_id,
            )
        else:
            device_manifest = device.get_device_manifest()
        self.logger.debug(f'Interfaces for {native_id}: {device.get_applicable_interfaces()}')
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
        plural = shown > 1
        singular_kind = kind[:-1]
        if total != shown:
            self.logger.info(f'Created {total} {kind if plural else singular_kind}, but only {shown} {"are" if plural else "is"} shown.')
            reason = (
                f'some {kind} are hidden or are Wi-Fi Cameras.'
                if total > 1 else
                f'a {singular_kind} is hidden or is a Wi-Fi Camera.'
            )
            self.logger.info(f'This could be because {reason}')
            self.logger.info(
                f'If a {singular_kind} is not hidden or a Wi-Fi Camera but is still missing, ensure all {kind} are added correctly in the Arlo App.'
            )
        else:
            self.logger.info(f'Created {shown} {kind if plural else singular_kind}.')

    async def _send_devices_to_scrypted(self, provider_to_device_map: defaultdict[Any, list]) -> None:
        for provider_id in provider_to_device_map.keys():
            if provider_id is None:
                continue
            if len(provider_to_device_map[provider_id]) > 0:
                self.logger.debug(f'Sending {provider_id} and children to scrypted server')
            else:
                self.logger.debug(f'Sending {provider_id} to scrypted server')
            await scrypted_sdk.deviceManager.onDevicesChanged({
                'devices': provider_to_device_map[provider_id],
                'providerNativeId': provider_id,
            })
        self.logger.debug('Sending top level devices to scrypted server')
        await scrypted_sdk.deviceManager.onDevicesChanged({
            'devices': provider_to_device_map[None]
        })

    async def _get_device_properties(self, basestation: dict, camera: dict = None) -> dict:
        timeout = 10
        properties = {}
        for attempt in range(3):
            try:
                properties = await asyncio.wait_for(self.arlo.trigger_properties(basestation, camera), timeout=timeout)
                break
            except asyncio.TimeoutError:
                self.logger.error(f'Timeout while fetching properties for {camera["deviceId"] if camera else basestation["deviceId"]}')
            except Exception as e:
                self.logger.error(f'Error while fetching properties for {camera["deviceId"] if camera else basestation["deviceId"]}: {e}')
        else:
            self.logger.error(f'Failed to fetch properties for {camera["deviceId"] if camera else basestation["deviceId"]} after 3 attempts')
        return properties

    def _append_unique(self, manifest_list: list[dict], manifest: dict) -> None:
        if not any(m.get('nativeId') == manifest.get('nativeId') for m in manifest_list):
            manifest_list.append(manifest)

    async def getDevice(self, nativeId: str) -> ArloDeviceBase:
        self.logger.debug(f'Scrypted requested to load device {nativeId}')
        async with self.device_lock:
            return await self._get_device(nativeId)

    async def _get_device(self, nativeId: str, arlo_properties: dict | None = None) -> ArloDeviceBase:
        device = self.scrypted_devices.get(nativeId)
        if not device and (arlo_properties or nativeId.endswith('mvss')):
            self.logger.debug(f'Device {nativeId} not found, creating new device.')
            device = self._create_device(nativeId, arlo_properties)
        elif not device and not arlo_properties:
            self.logger.debug(f"Device {nativeId} not found, it hasn't been created yet.")
            return None
        if device is not None:
            self.scrypted_devices[nativeId] = device
        return device

    def _create_device(self, nativeId: str, arlo_properties: dict) -> ArloDeviceBase:
        if nativeId not in self.arlo_cameras and nativeId not in self.arlo_basestations and nativeId not in self.arlo_mvss:
            self.logger.warning(f"Device {nativeId} not created, it hasn't been discovered yet.")
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