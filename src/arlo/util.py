import asyncio
import contextlib
import logging
import requests
import socket
import ssl

from requests_toolbelt.adapters import host_header_ssl

from .logging import StdoutLoggerFactory

class BackgroundTaskMixin:
    background_tasks: set[asyncio.Task]
    logger: logging.Logger

    def create_task(self, coroutine, tag=None) -> asyncio.Task:
        task = asyncio.get_event_loop().create_task(coroutine)
        if tag:
            setattr(task, '_task_tag', tag)
        self.register_task(task)
        return task

    def register_task(self, task: asyncio.Task) -> None:
        if not hasattr(self, 'background_tasks'):
            self.background_tasks = set()
        assert task is not None

        def print_exception(task: asyncio.Task):
            try:
                exc = task.exception()
            except asyncio.CancelledError:
                return
            if exc:
                self.logger.error(f'task exception: {task.exception()}')

        self.background_tasks.add(task)
        task.add_done_callback(print_exception)
        task.add_done_callback(self.background_tasks.discard)

    def cancel_task(self, task: asyncio.Task) -> None:
        if not hasattr(self, 'background_tasks'):
            return
        if task in self.background_tasks:
            task.cancel()
            self.background_tasks.discard(task)

    def cancel_pending_tasks(self) -> None:
        if not hasattr(self, 'background_tasks'):
            return
        for task in list(self.background_tasks):
            task.cancel()
            self.background_tasks.discard(task)

    def cancel_tasks_by_tag(self, tag: str) -> None:
        if not hasattr(self, 'background_tasks'):
            return
        for task in list(self.background_tasks):
            if getattr(task, '_task_tag', None) == tag:
                task.cancel()
                self.background_tasks.discard(task)

    async def cancel_and_await_tasks_by_tag(self, tag: str):
        if not hasattr(self, 'background_tasks'):
            return
        for task in list(self.background_tasks):
            if getattr(task, '_task_tag', None) == tag:
                if not task.done():
                    task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                self.background_tasks.discard(task)

def float2hex(f: float, max_hexadecimals: int = 15) -> str:
    w = int(f)
    d = f - w
    result = hex(w).replace('0x', '') or '0'
    if d == 0:
        return result
    result += '.'
    count = 0
    while d and count < max_hexadecimals:
        d *= 16
        digit = int(d)
        result += hex(digit).replace('0x', '').upper()
        d -= digit
        count += 1
    return result

async def pick_host_async(hosts: list[str]) -> str:
    return await asyncio.to_thread(_pick_host, hosts)

def _pick_host(hosts: list[str]) -> str:
    socket.setdefaulttimeout(5)
    try:
        session = requests.Session()
        session.mount('https://', host_header_ssl.HostHeaderSSLAdapter())
        for host in hosts:
            try:
                _verify_hostname(host)
                r = session.post(f'https://{host}/api/auth', headers={'Host': 'ocapi-app.arlo.com'})
                r.raise_for_status()
                return host
            except (requests.RequestException, socket.error, ssl.SSLError) as e:
                logger = StdoutLoggerFactory.get_logger(name='Client')
                logger.warning(f'Backup Authentication Host {host} is invalid: {e}')
        raise Exception('No valid backup authentication hosts found!')
    finally:
        socket.setdefaulttimeout(15)

def _verify_hostname(host: str) -> None:
    context = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=5) as sock:
        with context.wrap_socket(sock, server_hostname='ocapi-app.arlo.com'):
            pass