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
from requests.exceptions import RequestException
from requests_toolbelt.adapters import host_header_ssl
from typing import Any, TYPE_CHECKING
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from ..logging import StdoutLoggerFactory
from ..util import (
    UnauthorizedRestartException,
    TransientNetworkError,
    RateLimitError,
    InvalidResponseError,
    BadRequestError,
)

if TYPE_CHECKING:
    from ..provider import ArloProvider


class Request:
    logger: Logger = StdoutLoggerFactory.get_logger(name='Client')

    def __init__(
        self,
        timeout: int = 10,
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
            self.logger.debug('Impersonating Chrome')
            try:
                return CurlCffiSession(impersonate='chrome')
            except Exception as e:
                self.logger.warning(f'Chrome impersonation failed, falling back to FireFox: {e}')
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
        return body.get('success') is True

    def _request(
        self,
        url: str,
        method: str = 'GET',
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        raw: bool = False,
        skip_event_id: bool = False,
    ) -> dict[str, Any] | list[dict[str, Any]]:
        params = params or {}
        headers = headers or {}
        if not skip_event_id:
            url = self._add_query_params(url, {
                'eventId': self.gen_event_id(),
                'time': self.get_time(),
            })
        method = method.upper()
        if self.provider.extra_debug_logging:
            self.logger.debug(f'HTTP {method} {url} params={params} headers={headers}')

        for attempt in range(self.max_retries):
            backoff = 2 ** attempt
            try:
                response = self._send_request(url, method, params, headers)
                status_code = response.status_code
                if status_code == 401:
                    self.logger.error(f'HTTP 401 Unauthorized for {method} {url}. Triggering login restart.')
                    self.provider.request_restart(scope='relogin')
                    raise UnauthorizedRestartException('401 Unauthorized')
                if status_code == 429:
                    if attempt < self.max_retries - 1:
                        self.logger.warning(f'429 Rate Limited for {method} {url}. Backoff {backoff}s.')
                        time.sleep(backoff)
                        continue
                    raise RateLimitError(f'Rate limited for {method} {url}')
                if 500 <= status_code < 600:
                    if attempt < self.max_retries - 1:
                        self.logger.warning(f'{status_code} Server error for {method} {url}. Backoff {backoff}s.')
                        time.sleep(backoff)
                        continue
                    raise TransientNetworkError(f'Server error {status_code} for {method} {url}')
                if 400 <= status_code < 500:
                    raise BadRequestError(f'Client error {status_code} for {method} {url}')
                if 200 <= status_code < 300:
                    if method == 'OPTIONS':
                        return {}
                    try:
                        body: dict[str, Any] = response.json()
                        if self.provider.extra_debug_logging:
                            self.logger.debug(f'Response {method} {url}: {body}')
                    except JSONDecodeError as e:
                        self.logger.error(f'Invalid JSON from {url}: {e}')
                        raise InvalidResponseError(f'Invalid JSON response from {url}') from e
                    if raw:
                        return body
                    if self._is_success(body):
                        return body.get('data', body)
                    raise BadRequestError(f'Request ({method} {url}) failed: {body}')
                raise TransientNetworkError(f'Unexpected status {status_code} for {method} {url}')
            except UnauthorizedRestartException:
                raise
            except (RateLimitError, TransientNetworkError, BadRequestError, InvalidResponseError):
                raise
            except RequestException as e:
                if attempt < self.max_retries - 1:
                    self.logger.warning(f'Network error {method} {url}: {e}. Backoff {backoff}s.')
                    time.sleep(backoff)
                    continue
                raise TransientNetworkError(f'Network error for {method} {url}: {e}') from e
        raise TransientNetworkError(f'Failed after {self.max_retries} attempts for {method} {url}')

    def _send_request(
        self,
        url: str,
        method: str,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Response:
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