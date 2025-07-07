import asyncio
import base64
import math
import random
import time

from datetime import datetime, timedelta
from logging import Logger
from scrypted_sdk.other import Storage
from urllib.parse import parse_qs, ParseResult, urlparse
from typing import Any, Callable

import scrypted_sdk

from .mqtt_stream import MQTTEventStream
from .request import Request
from .stream import StreamEvent
from .sse_stream import SSEEventStream
from ..logging import StdoutLoggerFactory
from ..util import float2hex, pick_host_async, UnauthorizedRestartException

logger = StdoutLoggerFactory.get_logger(name='Client')

USER_AGENTS = {
    'arlo':
        '(iPhone15,2 18_1_1) iOS Arlo 5.4.3',
    'iphone':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7_2 like Mac OS X) '
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    'ipad':
        'Mozilla/5.0 (iPad; CPU OS 17_7_2 like Mac OS X) '
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
    'mac':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_3) '
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
    'firefox':
        'Mozilla/5.0 (X11; Linux i686; rv:135.0) '
        'Gecko/20100101 Firefox/135.0',
    'linux':
        'Mozilla/5.0 (X11; Linux x86_64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'android':
        'Mozilla/5.0 (Linux; U; Android 8.1.0; zh-cn; PACM00 Build/O11019) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/57.0.2987.132 MQQBrowser/8.8 Mobile Safari/537.36'
}

VALID_DEVICE_STATES = [
    'provisioned',
    'synced',
]

class ArloClient(object):
    arlo_url: str = 'my.arlo.com'
    arlo_api_url: str = 'myapi.arlo.com'
    auth_url: str = 'ocapi-app.arlo.com'
    backup_auth_hosts: list[str] = ['MzQuMjQxLjU0LjE3MQ==', 'NjMuMzIuMjcuNjk=']

    random.shuffle(backup_auth_hosts)

    def __init__(self, storage: Storage):
        self.storage: Storage = storage
        self.heartbeat_task: asyncio.Task | None = None
        self._devices_cache = None
        self._devices_cache_time = 0
        self._devices_cache_lock = asyncio.Lock()
        self._devices_cache_ttl = 60
        self._device_capabilities_cache = {}
        self._device_capabilities_cache_time = {}
        self._device_capabilities_cache_lock = asyncio.Lock()
        self._device_capabilities_cache_ttl = 60
        self._smart_features_cache = None
        self._smart_features_cache_time = 0
        self._smart_features_cache_lock = asyncio.Lock()
        self._smart_features_cache_ttl = 60
        self._library_cache = {}
        self._library_cache_time = {}
        self._library_cache_lock = asyncio.Lock()
        self._library_cache_ttl = 10
        self._init_persistent()
        self._init_session()

    def _init_persistent(self) -> None:
        self.cookies = self.storage.getItem('arlo_cookies')
        self.device_id = self.storage.getItem('arlo_device_id')
        self.event_stream_transport = self.storage.getItem('arlo_event_stream_transport')
        self.extra_debug_logging = str(self.storage.getItem('extra_debug_logging')).lower() == 'true'
        self.password = self.storage.getItem('arlo_password')
        self.username = self.storage.getItem('arlo_username')
        self.mvss_enabled = self.storage.getItem('mvss_enabled')

    def _init_session(self) -> None:
        self.auth_host: str = None
        self.browser_authenticated: asyncio.Future[bool] | None = None
        self.event_stream: MQTTEventStream | SSEEventStream = None
        self.finialized_login: bool = False
        self.headers: dict[str, str] = None
        self.logged_in: bool = False
        self.mfa_code_future: asyncio.Future[str] | None = None
        self.mfa_loop_future: asyncio.Future[None] | None = None
        self.mfa_state_future: asyncio.Future[str] | None = None
        self.mqtt_url: str = 'mqtt-cluster.arloxcld.com'
        self.mqtt_port: int = 443
        self.mqtt_transport: str = 'tcp'
        self.request: Request = None
        self.token: str = None
        self.user_id: str = None

    async def login(self) -> None:
        try:
            logger.info('Starting Arlo Cloud login...')
            self.headers = self._get_headers()
            self.auth_host = await self._get_auth_host()
            if self.cookies:
                self.request.loads_cookies(self.cookies)
            logger.debug(f'Sending authentication request to {self.auth_host}')
            await self.request.options(f'https://{self.auth_host}/api/auth', headers=self.headers)
            auth_response = await self.request.post(
                f'https://{self.auth_host}/api/auth',
                params={
                    'EnvSource': 'prod',
                    'email': self.username,
                    'language': 'en',
                    'password': str(base64.b64encode(self.password.encode('utf-8')), 'utf-8')
                },
                headers=self.headers,
                skip_event_id=True,
            )
            if not auth_response:
                logger.error('No auth response returned from Arlo Cloud.')
                raise Exception('Arlo Cloud login failed, no auth response returned.')
            auth_response_data: dict[str, Any] = auth_response.get('data', auth_response)
            if not auth_response_data:
                logger.error('No auth response data returned from Arlo Cloud.')
                raise Exception('Arlo Cloud login failed, no auth response data returned.')
            self.user_id = auth_response_data.get('userId')
            self.token = auth_response_data.get('token')
            self.headers = self._get_headers()
            mfa_state: str = auth_response_data.get('MFA_State')
            issued: int = auth_response_data.get('issued')
            if self.mfa_state_future and not self.mfa_state_future.done():
                self.mfa_state_future.set_result(mfa_state)
            if mfa_state == 'ENABLED':
                logger.debug('MFA enabled, starting MFA flow...')
                await self._handle_mfa_flow(issued)
            elif mfa_state == 'DISABLED':
                logger.debug('MFA disabled, continuing login...')
                self._finalize_login()
                await self.user_session()
                self.logged_in = True
        except Exception as e:
            logger.exception(f'Arlo Cloud login failed: {e}')
            raise

    def _get_headers(self) -> dict[str, str]:
        logger.debug('Generating request headers...')
        if self.finialized_login:
            return {
                'Auth-Version': '2',
                'Authorization': self.token,
                'User-Agent': USER_AGENTS['linux'],
                'Content-Type': 'application/json; charset=UTF-8',
            }
        else:
            headers: dict[str, str] = {
                'DNT': '1',
                'schemaVersion': '1',
                'Auth-Version': '2',
                'Content-Type': 'application/json; charset=UTF-8',
                'Origin': f'https://{self.arlo_url}',
                'Referer': f'https://{self.arlo_url}/',
                'Source': 'arloCamWeb',
                'TE': 'Trailers',
                'x-user-device-id': self.device_id,
                'x-user-device-automation-name': 'QlJPV1NFUg==',
                'x-user-device-type': 'BROWSER',
                'X-Service-Version': '3',
                'Priority': 'u=1, i',
                'Host': self.auth_url,
                'User-Agent': USER_AGENTS['linux'],
            }
            if self.token:
                headers['Authorization'] = base64.b64encode(self.token.encode('utf-8')).decode()
            return headers

    async def _get_auth_host(self) -> str:
        try:
            logger.debug('Attempting to use primary authentication host...')
            self.request = Request(extra_debug_logging=self.extra_debug_logging)
            await self.request.options(f'https://{self.auth_url}/api/auth', headers=self.headers)
            logger.info(f'Using primary authentication host: {self.auth_url}')
            return self.auth_url
        except Exception as e:
            logger.warning(f'Primary authentication host failed: {e}. Trying backup hosts...')
            backup_auth_hosts: list[str] = [base64.b64decode(host.encode('utf-8')).decode('utf-8') for host in self.backup_auth_hosts]
            auth_host = await pick_host_async(backup_auth_hosts)
            logger.info(f'Using backup authentication host: {auth_host}')
            self.request = Request(mode='ip', extra_debug_logging=self.extra_debug_logging)
            return auth_host

    async def _handle_mfa_flow(self, issued: int) -> None:
        get_factor_id_response: dict[str, Any] = await self._get_factor_id()
        if not get_factor_id_response:
            logger.error('No factor ID response returned during MFA flow.')
            raise Exception('No factor ID response returned.')
        get_factor_id_meta: dict[str, Any] = get_factor_id_response.get('meta')
        get_factor_id_meta_code: int = get_factor_id_meta.get('code')
        if self.browser_authenticated and not self.browser_authenticated.done():
            self.browser_authenticated.set_result(get_factor_id_meta_code == 200)
        if get_factor_id_meta_code != 200:
            logger.debug('Browser not authenticated, starting browser authentication...')
            get_factors_response: dict[str, Any] = await self._get_factors(issued)
            if not get_factors_response:
                logger.error('No factors response returned during MFA flow.')
                raise Exception('No factors response returned.')
            get_factors_response_data: dict[str, Any] = get_factors_response.get('data', {})
            get_factors_response_data_items: dict[str, Any] = get_factors_response_data.get('items', {})
            factorTypes = [i['factorType'] for i in get_factors_response_data_items]
            factorRoles = [i['factorRole'] for i in get_factors_response_data_items]
            logger.debug(f'factorTypes: {factorTypes}')
            logger.debug(f'factorRoles: {factorRoles}')
            factor_id = next(
                iter([
                    i for i in get_factors_response['data']['items']
                    if (i['factorType'] == 'EMAIL' or i['factorType'] == 'SMS')
                    and i['factorRole'] == 'PRIMARY'
                ]),
                {}
            ).get('factorId')
            if not factor_id:
                raise Exception('Could not find valid 2FA method - is the primary 2FA set to either Email or SMS?')
            start_auth_response: dict[str, Any] = await self._start_auth(factor_id)
            if not start_auth_response:
                logger.error('No start authentication response returned during MFA flow.')
                raise Exception('No start authentication response returned.')
            start_auth_response_data: dict[str, Any] = start_auth_response.get('data', {})
            if not start_auth_response_data:
                logger.error('No start authentication response data returned during MFA flow.')
                raise Exception('No start authentication response data returned.')
            factor_auth_code = start_auth_response_data.get('factorAuthCode')
            if self.mfa_loop_future and not self.mfa_loop_future.done():
                self.mfa_loop_future.set_result(None)
            mfa_code: str = await self._wait_for_mfa_code()
            finish_auth_response: dict[str, Any] = await self._finish_auth(factor_auth_code, mfa_code)
            if not finish_auth_response:
                logger.error('No finish authentication response returned during MFA flow.')
                raise Exception('No finish authentication response returned.')
            finish_auth_response_data: dict[str, Any] = finish_auth_response.get('data', {})
            if not finish_auth_response_data:
                logger.error('No finish authentication response data returned during MFA flow.')
                raise Exception('No finish authentication response data returned.')
            browser_auth_code: str = finish_auth_response_data.get('browserAuthCode')
            self.token = finish_auth_response_data.get('token')
            self.headers = self._get_headers()
            await self._validate_access_token()
            start_pairing_factor_response: dict[str, Any] = await self._start_pairing_factor(browser_auth_code)
            if not start_pairing_factor_response:
                logger.error('No start pairing factor response returned during MFA flow.')
                raise Exception('No start pairing factor response returned.')
            self._finalize_login()
            await self.user_session()
            self.logged_in = True
        elif get_factor_id_meta_code == 200:
            logger.info('Browser authenticated, continuing login...')
            get_factor_id_response_data: dict[str, Any] = get_factor_id_response.get('data', {})
            factor_id: str = get_factor_id_response_data.get('factorId')
            start_auth_response: dict[str, Any] = await self._start_auth(factor_id)
            if not start_auth_response:
                logger.error('No start authentication response returned during MFA flow.')
                raise Exception('No start authentication response returned.')
            start_auth_response_data: dict[str, Any] = start_auth_response.get('data', {})
            if not start_auth_response_data:
                logger.error('No start authentication response data returned during MFA flow.')
                raise Exception('No start authentication response data returned.')
            start_auth_response_data_accesstoken: dict[str, Any] = start_auth_response_data.get('accessToken')
            self.token = start_auth_response_data_accesstoken.get('token')
            self.headers = self._get_headers()
            await self._validate_access_token()
            self._finalize_login()
            await self.user_session()
            self.logged_in = True

    async def _get_factor_id(self) -> dict[str, Any]:
        try:
            logger.debug('Requesting MFA factor ID...')
            get_factor_id_response = await self.request.post(
                f'https://{self.auth_host}/api/getFactorId',
                params={
                    'factorData': '',
                    'factorType': 'BROWSER',
                    'userId': self.user_id
                },
                headers=self.headers,
                raw=True,
                skip_event_id=True,
            )
            return get_factor_id_response
        except Exception as e:
            logger.exception(f'Failed to get MFA factor ID: {e}')
            raise

    async def _get_factors(self, data: str) -> dict[str, Any]:
        try:
            logger.debug('Requesting MFA factors...')
            get_factors_response = await self.request.get(
                f'https://{self.auth_host}/api/getFactors',
                params={'data': data},
                headers=self.headers,
                raw=True,
                skip_event_id=True,
            )
            return get_factors_response
        except Exception as e:
            logger.exception(f'Failed to get MFA factors: {e}')
            raise

    async def _start_auth(self, factor_id: str) -> dict[str, Any]:
        try:
            logger.debug('Starting MFA authentication...')
            params = {
                'factorId': factor_id,
                'factorType': 'BROWSER',
                'userId': self.user_id
            }
            start_auth_response = await self.request.post(
                f'https://{self.auth_host}/api/startAuth',
                params=params,
                headers=self.headers,
                raw=True,
                skip_event_id=True,
            )
            return start_auth_response
        except Exception as e:
            logger.exception(f'Failed to start MFA authentication: {e}')
            raise

    async def _wait_for_mfa_code(self) -> str:
        logger.info('Waiting for MFA code from provider...')
        return await self.mfa_code_future

    async def _finish_auth(self, factor_auth_code: str, mfa_code: str) -> None:
        try:
            logger.debug('Finishing MFA authentication...')
            finish_auth_response = await self.request.post(
                f'https://{self.auth_host}/api/finishAuth',
                params={
                    'factorAuthCode': factor_auth_code,
                    'isBrowserTrusted': True,
                    'otp': mfa_code
                },
                headers=self.headers,
                raw=True,
                skip_event_id=True,
            )
            return finish_auth_response
        except Exception as e:
            logger.exception(f'Failed to finish MFA authentication: {e}')
            raise

    async def _validate_access_token(self) -> None:
        try:
            logger.debug('Validating access token...')
            await self.request.get(
                f'https://{self.auth_host}/api/validateAccessToken?data={int(time.time())}',
                headers=self.headers,
                raw=True,
                skip_event_id=True
            )
        except Exception as e:
            logger.exception(f'Failed to validate access token: {e}')
            raise

    async def _start_pairing_factor(self, factor_auth_code: str) -> None:
        try:
            logger.debug('Starting pairing factor...')
            start_pairing_factor_response = await self.request.post(
                f'https://{self.auth_host}/api/startPairingFactor',
                params={
                    'factorAuthCode': factor_auth_code,
                    'factorData': '',
                    'factorType': 'BROWSER'
                },
                headers=self.headers,
                raw=True,
                skip_event_id=True,
            )
            return start_pairing_factor_response
        except Exception as e:
            logger.exception(f'Failed to start pairing factor: {e}')
            raise

    def _finalize_login(self) -> None:
        self.cookies = self.request.dumps_cookies()
        self.request = Request(extra_debug_logging=self.extra_debug_logging)
        self.request.loads_cookies(self.cookies)
        self.storage.setItem('arlo_cookies', self.cookies)
        self.finialized_login = True
        self.headers = self._get_headers()
        self.request.session.headers.update(self.headers)

    async def user_session(self) -> None:
        session_response = await self.request.get(
            f'https://{self.arlo_api_url}/hmsweb/users/session/v3',
            params={},
            headers=self.headers,
            raw=True,
            skip_event_id=False,
        )
        if session_response.get('success') == True:
            session_response_data: dict[str, Any] = session_response.get('data', {})
            mqtt_url: str = session_response_data.get('mqttUrl')
            if mqtt_url:
                parsed_url: ParseResult = urlparse(mqtt_url)
                self.mqtt_url = f'{parsed_url.hostname}'
                self.mqtt_port = parsed_url.port
                if self.mqtt_port != 443:
                    self.mqtt_transport = 'websockets'
            logger.info('User session established successfully.')
        else:
            logger.warning('Failed to fetch session details')

    async def restart(self) -> None:
        logger.info('Restarting Arlo client: performing full logout and reset and preparing for new login.')
        await self._logout()

    async def _logout(self) -> None:
        logger.info('Logging out of Arlo client.')
        try:
            await self.unsubscribe()
        except Exception as e:
            logger.warning(f'Error during unsubscribe: {e}')
        if self.event_stream:
            try:
                if getattr(self.event_stream, 'connected', False):
                    self.event_stream.disconnect()
            except Exception as e:
                logger.warning(f'Error disconnecting event stream: {e}')
        if self.request:
            try:
                await self.request.put(f'https://{self.arlo_api_url}/hmsweb/logout')
            except Exception as e:
                logger.warning(f'Error during logout request: {e}')
        logger.info('Arlo client logged out.')

    async def get_devices(self, device_type=None, device_state=None) -> list[dict[str, Any]]:
        try:
            devices = await self._get_devices_request()
            if device_type:
                devices = [device for device in devices if device.get('deviceType') in device_type]
            if device_state is not None and device_state:
                devices = [device for device in devices if device.get('state') in VALID_DEVICE_STATES]
            return devices
        except UnauthorizedRestartException:
            logger.error('Session expired (401). Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return []

    async def _get_devices_request(self) -> list[dict[str, Any]]:
        async with self._devices_cache_lock:
            now = time.time()
            if (
                self._devices_cache is not None
                and (now - self._devices_cache_time) < self._devices_cache_ttl
            ):
                return self._devices_cache
            devices = await self.request.get(f'https://{self.arlo_api_url}/hmsweb/v2/users/devices')
            self._devices_cache = devices
            self._devices_cache_time = now
            return devices

    async def get_device_capabilities(self, device: dict) -> dict:
        try:
            return await self._get_device_capabilities_request(str(device['modelId']).lower(), device['interfaceVersion'])
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in get_device_capabilities. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return {}

    async def _get_device_capabilities_request(self, model_id: str, interface_version: str) -> dict:
        key = (model_id, interface_version)
        async with self._device_capabilities_cache_lock:
            now = time.time()
            if (
                key in self._device_capabilities_cache
                and (now - self._device_capabilities_cache_time[key]) < self._device_capabilities_cache_ttl
            ):
                return self._device_capabilities_cache[key]
            result = await self.request.get(
                f'https://{self.arlo_api_url}/resources/capabilities/{model_id}/{model_id}_{interface_version}.json',
                raw=True
            )
            self._device_capabilities_cache[key] = result
            self._device_capabilities_cache_time[key] = now
            return result

    async def get_device_smart_features(self, device) -> dict:
        try:
            smart_features = await self._get_device_smart_features_response()
            features: dict = smart_features.get('features')
            key = f'{device["owner"]["ownerId"]}_{device["deviceId"]}'
            return features.get(key, {})
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in get_device_smart_features. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return {}

    async def _get_device_smart_features_response(self) -> dict:
        async with self._smart_features_cache_lock:
            now = time.time()
            if (
                self._smart_features_cache is not None
                and (now - self._smart_features_cache_time) < self._smart_features_cache_ttl
            ):
                return self._smart_features_cache
            result = await self.request.get(f'https://{self.arlo_api_url}/hmsweb/users/subscription/smart/features')
            self._smart_features_cache = result
            self._smart_features_cache_time = now
            return result

    async def trigger_properties(self, basestation: dict, camera: dict = None) -> dict:
        try:
            properties = {}
            resources = []
            if camera:
                camera_id = camera.get('deviceId')
                camera_parent_id = camera.get('parentId')
                resources.append(f'cameras/{camera_id}')
                if camera_id == camera_parent_id:
                    resources.append('basestation')
            else:
                resources.append('basestation')

            async def trigger(resource):
                await self.request.post(
                    f'https://{self.arlo_api_url}/hmsweb/users/devices/notify/{basestation["deviceId"]}',
                    params={
                        'to': basestation['deviceId'],
                        'from': self.user_id + '_web',
                        'resource': resource,
                        'action': 'get',
                        'publishResponse': False,
                        'transId': self._genTransId(),
                    },
                    headers={'xcloudId': basestation.get('xCloudId')}
                )

            def callback(event: dict):
                if 'error' in event:
                    return None
                resource = event.get('resource')
                resource_properties = event.get('properties', {})
                properties.update(resource_properties)
                return resource_properties

            from_id = basestation.get('deviceId')
            for resource in resources:
                await self._trigger_and_handle_events(
                    resource,
                    [('is', 'interfaceVersion')],
                    lambda: trigger(resource),
                    callback,
                    from_id,
                )
            return properties
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in trigger_properties. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return {}

    async def get_locations(self) -> dict[str, str]:
        try:
            locations = await self._get_locations_response()
            return {
                location['locationId']: location['locationName']
                for location_list in locations.values()
                for location in location_list
            }
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in get_locations. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return {}

    async def _get_locations_response(self) -> dict:
        return await self.request.get(f'https://{self.arlo_api_url}/hmsdevicemanagement/users/{self.user_id}/locations')

    async def get_mode_and_revision(self) -> dict:
        headers = {
            'Origin': f'https://{self.arlo_url}',
            'Referer': f'https://{self.arlo_url}/',
            'x-user-device-id': self.user_id,
            'x-forwarded-user': self.user_id,
        }
        try:
            return await self.request.get(f'https://{self.arlo_api_url}/hmsweb/automation/v3/activeMode?locationId=all', headers=headers)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in get_mode_and_revision. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return {}

    async def set_mode(self, set_mode: str, location: str, next_revision: str) -> None:
        headers = {
            'Origin': f'https://{self.arlo_url}',
            'Referer': f'https://{self.arlo_url}/',
            'x-user-device-id': self.device_id,
            'x-forwarded-user': self.user_id,
        }
        params = {
            'mode': set_mode,
        }
        try:
            await self.request.put(f'https://{self.arlo_api_url}/hmsweb/automation/v3/activeMode?locationId={location}&revision={next_revision}', params=params, headers=headers)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in set_mode. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return

    async def subscribe(self, basestation_camera_tuples: list[tuple[dict[str, Any], dict[str, Any]]] = []) -> None:
        try:
            if not self.event_stream or (not self.event_stream.initializing and not self.event_stream.connected):
                if self.event_stream_transport == 'MQTT':
                    self.event_stream = MQTTEventStream(self)
                elif self.event_stream_transport == 'SSE':
                    self.event_stream = SSEEventStream(self)
                else:
                    raise RuntimeError(f'Unknown event_stream_transport: {self.event_stream_transport}')
                await self.event_stream.start()
            wait_timeout = 10
            waited = 0
            poll_interval = 0.05
            while not self.event_stream.connected and waited < wait_timeout:
                await asyncio.sleep(poll_interval)
                waited += poll_interval
            if not self.event_stream or not self.event_stream.connected:
                raise RuntimeError('Event stream failed to initialize or connect.')
            if basestation_camera_tuples:
                basestations = {b['deviceId']: b for b, _ in basestation_camera_tuples}
                cameras = {c['deviceId']: c for _, c in basestation_camera_tuples}
                devices_to_ping = {
                    b['deviceId']: b for b in basestations.values()
                    if not (
                        b['deviceId'] == b.get('parentId')
                        and b['deviceType'] not in ['doorbell', 'siren', 'arloq', 'arloqs']
                        and str(b['modelId']).lower() not in ['abc1000', 'abc1000a']
                    )
                    and not str(b['modelId']).lower().startswith(('avd2001', 'avd3001', 'avd4001'))
                }
                logger.info(f'Will send heartbeat to the following devices: {list(devices_to_ping.keys())}')
                if hasattr(self, 'heartbeat_task') and self.heartbeat_task:
                    self.heartbeat_task.cancel()
                    try:
                        await self.heartbeat_task
                    except Exception:
                        pass
                    self.heartbeat_task = None
                self.heartbeat_task = asyncio.create_task(self._heartbeat(list(devices_to_ping.values())))
                topics = self._collect_topics(basestations) + self._collect_topics(cameras)
                self.event_stream.subscribe(topics)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in subscribe. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return

    async def _heartbeat(self, basestations: list[dict[str, Any]], interval: int = 30) -> None:
        try:
            while self.event_stream and self.event_stream.active:
                for basestation in basestations:
                    try:
                        await self._ping(basestation)
                    except Exception:
                        pass
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            logger.debug('Heartbeat task cancelled.')

    def _collect_topics(self, devices: dict[Any, dict[str, Any]]) -> list:
        return [topic for d in devices.values() for topic in d.get('allowedMqttTopics', [])]

    async def _ping(self, basestation: dict) -> str | None:
        basestation_id = basestation.get('deviceId')
        return await self._notify(basestation, {
            'action': 'set',
            'resource': f'subscriptions/{self.user_id}_web',
            'publishResponse': False,
            'properties': {'devices': [basestation_id]}
        })

    async def _notify(self, basestation: dict, body: dict) -> str | None:
        basestation_id = basestation.get('deviceId')
        body['transId'] = self._genTransId()
        body['from'] = f'{self.user_id}_web'
        body['to'] = basestation_id
        await self.request.post(
            f'https://{self.arlo_api_url}/hmsweb/users/devices/notify/{body["to"]}',
            params=body,
            headers={'xcloudId': basestation.get('xCloudId')}
        )
        return body.get('transId')

    def _genTransId(self, trans_type: str = 'web') -> str:
        now = datetime.today()
        rand_hex = float2hex(random.random() * math.pow(2, 32)).lower()
        timestamp = int((time.mktime(now.timetuple()) * 1e3 + now.microsecond / 1e3))
        return f'{trans_type}!{rand_hex}!{timestamp}'

    async def unsubscribe(self):
        try:
            if self.event_stream and self.event_stream.connected:
                self.event_stream.disconnect()
                await self.request.get(f'https://{self.arlo_api_url}/hmsweb/client/unsubscribe')
            self.event_stream = None
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in unsubscribe. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            self.event_stream = None

    def subscribe_to_error_events(self, camera: dict, callback: Callable[[Any, Any], Any]) -> asyncio.Task:
        resource = f'cameras/{camera.get('deviceId')}'

        def callbackwrapper(event: dict):
            error: dict = None
            if 'error' in event:
                error = event['error']
            elif 'properties' in event:
                properties: dict = event['properties']
                error = properties.get('stateChangeReason', {})
            if not error:
                return None
            return callback(error.get('code'), error.get('message'))

        return asyncio.create_task(
            self._handle_events(resource, ['error', ('is', 'stateChangeReason')], callbackwrapper)
        )

    def subscribe_to_motion_events(self, camera: dict, callback: Callable, logger: Logger) -> asyncio.Task:
        return self._subscribe_to_motion_or_audio_events(camera, callback, logger, 'motionDetected')

    def subscribe_to_audio_events(self, camera: dict, callback: Callable, logger: Logger) -> asyncio.Task:
        return self._subscribe_to_motion_or_audio_events(camera, callback, logger, 'audioDetected')

    def _subscribe_to_motion_or_audio_events(
        self,
        camera: dict,
        callback: Callable,
        logger: Logger,
        event_key: str
    ) -> asyncio.Task:
        resource = f'cameras/{camera.get("deviceId")}'
        force_reset_event_task: asyncio.Task[None] = None
        delayed_event_end_task: asyncio.Task[None] = None

        def cancel_task(task: asyncio.Task[None], name: str) -> None:
            if task:
                logger.debug(f'{event_key}: cancelling previous {name} task')
                task.cancel()
                return None

        async def reset_event(sleep_duration: float) -> None:
            nonlocal force_reset_event_task, delayed_event_end_task
            await asyncio.sleep(sleep_duration)
            logger.debug(f'{event_key}: False')
            callback(False)
            force_reset_event_task = None
            delayed_event_end_task = None

        def callbackwrapper(event: dict):
            nonlocal force_reset_event_task, delayed_event_end_task
            properties: dict = event.get('properties', {})
            if list(properties.keys()) != [event_key]:
                return None
            event_detected = properties[event_key]
            logger.debug(f'{event_key}: {event_detected}')
            logger.debug(f'{event_key}: {'will delay delivery by 10s' if not event_detected else 'will force reset after 60s'}'.rstrip())
            force_reset_event_task = cancel_task(force_reset_event_task, 'force reset')
            delayed_event_end_task = cancel_task(delayed_event_end_task, 'delay delivery')
            if event_detected:
                stop = callback(event_detected)
                force_reset_event_task = asyncio.create_task(reset_event(60))
            else:
                stop = None
                delayed_event_end_task = asyncio.create_task(reset_event(10))
            return stop

        return asyncio.create_task(
            self._handle_events(resource, [('is', event_key)], callbackwrapper)
        )

    def subscribe_to_smart_motion_events(self, camera: dict, callback: Callable) -> asyncio.Task:
        resource = 'feedNotification'
        unique_id = f'{self.user_id}_{camera.get("deviceId")}'

        def callbackwrapper(event: dict):
            if event.get('uniqueId') == unique_id:
                return callback(event)
            return None

        return asyncio.create_task(
            self._handle_events(resource, [None], callbackwrapper)
        )

    def subscribe_to_battery_events(self, camera: dict, callback: Callable) -> asyncio.Task:
        return self._subscribe_to_property_event(camera, 'batteryLevel', callback)

    def subscribe_to_brightness_events(self, camera: dict, callback: Callable) -> asyncio.Task:
        return self._subscribe_to_property_event(camera, 'brightness', callback)

    def _subscribe_to_property_event(self, camera: dict, property_name: str, callback: Callable) -> asyncio.Task:
        resource = f'cameras/{camera.get("deviceId")}'

        def callbackwrapper(event: dict):
            properties = event.get('properties', {})
            if property_name in properties:
                return callback(properties[property_name])
            return None

        return asyncio.create_task(
            self._handle_events(resource, [('is', property_name)], callbackwrapper)
        )

    def subscribe_to_doorbell_events(self, doorbell: dict, callback: Callable) -> asyncio.Task:
        resource = f'doorbells/{doorbell.get("deviceId")}'

        async def unpress_doorbell():
            await asyncio.sleep(1)
            callback(False)

        def callbackwrapper(event: dict):
            properties: dict = event.get('properties', {})
            if 'buttonPressed' in properties:
                asyncio.create_task(unpress_doorbell())
                return callback(properties.get('buttonPressed'))
            return None

        return asyncio.create_task(
            self._handle_events(resource, [('is', 'buttonPressed')], callbackwrapper)
        )
    
    def subscribe_to_active_mode_events(self, location_id: str, callback: Callable) -> asyncio.Task:
        resource = 'automation/activeMode'

        def callbackwrapper(event: dict):
            if event.get('locationId') != location_id:
                return None
            properties = event.get('properties', {})
            if properties is not None:
                return callback(properties)
            return None

        return asyncio.create_task(
            self._handle_events(resource, ['is'], callbackwrapper)
        )
    
    def subscribe_to_device_state_events(self, device: dict, callback: Callable) -> asyncio.Task:
        device_id = device.get('deviceId', '')
        parent_id = device.get('parentId', '')
        is_wifi_camera = device_id == parent_id
        from_id = device_id
        resources = [
            f'cameras/{device_id}', 'basestation'
        ] if is_wifi_camera else [
            'basestation', f'subscriptions/{self.user_id}_web'
        ]

        def callbackwrapper(event: dict):
            properties: dict = event.get('properties', {})
            resource: str = event.get('resource', '')
            if is_wifi_camera:
                if resource.startswith('cameras/') and properties.get('connectionState') == 'unavailable':
                    return callback('unavailable')
                if resource == 'basestation' and properties.get('connectionState') == 'available':
                    return callback('available')
            else:
                if resource == 'basestation' and properties.get('state') == 'rebooting':
                    return callback('unavailable')
                if resource.startswith('subscriptions/') and device_id in properties.get('devices', []):
                    return callback('available')
            return None

        def get_action(resource: str) -> str | tuple[str, str]:
            if resource.startswith('subscriptions/'):
                return 'is'
            return ('is', 'connectionState') if (resource != 'basestation' or is_wifi_camera) else ('is', 'state')

        tasks = [
            asyncio.create_task(
                self._handle_events(
                    resource,
                    [get_action(resource)],
                    callbackwrapper,
                    from_id
                )
            )
            for resource in resources
        ]
        return asyncio.gather(*tasks)

    def subscribe_to_activity_state_events(self, camera: dict, callback: Callable) -> asyncio.Task:
        device_id = camera.get('deviceId', '')
        parent_id = camera.get('parentId', '')
        from_id = device_id if device_id == parent_id else parent_id
        resource = f'cameras/{device_id}'

        def callbackwrapper(event: dict):
            if 'to' in event:
                return None
            properties = event.get('properties') or {}
            if 'activityState' in properties:
                return callback(properties.get('activityState'))
            return None

        return asyncio.create_task(
            self._handle_events(
                resource,
                [('is', 'activityState')],
                callbackwrapper,
                from_id
            )
        )

    async def trigger_full_frame_snapshot(self, camera: dict) -> str:
        resource = f'cameras/{camera.get("deviceId")}'
        actions = [
            (action, prop)
            for action in ['fullFrameSnapshotAvailable', 'lastImageSnapshotAvailable', 'is']
            for prop in ['presignedFullFrameSnapshotUrl', 'presignedLastImageUrl']
        ]

        async def trigger():
            await self.request.post(
                f'https://{self.arlo_api_url}/hmsweb/users/devices/fullFrameSnapshot',
                params={
                    'to': camera.get('parentId'),
                    'from': f'{self.user_id}_web',
                    'resource': f'cameras/{camera.get("deviceId")}',
                    'action': 'set',
                    'publishResponse': True,
                    'transId': self._genTransId(),
                    'properties': {
                        'activityState': 'fullFrameSnapshot'
                    }
                },
                headers={'xcloudId': camera.get('xCloudId')}
            )

        def callback(event: dict):
            if 'error' in event:
                return None
            properties: dict = event.get('properties', {})
            return (
                properties.get('presignedFullFrameSnapshotUrl')
                or properties.get('presignedLastImageUrl')
            )

        return await self._trigger_and_handle_events(
            resource,
            actions,
            trigger,
            callback,
        )

    async def start_stream(self, camera: dict, mode: str = 'rtsp', eager: bool = True) -> str:
        resource = f'cameras/{camera.get("deviceId")}'
        if mode not in ['rtsp', 'dash']:
            raise ValueError('mode must be "rtsp" or "dash"')

        stream_url_dict = {}

        async def trigger():
            ua = USER_AGENTS['android'] if mode == 'rtsp' else USER_AGENTS['firefox']
            resp = await self.request.post(
                f'https://{self.arlo_api_url}/hmsweb/users/devices/startStream',
                params={
                    'to': camera.get('parentId'),
                    'from': f'{self.user_id}_web',
                    'resource': f'cameras/{camera.get("deviceId")}',
                    'action': 'set',
                    'responseUrl': '',
                    'publishResponse': True,
                    'transId': self._genTransId(),
                    'properties': {
                        'activityState': 'startUserStream',
                        'cameraId': camera.get('deviceId')
                    }
                },
                headers={'xcloudId': camera.get('xCloudId'), 'User-Agent': ua}
            )
            url: str = resp['url']
            if mode == 'rtsp':
                url = url.replace('rtsp://', 'rtsps://')
            else:
                url = url.replace(':80', '')
            stream_url_dict['url'] = url

        if eager:
            await trigger()
            return stream_url_dict['url']

        def callback(event: dict):
            if 'error' in event:
                return None
            properties: dict = event.get('properties', {})
            if properties.get('activityState') == 'userStreamActive':
                return stream_url_dict['url']
            return None

        actions = [('is', 'activityState')]

        return await self._trigger_and_handle_events(
            resource,
            actions,
            trigger,
            callback,
        )

    def subscribe_to_answer_candidate(self, camera: dict, callback: Callable) -> asyncio.Task:
        return self._subscribe_to_push_to_talk_event(camera, callback, 'answerCandidate')

    def subscribe_to_answer_sdp(self, camera: dict, callback: Callable) -> asyncio.Task:
        return self._subscribe_to_push_to_talk_event(camera, callback, 'answerSdp')

    def _subscribe_to_push_to_talk_event(
        self,
        camera: dict,
        callback: Callable,
        event_type: str
    ) -> asyncio.Task:
        resource = f'cameras/{camera.get("deviceId")}'

        def callbackwrapper(event: dict):
            properties: dict = event.get('properties', {})
            if properties.get('type') == event_type:
                return callback(properties.get('data'))
            return None

        return asyncio.create_task(
            self._handle_events(resource, ['pushToTalk'], callbackwrapper)
        )

    async def _handle_events(
        self,
        resource: str,
        actions: list,
        callback: Callable[[dict], Any],
        from_id: str = None,
    ) -> Any:
        if not callable(callback):
            raise Exception('The callback should be a callable function.')

        await self.subscribe()

        async def loop_action_listener(action):
            prop = None
            if isinstance(action, tuple):
                action, prop = action
            if action is not None and not isinstance(action, str):
                raise Exception('Actions must be either None, a tuple, or a str')
            seen_events: dict[str, StreamEvent] = {}
            while self.event_stream and self.event_stream.active:
                event, _ = await self.event_stream.get(resource, action, prop, set(seen_events.keys()))
                if (
                    event is None
                    or self.event_stream is None
                    or self.event_stream.event_stream_stop_event.is_set()
                ):
                    return None
                seen_events[event.uuid] = event
                event_from = event.item.get('from')
                if from_id is not None and event_from != from_id:
                    self.event_stream.requeue(event, resource, action, prop)
                    continue
                response = callback(event.item)
                self.event_stream.requeue(event, resource, action, prop)
                if response is not None:
                    return response
                expired = [uuid for uuid, ev in seen_events.items() if ev.expired]
                for uuid in expired:
                    del seen_events[uuid]
        if self.event_stream and self.event_stream.active:
            listeners = [asyncio.create_task(loop_action_listener(action)) for action in actions]
            done, pending = await asyncio.wait(listeners, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            return next(iter(done)).result()

    async def _trigger_and_handle_events(
        self,
        resource: str,
        actions: list,
        trigger: Callable[[], None],
        callback: Callable[[dict], Any],
        from_id: str = None,
    ) -> Any:
        if trigger is not None and not callable(trigger):
            raise Exception('The trigger should be a callable function.')
        if not callable(callback):
            raise Exception('The callback should be a callable function.')
        await self.subscribe()
        if trigger:
            await trigger()
        return await self._handle_events(resource, actions, callback, from_id)

    def get_mpd_headers(self, url: str) -> dict:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        return {
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'DNT': '1',
            'Egress-Token': query.get('egressToken', [''])[0],
            'Origin': f'https://{self.arlo_url}',
            'Referer': f'https://{self.arlo_url}/',
            'User-Agent': USER_AGENTS['firefox'],
        }

    async def get_sip_info(self):
        try:
            return await self.request.get(f'https://{self.arlo_api_url}/hmsweb/users/devices/sipInfo')
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in get_sip_info. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def get_sip_info_v2(self, camera: dict):
        url = (
            f'https://{self.arlo_api_url}/hmsweb/users/devices/sipInfo/v2'
            f'?cameraId={camera.get("deviceId")}'
            f'&modelId={str(camera.get("modelId", "")).upper()}'
            f'&uniqueId={camera.get("uniqueId")}'
        )
        headers = {
            'xcloudId': camera.get('xCloudId'),
            'cameraId': camera.get('deviceId'),
        }
        try:
            return await self.request.get(url, headers=headers)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in get_sip_info_v2. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def start_push_to_talk(self, camera: dict) -> tuple[str, list[dict]]:
        try:
            response = await self.request.get(f'https://{self.arlo_api_url}/hmsweb/users/devices/{self.user_id}_{camera.get("deviceId")}/pushtotalk')
            return response.get('uSessionId'), response.get('data')
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in start_push_to_talk. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None, None

    async def notify_push_to_talk_offer_sdp(self, basestation: dict, camera: dict, uSessionId: str, localSdp: str):
        try:
            await self._notify_push_to_talk(basestation, camera, uSessionId, localSdp, 'offerSdp', publish_response=True)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in notify_push_to_talk_offer_sdp. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()

    async def notify_push_to_talk_offer_candidate(self, basestation: dict, camera: dict, uSessionId: str, localCandidate: str):
        try:
            await self._notify_push_to_talk(basestation, camera, uSessionId, localCandidate, 'offerCandidate', publish_response=False)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in notify_push_to_talk_offer_candidate. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()

    async def _notify_push_to_talk(self, basestation: dict, camera: dict, uSessionId: str, data: str, data_type: str, publish_response: bool):
        resource = f'cameras/{camera.get("deviceId")}'
        await self._notify(basestation, {
            'action': 'pushToTalk',
            'resource': resource,
            'publishResponse': publish_response,
            'properties': {
                'data': data,
                'type': data_type,
                'uSessionId': uSessionId
            }
        })

    async def siren_on(self, basestation, camera=None):
        try:
            return await self._set_child_device(basestation, camera, 'siren', 'on')
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in siren_on. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def siren_off(self, basestation, camera=None):
        try:
            return await self._set_child_device(basestation, camera, 'siren', 'off')
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in siren_off. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def spotlight_on(self, basestation, camera):
        try:
            return await self._set_child_device(basestation, camera, 'spotlight', True)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in spotlight_on. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def spotlight_off(self, basestation, camera):
        try:
            return await self._set_child_device(basestation, camera, 'spotlight', False)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in spotlight_off. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def floodlight_on(self, basestation, camera):
        try:
            return await self._set_child_device(basestation, camera, 'floodlight', True)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in floodlight_on. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def floodlight_off(self, basestation, camera):
        try:
            return await self._set_child_device(basestation, camera, 'floodlight', False)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in floodlight_off. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def nightlight_on(self, basestation):
        try:
            return await self._set_child_device(basestation, None, 'nightLight', True)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in nightlight_on. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def nightlight_off(self, basestation):
        try:
            return await self._set_child_device(basestation, None, 'nightLight', False)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in nightlight_off. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def brightness_set(self, basestation, camera, brightness=0):
        try:
            return await self._set_child_device(basestation, camera, 'brightness', brightness)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in brightness_set. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return None

    async def _set_child_device(
        self,
        basestation: dict,
        camera: dict = None,
        device_type: str = '',
        state: bool | str = False,
        extra_properties: dict = None
    ):
        if device_type == 'nightLight':
            device_id = basestation.get('deviceId')
            properties = {'nightLight': {'enabled': state}}
        elif device_type == 'spotlight':
            device_id = camera.get('deviceId')
            properties = {'spotlight': {'enabled': state}}
        elif device_type == 'floodlight':
            device_id = camera.get('deviceId')
            properties = {'floodlight': {'on': state}}
        elif device_type == 'siren':
            resource = f'siren/{camera.get("deviceId")}' if camera is not None else 'siren'
            properties = {
                'sirenState': state,
                'duration': 300,
                'volume': 8,
                'pattern': 'alarm'
            }
            if extra_properties:
                properties.update(extra_properties)
            return self._notify(basestation, {
                'action': 'set',
                'resource': resource,
                'publishResponse': True,
                'properties': properties,
            })
        elif device_type == 'brightness':
            device_id = camera.get('deviceId')
            properties = {'brightness': state}
        else:
            raise ValueError(f'Unknown device_type: {device_type}')

        resource = f'cameras/{device_id}'
        if extra_properties:
            for k, v in extra_properties.items():
                if isinstance(properties.get(device_type), dict):
                    properties[device_type][k] = v
                else:
                    properties[k] = v

        return await self._notify(basestation, {
            'action': 'set',
            'resource': resource,
            'publishResponse': True,
            'properties': properties,
        })

    async def restart_device(self, deviceId: str) -> None:
        try:
            headers = {
                'Origin': f'https://{self.arlo_api_url}',
                'Referer': f'https://{self.arlo_api_url}/',
                'x-user-device-id': self.device_id,
                'x-forwarded-user': self.user_id,
            }
            params = {
                'deviceId': deviceId,
            }
            await self.request.post(f'https://{self.arlo_api_url}/hmsweb/users/devices/restart', params=params, headers=headers)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in restart_device. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return

    async def get_library(self, device, from_date: datetime, to_date: datetime, no_cache=False):
        try:
            from_date_str, to_date_str = self._format_library_dates(from_date, to_date)
            library_results = (
                await self._get_library(from_date_str, to_date_str)
                if no_cache
                else await self._get_library_cached(from_date_str, to_date_str)
            )
            return self._filter_library_results(library_results, device, from_date, to_date)
        except UnauthorizedRestartException:
            logger.error('Session expired (401) in get_library. Restarting plugin.')
            await scrypted_sdk.deviceManager.requestRestart()
            return []

    def _format_library_dates(self, from_date: datetime, to_date: datetime) -> tuple[str, str]:
        from_date_internal = from_date - timedelta(days=1)
        to_date_internal = to_date + timedelta(days=1)
        return from_date_internal.strftime('%Y%m%d'), to_date_internal.strftime('%Y%m%d')

    def _filter_library_results(self, results, device, from_date, to_date):
        device_id = device['deviceId']
        def in_range(result):
            ts = datetime.fromtimestamp(int(result['name']) / 1000.0)
            return result['deviceId'] == device_id and from_date <= ts <= to_date
        return [result for result in results if in_range(result)]

    async def _get_library_cached(self, from_date: str, to_date: str):
        key = (from_date, to_date)
        async with self._library_cache_lock:
            now = time.time()
            if (
                key in self._library_cache
                and (now - self._library_cache_time[key]) < self._library_cache_ttl
            ):
                return self._library_cache[key]
            logger.debug(f'Library cache miss for {from_date}, {to_date}')
            result = await self._get_library(from_date, to_date)
            self._library_cache[key] = result
            self._library_cache_time[key] = now
            return result

    async def _get_library(self, from_date: str, to_date: str):
        return await self.request.post(
            f'https://{self.arlo_api_url}/hmsweb/users/library',
            params={
                'dateFrom': from_date,
                'dateTo': to_date
            }
        )