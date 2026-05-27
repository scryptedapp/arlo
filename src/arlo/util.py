import asyncio
import time

from typing import Any, Awaitable, Callable


class TaskManager:
    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.tasks: set[asyncio.Task] = set()
        self.task_tags: dict[asyncio.Task, str | None] = {}
        self.task_owners: dict[asyncio.Task, Any] = {}
        self.loop: asyncio.AbstractEventLoop = loop

    def create_task(self, coroutine_or_awaitable, *, tag: str, owner: Any) -> asyncio.Task:
        if not tag:
            raise ValueError('tag is required and must be a non-empty string')
        if owner is None:
            raise ValueError('owner is required')
        if isinstance(coroutine_or_awaitable, asyncio.Task):
            task = coroutine_or_awaitable
            setattr(task, '_task_tag', tag)
            self.register(task, tag=tag, owner=owner)
            return task
        if asyncio.iscoroutine(coroutine_or_awaitable):
            task = self.loop.create_task(coroutine_or_awaitable)
        else:
            task = asyncio.ensure_future(coroutine_or_awaitable)
        setattr(task, '_task_tag', tag)
        self.register(task, tag=tag, owner=owner)
        return task

    def register(self, task: asyncio.Task, tag: str, owner: Any) -> None:
        if task is None:
            return
        if not tag:
            raise ValueError('tag is required and must be a non-empty string')
        if owner is None:
            raise ValueError('owner is required')
        self.tasks.add(task)
        self.task_tags[task] = tag
        self.task_owners[task] = owner

        def _on_done(t: asyncio.Task) -> None:
            task_tag = self.task_tags.get(t)
            task_owner = self.task_owners.get(t)
            self.tasks.discard(t)
            self.task_tags.pop(t, None)
            self.task_owners.pop(t, None)
            if t.cancelled():
                return
            try:
                exc = t.exception()
            except asyncio.CancelledError:
                return
            if exc is None:
                return
            logger = getattr(task_owner, 'logger', None)
            if logger is None:
                provider = getattr(task_owner, 'provider', None)
                logger = getattr(provider, 'logger', None)
            if logger is not None:
                logger.error(
                    f'Background task {task_tag or "unknown"} failed: {exc}',
                    exc_info=(type(exc), exc, exc.__traceback__),
                )

        task.add_done_callback(_on_done)

    def cancel_by_tag(self, tag: str, owner: Any = None) -> None:
        current = asyncio.current_task()
        for t, tg in list(self.task_tags.items()):
            if t is current:
                continue
            if tg == tag and not t.done() and (owner is None or self.task_owners.get(t) == owner):
                t.cancel()

    async def cancel_and_await_by_tag(self, tag: str, owner: Any = None) -> None:
        current = asyncio.current_task()
        tasks = [
            t for t, tg in list(self.task_tags.items())
            if t is not current and tg == tag and (owner is None or self.task_owners.get(t) == owner)
        ]
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def cancel_by_owner(self, owner: Any) -> None:
        current = asyncio.current_task()
        for t, o in list(self.task_owners.items()):
            if t is current:
                continue
            if o == owner and not t.done():
                t.cancel()

    async def cancel_and_await_by_owner(self, owner: Any) -> None:
        current = asyncio.current_task()
        tasks = [t for t, o in list(self.task_owners.items()) if t is not current and o == owner]
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def cancel_all_except(self, tag: str | None = None, owner: Any = None) -> None:
        current = asyncio.current_task()
        for t in list(self.tasks):
            if t is current:
                continue
            t_tag = self.task_tags.get(t)
            t_owner = self.task_owners.get(t)
            if owner is not None and t_owner != owner:
                continue
            if tag is not None and t_tag == tag:
                continue
            if not t.done():
                t.cancel()

    async def cancel_and_await_all_except(self, tag: str | None = None, owner: Any = None) -> None:
        current = asyncio.current_task()
        tasks = [
            t for t in list(self.tasks)
            if t is not current and (owner is None or self.task_owners.get(t) == owner)
            and not (tag is not None and self.task_tags.get(t) == tag)
        ]
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def cancel_all(self) -> None:
        current = asyncio.current_task()
        for t in list(self.tasks):
            if t is current:
                continue
            if not t.done():
                t.cancel()

    async def cancel_and_await_all(self) -> None:
        current = asyncio.current_task()
        tasks = [t for t in list(self.tasks) if t is not current]
        for t in tasks:
            if not t.done():
                t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def list_tasks(self) -> list[tuple[asyncio.Task, str | None, Any]]:
        return [(t, self.task_tags.get(t), self.task_owners.get(t)) for t in list(self.tasks)]


class RequestError(Exception):
    """Base error for request-related failures."""
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retry_after: float | None = None,
        method: str | None = None,
        url: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after
        self.method = method
        self.url = url


class UnauthorizedRestartException(RequestError):
    """Raised when a request proves the Arlo session token is no longer valid."""
    pass


class RateLimitedError(RequestError):
    """Raised when Arlo or Cloudflare asks the plugin to stop sending requests."""
    pass


class TransientRequestError(RequestError):
    """Raised for temporary network or server failures that should not trigger auth."""
    pass


class InvalidResponseError(RequestError):
    """Response could not be parsed or was invalid for expected schema."""
    pass


class BadRequestError(RequestError):
    """HTTP 4xx non-auth client errors that should not trigger restart."""
    pass


class RateLimitPause:
    delay = 65 * 60
    notice_interval = 300

    def __init__(self) -> None:
        self.until: float = 0
        self.next_notice: float = 0

    def remaining(self) -> float:
        return max(0, self.until - time.time())

    def activate(self) -> float:
        now = time.time()
        self.until = now + self.delay
        self.next_notice = now + self.notice_interval
        return max(0, self.until - now)

    def clear_if_elapsed(self) -> bool:
        if not self.until or self.remaining() > 0:
            return False
        self.until = 0
        self.next_notice = 0
        return True

    def should_log_wait(self) -> bool:
        now = time.time()
        if now < self.next_notice:
            return False
        self.next_notice = now + self.notice_interval
        return True

    def format_remaining(self, seconds: float | None = None) -> str:
        seconds = max(0, int(self.remaining() if seconds is None else seconds))
        hours, remainder = divmod(seconds, 3600)
        minutes = (remainder + 59) // 60
        if hours and minutes:
            return f'{hours}h {minutes}m'
        if hours:
            return f'{hours}h'
        return f'{max(1, minutes)}m'


class AuthTransition:
    def __init__(self, manager: 'ErrorManager', reason: str) -> None:
        self.manager = manager
        self.reason = reason
        self._success = False

    def __enter__(self) -> 'AuthTransition':
        self.manager.begin_auth_transition(self.reason)
        return self

    def success(self) -> None:
        self._success = True

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.manager.end_auth_transition(success=self._success and exc_type is None)


class ErrorManager:
    auth_flow_markers = (
        'ocapi-app.arlo.com/api/',
        '/api/auth',
        '/api/getFactorId',
        '/api/getFactors',
        '/api/startAuth',
        '/api/finishAuth',
        '/api/validateAccessToken',
        '/api/startPairingFactor',
        '/hmsweb/users/session',
        '/hmsweb/logout',
        '/hmsweb/client/unsubscribe',
    )

    def __init__(
        self,
        provider: Any,
        *,
        recover_auth: Callable[[str], Awaitable[None]],
        restart_plugin: Callable[[], None],
    ) -> None:
        self.provider = provider
        self.recover_auth = recover_auth
        self.restart_plugin = restart_plugin
        self.rate_limit = RateLimitPause()
        self.auth_ready_event = asyncio.Event()
        self.auth_ready_event.set()
        self.auth_recovery_future: Any = None
        self.auth_depth = 0
        self.auth_reason = ''
        self.auth_started_at = 0.0
        self.auth_succeeded = False
        self.last_auth_success_at = 0.0
        self.loop = getattr(provider, 'loop', None)
        if self.loop is None:
            try:
                self.loop = asyncio.get_running_loop()
            except RuntimeError:
                self.loop = asyncio.get_event_loop()

    @property
    def logger(self) -> Any:
        return self.provider.logger

    @property
    def auth_transition_active(self) -> bool:
        return not self.auth_ready_event.is_set()

    @property
    def rate_limit_until(self) -> float:
        value = self.provider.storage.getItem('arlo_rate_limit_until')
        try:
            return float(value or 0)
        except (TypeError, ValueError):
            self.provider.storage.setItem('arlo_rate_limit_until', 0)
            return 0

    @rate_limit_until.setter
    def rate_limit_until(self, value: float) -> None:
        self.provider.storage.setItem('arlo_rate_limit_until', float(value or 0))

    @property
    def rate_limit_disable_active(self) -> bool:
        return str(self.provider.storage.getItem('arlo_rate_limit_disable_active')).lower() == 'true'

    @rate_limit_disable_active.setter
    def rate_limit_disable_active(self, value: bool) -> None:
        self.provider.storage.setItem('arlo_rate_limit_disable_active', 'true' if value else 'false')

    def auth_transition(self, reason: str) -> AuthTransition:
        return AuthTransition(self, reason)

    def begin_auth_transition(self, reason: str) -> None:
        if self.auth_depth == 0:
            self.logger.debug(f'Arlo auth transition started: {reason}')
            self.auth_started_at = time.time()
            self.auth_succeeded = False
            self.auth_ready_event.clear()
        self.auth_depth += 1
        self.auth_reason = reason

    def end_auth_transition(self, *, success: bool = False) -> None:
        if success:
            self.auth_succeeded = True
            self.last_auth_success_at = time.time()
        if self.auth_depth > 0:
            self.auth_depth -= 1
        if self.auth_depth > 0:
            return
        if not self.auth_ready_event.is_set():
            result = 'succeeded' if self.auth_succeeded else 'ended'
            self.logger.debug(f'Arlo auth transition {result}: {self.auth_reason or "auth refresh"}')
        self.auth_reason = ''
        self.auth_ready_event.set()

    def rate_limit_remaining(self) -> float:
        return max(0, self.rate_limit_until - time.time())

    def format_remaining(self, seconds: float | None = None) -> str:
        return self.rate_limit.format_remaining(seconds)

    def rate_limit_resume_time(self) -> str:
        return time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(self.rate_limit_until))

    def handle_rate_limit_startup(self) -> bool:
        remaining = self.rate_limit_remaining()
        if remaining > 0:
            self.rate_limit_disable_active = True
            self.provider.storage.setItem('disable_plugin', 'true')
            self.logger.warning(
                f'Arlo plugin is disabled because Arlo/Cloudflare returned 429 Too Many Requests. '
                f'Waiting about {self.format_remaining(remaining)} before trying again after '
                f'{self.rate_limit_resume_time()}. '
                f'No Arlo Cloud requests, relogin, or MFA will run during this pause.'
            )
            self._create_task(self._restart_after_rate_limit_pause(), tag='rate_limit_pause')
            return True
        if self.rate_limit_disable_active:
            self.logger.info('Arlo rate-limit pause has ended. Re-enabling plugin.')
            self.clear_rate_limit_pause()
            self.provider.storage.setItem('disable_plugin', 'false')
        return False

    def handle_disable_plugin_setting(self, requested_disable: bool) -> bool:
        remaining = self.rate_limit_remaining()
        if not requested_disable and remaining > 0:
            self.provider.storage.setItem('disable_plugin', 'true')
            self.rate_limit_disable_active = True
            self.logger.warning(
                f'Arlo plugin cannot be re-enabled yet because the Arlo/Cloudflare 429 pause '
                f'has about {self.format_remaining(remaining)} remaining. '
                f'The plugin can be re-enabled after {self.rate_limit_resume_time()}.'
            )
            return False
        if not requested_disable and self.rate_limit_disable_active:
            self.clear_rate_limit_pause()
        self.provider.storage.setItem('disable_plugin', 'true' if requested_disable else 'false')
        verb = 'disabled' if requested_disable else 'enabled'
        self.logger.debug(f'Arlo plugin will be {verb}. Restarting...')
        return True

    def clear_rate_limit_pause(self) -> None:
        self.rate_limit_until = 0
        self.rate_limit_disable_active = False
        self.rate_limit.clear_if_elapsed()

    async def _restart_after_rate_limit_pause(self) -> None:
        remaining = self.rate_limit_remaining()
        if remaining > 0:
            await asyncio.sleep(remaining)
        if self.rate_limit_remaining() > 0:
            self.restart_plugin()
            return
        self.clear_rate_limit_pause()
        self.provider.storage.setItem('disable_plugin', 'false')
        self.logger.info('Arlo rate-limit pause complete. Restarting plugin to resume Arlo Cloud.')
        self.restart_plugin()

    def before_request(self, method: str, url: str, *, suppress_restart_on_401: bool = False) -> None:
        remaining = self.rate_limit_remaining()
        if remaining > 0:
            remaining = self._log_rate_limit_wait(method=method, url=url)
            raise RateLimitedError(
                f'Arlo requests are paused for {int(remaining)} seconds due to rate limiting.',
                status_code=429,
                retry_after=remaining,
                method=method,
                url=url,
            )
        if self.should_defer_cloud_request(url, suppress_restart_on_401=suppress_restart_on_401):
            raise TransientRequestError(
                'Arlo auth refresh is in progress; cloud request was deferred.',
                method=method,
                url=url,
            )

    async def wait_for_auth_ready(
        self,
        url: str = '',
        *,
        timeout: float = 75,
        suppress_restart_on_401: bool = False,
    ) -> None:
        if not self.should_defer_cloud_request(url, suppress_restart_on_401=suppress_restart_on_401):
            return
        reason = self.auth_reason or 'auth refresh'
        self.logger.debug(f'Waiting for Arlo auth transition ({reason}) before cloud request: {url}')
        try:
            await asyncio.wait_for(self.auth_ready_event.wait(), timeout=timeout)
        except asyncio.TimeoutError as e:
            raise TransientRequestError(
                f'Arlo auth transition did not finish within {int(timeout)} seconds.',
                url=url,
            ) from e

    def should_defer_cloud_request(self, url: str, *, suppress_restart_on_401: bool = False) -> bool:
        if suppress_restart_on_401 or self.auth_ready_event.is_set():
            return False
        return not any(marker in url for marker in self.auth_flow_markers)

    def handle_http_error(
        self,
        status_code: int,
        method: str,
        url: str,
        response: Any,
        request_started_at: float | None = None,
        *,
        suppress_restart_on_401: bool = False,
    ) -> dict[str, Any] | None:
        if suppress_restart_on_401 and status_code == 401:
            self.logger.debug(f'Ignoring 401 for cleanup request {method} {url}.')
            return {}
        message = f'HTTP error {status_code} for {method} {url}'
        self.raise_request_error(status_code, message, method, url, request_started_at=request_started_at)
        return None

    def raise_body_error(
        self,
        body: dict[str, Any],
        method: str,
        url: str,
        request_started_at: float | None = None,
    ) -> None:
        meta = body.get('meta', {}) if isinstance(body, dict) else {}
        status_code = meta.get('code') if isinstance(meta, dict) else None
        try:
            status_code = int(status_code)
        except (TypeError, ValueError):
            status_code = None
        message = f'Request ({method} {url}) failed: {body}'
        self.raise_request_error(status_code, message, method, url, request_started_at=request_started_at)

    def raise_request_error(
        self,
        status_code: int | None,
        message: str,
        method: str,
        url: str,
        request_started_at: float | None = None,
    ) -> None:
        if status_code == 401:
            self.request_auth_recovery(message, request_started_at=request_started_at)
            raise UnauthorizedRestartException(message, status_code=status_code, method=method, url=url)
        if status_code == 429:
            retry_after = self._activate_rate_limit(source=message)
            raise RateLimitedError(message, status_code=status_code, retry_after=retry_after, method=method, url=url)
        if status_code in (408, 425) or (status_code is not None and 500 <= status_code < 600):
            raise TransientRequestError(message, status_code=status_code, method=method, url=url)
        raise BadRequestError(message, status_code=status_code, method=method, url=url)

    def mark_http_success(self) -> None:
        if self.rate_limit_disable_active and self.rate_limit_remaining() <= 0:
            self.clear_rate_limit_pause()

    def request_auth_recovery(self, reason: str, *, request_started_at: float | None = None) -> None:
        if self.rate_limit_remaining() > 0:
            self._log_rate_limit_wait(method='AUTH_RECOVERY', url=reason)
            return
        if self._is_stale_auth_error(request_started_at):
            return
        if self.auth_recovery_future and not self.auth_recovery_future.done():
            self.logger.debug(f'Session recovery already in progress. Latest reason: {reason}')
            return
        if self.auth_transition_active:
            self.logger.debug(
                f'Deferring auth recovery until active Arlo auth transition finishes. Latest reason: {reason}'
            )
            self.auth_recovery_future = self._schedule_coroutine(
                self._recover_after_auth_transition(reason, self.auth_started_at),
                tag='auth_recovery',
            )
            return
        self.auth_recovery_future = self._schedule_coroutine(self.recover_auth(reason), tag='auth_recovery')

    def _activate_rate_limit(self, *, source: str = '') -> float:
        remaining = self.rate_limit.activate()
        self.rate_limit_until = self.rate_limit.until
        self.rate_limit_disable_active = True
        self.provider.storage.setItem('disable_plugin', 'true')
        source_text = f' Source: {source}' if source else ''
        self.logger.warning(
            f'Arlo/Cloudflare returned 429 Too Many Requests. '
            f'Disabling Arlo plugin for about {self.format_remaining(remaining)} '
            f'until {self.rate_limit_resume_time()}. '
            f'No Arlo Cloud requests, relogin, or MFA will run during this pause.'
            f'{source_text}'
        )
        self.restart_plugin()
        return remaining

    def _log_rate_limit_wait(self, *, method: str | None = None, url: str | None = None) -> float:
        remaining = self.rate_limit_remaining()
        target = f' {method} {url}' if method and url else ''
        if self.rate_limit.should_log_wait():
            self.logger.warning(
                f'Arlo Cloud requests are still paused for about '
                f'{self.format_remaining(remaining)} after a 429 rate limit. '
                f'Skipping{target}; no network request was sent.'
            )
        else:
            self.logger.debug(
                f'Arlo request skipped during active rate limit pause ({int(remaining)} seconds remaining):'
                f'{target}'
            )
        return remaining

    def _is_stale_auth_error(self, request_started_at: float | None) -> bool:
        if self.auth_transition_active and request_started_at and self.auth_started_at:
            if request_started_at >= self.auth_started_at:
                return False
            self.logger.debug(
                f'Ignoring stale 401 from request that began before active Arlo auth transition: '
                f'{self.auth_reason or "auth refresh"}'
            )
            return True
        if request_started_at and self.last_auth_success_at and request_started_at < self.last_auth_success_at:
            self.logger.debug('Ignoring stale 401 from request that began before the latest successful Arlo auth.')
            return True
        return False

    async def _recover_after_auth_transition(self, reason: str, transition_started_at: float) -> None:
        try:
            await asyncio.wait_for(self.auth_ready_event.wait(), timeout=75)
        except asyncio.TimeoutError:
            self.logger.warning('Arlo auth transition did not finish before deferred recovery; continuing recovery.')
        if self.rate_limit_remaining() > 0:
            self._log_rate_limit_wait(method='AUTH_RECOVERY', url=reason)
            return
        if transition_started_at and self.last_auth_success_at >= transition_started_at:
            self.logger.debug('Skipping deferred auth recovery because the active auth transition succeeded.')
            return
        await self.recover_auth(reason)

    def _create_task(self, coroutine, *, tag: str):
        task_manager = getattr(self.provider, 'task_manager', None)
        if task_manager is not None:
            return task_manager.create_task(coroutine, tag=tag, owner=self.provider)
        create_task = getattr(self.provider, 'create_task', None)
        if create_task is not None:
            return create_task(coroutine)
        return self.loop.create_task(coroutine)

    def _schedule_coroutine(self, coroutine, *, tag: str):
        try:
            running_loop = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        if running_loop is self.loop:
            return self._create_task(coroutine, tag=tag)
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop)
