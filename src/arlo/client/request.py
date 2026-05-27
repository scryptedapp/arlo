from __future__ import annotations

import asyncio
import base64
import http.client
import logging
import pickle
import time
import uuid

from curl_cffi.requests import Session as CurlCffiSession
from curl_cffi.requests.exceptions import RequestException as CurlRequestException
from json import JSONDecodeError
from logging import Logger
from requests import Response
from requests.exceptions import RequestException
from typing import Any, TYPE_CHECKING
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from ..logging import StdoutLoggerFactory
from ..util import (
    UnauthorizedRestartException,
    InvalidResponseError,
    BadRequestError,
    RateLimitedError,
    TransientRequestError,
)

if TYPE_CHECKING:
    from ..provider import ArloProvider


class Request:
    logger: Logger = StdoutLoggerFactory.get_logger(name='Arlo Client')

    def __init__(
        self,
        provider: ArloProvider
    ):
        self.provider = provider
        self.error_manager = provider.error_manager
        self.timeout: int = 10
        self.max_retries: int = 3
        self.set_logging()
        try:
            self.session = self._initialize_session()
        except Exception as e:
            raise RuntimeError(f'Failed to initialize HTTP session: {e}')

    def set_logging(self) -> None:
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

    def _initialize_session(self) -> CurlCffiSession:
        self.logger.debug('Impersonating Chrome')
        try:
            return CurlCffiSession(impersonate='chrome')
        except Exception as e:
            self.logger.warning(f'Chrome impersonation failed, falling back to FireFox: {e}')
            return CurlCffiSession(impersonate='firefox')

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
        if not isinstance(body, dict):
            return False
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
        suppress_restart_on_401: bool = False,
    ) -> dict[str, Any] | list[dict[str, Any]]:
        params = params or {}
        headers = headers or {}
        request_started_at = time.time()
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
                self.error_manager.before_request(method, url, suppress_restart_on_401=suppress_restart_on_401)
                response = self._send_request(url, method, params, headers)
                status_code = response.status_code
                if not (200 <= status_code < 300):
                    ignored = self.error_manager.handle_http_error(
                        status_code,
                        method,
                        url,
                        response,
                        request_started_at,
                        suppress_restart_on_401=suppress_restart_on_401,
                    )
                    if ignored is not None:
                        return ignored
                    raise BadRequestError(
                        f'HTTP error {status_code} for {method} {url}',
                        status_code=status_code,
                        method=method,
                        url=url,
                    )
                if 200 <= status_code < 300:
                    if method == 'OPTIONS':
                        self.error_manager.mark_http_success()
                        return {}
                    try:
                        body: dict[str, Any] = response.json()
                        if self.provider.extra_debug_logging:
                            self.logger.debug(f'Response {method} {url}: {body}')
                    except JSONDecodeError as e:
                        self.logger.error(f'Invalid JSON from {url}: {e}')
                        raise InvalidResponseError(f'Invalid JSON response from {url}') from e
                    if raw:
                        self.error_manager.mark_http_success()
                        return body
                    if self._is_success(body):
                        self.error_manager.mark_http_success()
                        return body.get('data', body)
                    self.error_manager.raise_body_error(body, method, url, request_started_at)
                    raise BadRequestError(f'Request ({method} {url}) failed: {body}', method=method, url=url)
            except (UnauthorizedRestartException, RateLimitedError, BadRequestError, InvalidResponseError):
                raise
            except TransientRequestError as e:
                if attempt < self.max_retries - 1:
                    self.logger.warning(f'Temporary HTTP error {method} {url}: {e}. Backoff {backoff}s.')
                    time.sleep(backoff)
                    continue
                raise
            except (RequestException, CurlRequestException) as e:
                if attempt < self.max_retries - 1:
                    self.logger.warning(f'Network error {method} {url}: {e}. Backoff {backoff}s.')
                    time.sleep(backoff)
                    continue
                raise TransientRequestError(f'Network error for {method} {url}: {e}', method=method, url=url) from e
        raise TransientRequestError(f'Failed after {self.max_retries} attempts for {method} {url}')

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
        await self.error_manager.wait_for_auth_ready(
            url,
            suppress_restart_on_401=kwargs.get('suppress_restart_on_401', False),
        )
        return await asyncio.to_thread(self._request, url, 'GET', **kwargs)

    async def options(self, url: str, **kwargs) -> dict[str, Any] | list[dict[str, Any]]:
        await self.error_manager.wait_for_auth_ready(
            url,
            suppress_restart_on_401=kwargs.get('suppress_restart_on_401', False),
        )
        return await asyncio.to_thread(self._request, url, 'OPTIONS', **kwargs)

    async def post(self, url: str, **kwargs) -> dict[str, Any] | list[dict[str, Any]]:
        await self.error_manager.wait_for_auth_ready(
            url,
            suppress_restart_on_401=kwargs.get('suppress_restart_on_401', False),
        )
        return await asyncio.to_thread(self._request, url, 'POST', **kwargs)

    async def put(self, url: str, **kwargs) -> dict[str, Any] | list[dict[str, Any]]:
        await self.error_manager.wait_for_auth_ready(
            url,
            suppress_restart_on_401=kwargs.get('suppress_restart_on_401', False),
        )
        return await asyncio.to_thread(self._request, url, 'PUT', **kwargs)

    def dumps_cookies(self) -> str:
        pickled = pickle.dumps(self.session.cookies.get_dict())
        return base64.b64encode(pickled).decode()

    def loads_cookies(self, cookies: str) -> None:
        decoded = base64.b64decode(cookies)
        cookie_dict = pickle.loads(decoded)
        self.session.cookies.update(cookie_dict)

    def close(self) -> None:
        if hasattr(self.session, 'close'):
            self.session.close()
