from __future__ import annotations

import asyncio
import base64
import http.client
import logging
import pickle
import time
import uuid

from curl_cffi.requests import Session as CurlCffiSession
from json import JSONDecodeError
from logging import Logger
from requests import Response, Session
from requests.exceptions import HTTPError, RequestException
from requests_toolbelt.adapters import host_header_ssl
from typing import Any, TYPE_CHECKING
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from ..logging import StdoutLoggerFactory
from ..util import UnauthorizedRestartException

if TYPE_CHECKING:
    from ..provider import ArloProvider

class Request:
    logger: Logger = StdoutLoggerFactory.get_logger(name='Client')

    def __init__(
        self,
        timeout: int = 5,
        mode: str = 'curl',
        max_retries: int = 3,
        provider: ArloProvider | None = None,
    ):
        self.provider: ArloProvider = provider
        self.timeout: int = timeout
        self.max_retries: int = max_retries
        self.mode: str = mode.lower()
        self.set_logging()
        try:
            self.session: CurlCffiSession | Session = self._initialize_session()
        except Exception as e:
            raise RuntimeError(f'Failed to initialize HTTP session for mode "{self.mode}": {e}')

    def set_logging(self):
        provider_logger_level = self.provider.get_current_log_level()
        self.logger.setLevel(provider_logger_level)
        if self.provider.extra_debug_logging:
            http.client.HTTPConnection.debuglevel = 1
            request_logger: Logger = logging.getLogger('requests.packages.urllib3')
            for handler in list(request_logger.handlers):
                request_logger.removeHandler(handler)
            for handler in list(self.logger.handlers):
                request_logger.addHandler(handler)
            request_logger.setLevel(self.logger.level)
            request_logger.propagate = False
        else:
            http.client.HTTPConnection.debuglevel = 0
            request_logger: Logger = logging.getLogger('requests.packages.urllib3')
            for handler in list(request_logger.handlers):
                request_logger.removeHandler(handler)
            request_logger.setLevel(logging.WARNING)
            request_logger.propagate = True

    def _initialize_session(self) -> CurlCffiSession | Session:
        if self.mode == 'curl':
            self.logger.debug('HTTP helper using curl_cffi with impersonation: chrome')
            try:
                return CurlCffiSession(impersonate='chrome')
            except Exception as e:
                self.logger.warning(f'HTTP helper using curl_cffi with chrome impersonation failed, falling back to firefox impersonation: {e}')
                return CurlCffiSession(impersonate='firefox')
        elif self.mode == 'ip':
            self.logger.debug('HTTP helper using requests with HostHeaderSSLAdapter')
            session = Session()
            session.mount('https://', host_header_ssl.HostHeaderSSLAdapter())
            return session
        else:
            self.logger.debug('HTTP helper using default requests')
            return Session()

    def gen_event_id(self) -> str:
        return f'FE!{uuid.uuid4()}'

    def get_time(self) -> int:
        return int(time.time_ns() / 1_000_000)

    def _add_query_params(self, url: str, params: dict[str, Any]) -> str:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        for k, v in params.items():
            query[k] = [str(v)]
        new_query = urlencode(query, doseq=True)
        return urlunparse(parsed._replace(query=new_query))

    def _is_success(self, body: dict[str, Any]) -> bool:
        meta: dict[str, Any] = body.get('meta', {})
        if meta:
            return meta.get('code') == 200
        if body.get('success') is True:
            return True
        return False

    def _request(
        self,
        url: str,
        method: str = 'GET',
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        raw: bool = False,
        skip_event_id: bool = False
    ) -> dict[str, Any] | list[dict[str, Any]]:
        params = params or {}
        headers = headers or {}
        if not skip_event_id:
            event_params = {
                'eventId': self.gen_event_id(),
                'time': self.get_time()
            }
            url = self._add_query_params(url, event_params)
        method = method.upper()
        if self.provider.extra_debug_logging:
            self.logger.debug(f'Performing HTTP {method} to {url} with params={params} headers={headers}')
        for attempt in range(self.max_retries):
            try:
                response = self._send_request(url, method, params, headers)
                if response.status_code == 401:
                    self.logger.error(f'HTTP 401 Unauthorized for {method} {url}, triggering plugin restart.')
                    raise UnauthorizedRestartException('401 Unauthorized')
                response.raise_for_status()
                break
            except RequestException as e:
                response_obj: Response | None = getattr(e, 'response', None)
                if response_obj and getattr(response_obj, 'status_code', None) == 401:
                    self.logger.error(f'HTTP 401 Unauthorized for {method} {url}, triggering plugin restart.')
                    raise UnauthorizedRestartException('401 Unauthorized')
                self.logger.error(f'HTTP {method} request to {url} failed: {e}')
                if attempt < self.max_retries - 1:
                    if response_obj and response_obj.status_code in {429, 500, 502, 503, 504}:
                        time.sleep(2 ** attempt)
                        continue
                raise
        else:
            raise HTTPError(f'HTTP {method} request to {url} failed after {self.max_retries} attempts')
        if method == 'OPTIONS':
            return {}
        try:
            body: dict[str, Any] = response.json()
            if self.provider.extra_debug_logging:
                self.logger.debug(f'Response from {url}: {body}')
        except JSONDecodeError as e:
            self.logger.error(f'JSON decode error from {url}: {e}')
            raise HTTPError(f'Invalid JSON response from {url}', response=response)
        if raw:
            return body
        if self._is_success(body):
            return body.get('data', body)
        else:
            raise HTTPError(f'Request ({method} {url}) failed: {body}', response=response)

    def _send_request(self, url: str, method: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> Response:
        if method == 'GET':
            return self.session.get(url, params=params, headers=headers, timeout=self.timeout)
        elif method == 'OPTIONS':
            return self.session.options(url, headers=headers, timeout=self.timeout)
        elif method == 'POST':
            return self.session.post(url, json=params, headers=headers, timeout=self.timeout)
        elif method == 'PUT':
            return self.session.put(url, json=params, headers=headers, timeout=self.timeout)
        else:
            raise ValueError(f'Unsupported HTTP method: {method}')

    async def get(self, url: str, **kwargs) -> dict[str, Any] | list[dict[str, Any]]:
        return await asyncio.to_thread(self._request, url, 'GET', **kwargs)

    async def options(self, url: str, **kwargs) -> dict[str, Any] | list[dict[str, Any]]:
        return await asyncio.to_thread(self._request, url, 'OPTIONS', **kwargs)

    async def post(self, url: str, **kwargs) -> dict[str, Any] | list[dict[str, Any]]:
        return await asyncio.to_thread(self._request, url, 'POST', **kwargs)

    async def put(self, url: str, **kwargs) -> dict[str, Any] | list[dict[str, Any]]:
        return await asyncio.to_thread(self._request, url, 'PUT', **kwargs)

    def dumps_cookies(self) -> str:
        if self.mode != 'curl':
            raise RuntimeError('Cookie serialization only supported in "curl" mode.')
        pickled = pickle.dumps(self.session.cookies.get_dict())
        return base64.b64encode(pickled).decode()

    def loads_cookies(self, cookies: str) -> None:
        if self.mode != 'curl':
            raise RuntimeError('Cookie deserialization only supported in "curl" mode.')
        decoded = base64.b64decode(cookies)
        cookie_dict = pickle.loads(decoded)
        self.session.cookies.update(cookie_dict)

    def close(self) -> None:
        if hasattr(self.session, 'close'):
            self.session.close()