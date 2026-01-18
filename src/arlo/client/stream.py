from __future__ import annotations

import asyncio
import logging
import random
import threading
import time
import uuid

import paho.mqtt.client as mqtt
import sseclient as sse

from typing import Any, TYPE_CHECKING

from ..logging import StdoutLoggerFactory

if TYPE_CHECKING:
    from .client import ArloClient


class StreamEvent:
    def __init__(self, item: dict[str, Any], timestamp: float, expiration: float) -> None:
        self.item: dict[str, Any] = item
        self.timestamp: float = timestamp
        self.expiration: float = expiration
        self.uuid: str = str(uuid.uuid4())

    @property
    def expired(self) -> bool:
        return time.time() > self.expiration


class Stream:
    logger: logging.Logger = StdoutLoggerFactory.get_logger(name='Arlo Client')

    def __init__(self, arlo: ArloClient, expire: int = 5) -> None:
        self.arlo: ArloClient = arlo
        self.provider = self.arlo.provider
        self.expire: int = expire
        self.task_manager = self.arlo.provider.task_manager
        self.connected: bool = False
        self.reconnecting: bool = False
        self.initializing: bool = True
        self.queues: dict[str, asyncio.Queue[StreamEvent]] = {}
        self.refresh: int = 0
        self.event_stream: mqtt.Client | sse.SSEClient | None = None
        self.event_stream_thread: threading.Thread | None = None
        self.event_stream_stop_event: threading.Event = threading.Event()
        self.refresh_loop_signal: asyncio.Queue[object | None] = asyncio.Queue()
        self.event_loop = self.arlo.provider.loop
        self._close_lock = asyncio.Lock()
        self._closed: bool = False
        self._connect_future: asyncio.Future[None] | None = None
        self._refresh_task = self.task_manager.create_task(self._refresh_interval(), tag='stream_refresh', owner=self)
        self._clean_task = self.task_manager.create_task(self._clean_queues(), tag='stream_clean', owner=self)
        self._event_buffer: list[dict[str, Any]] = []

    def _call_soon_threadsafe(self, fn, *args) -> None:
        try:
            self.event_loop.call_soon_threadsafe(fn, *args)
        except Exception:
            pass

    def _stream_name(self) -> str:
        name = self.__class__.__name__
        if name.endswith('EventStream'):
            return name.replace('EventStream', ' Event Stream')
        return name

    def _begin_connect_wait(self) -> asyncio.Future[None]:
        if self._connect_future is not None and not self._connect_future.done():
            try:
                self._connect_future.cancel()
            except Exception:
                pass
        self._connect_future = self.event_loop.create_future()
        return self._connect_future

    def _complete_connect_wait(self) -> None:
        if self._connect_future is not None and not self._connect_future.done():
            self._connect_future.set_result(None)

    def _fail_connect_wait(self, exc: Exception) -> None:
        if self._connect_future is not None and not self._connect_future.done():
            self._connect_future.set_exception(exc)

    async def _await_connected(self, timeout: float) -> None:
        if self._connect_future is None:
            return
        await asyncio.wait_for(self._connect_future, timeout=timeout)

    async def wait_connected(self, timeout: float = 10) -> None:
        if self.connected:
            return
        if self._connect_future is None:
            self._begin_connect_wait()
        await self._await_connected(timeout)

    def _mark_connected(self, log_message: str | None = None) -> None:
        stream_name = self._stream_name()
        self.initializing = False
        self.connected = True
        self.logger.debug(log_message or f'{stream_name} connected.')
        self._complete_connect_wait()

    def __del__(self) -> None:
        try:
            if self.event_loop is not None and not self.event_loop.is_closed() and self.event_loop.is_running():
                asyncio.run_coroutine_threadsafe(self.close(), self.event_loop)
                return
        except Exception:
            pass
        try:
            self.disconnect()
        except Exception:
            pass

    async def close(self) -> None:
        async with self._close_lock:
            if self._closed:
                return
            try:
                self.disconnect()
                try:
                    await self.task_manager.cancel_and_await_by_owner(self)
                except Exception as e:
                    self.logger.debug(f'Error awaiting stream task cancellation: {e}')
                try:
                    await self._close_transport()
                except Exception as e:
                    self.logger.debug(f'Error closing stream transport: {e}')
            finally:
                self._closed = True

    @property
    def active(self) -> bool:
        return self.connected or self.reconnecting

    def set_refresh_interval(self, interval: int) -> None:
        self.refresh = interval
        self.refresh_loop_signal.put_nowait(object())

    async def _refresh_interval(self) -> None:
        stream_name = self._stream_name()
        while not self.event_stream_stop_event.is_set():
            try:
                if self.refresh == 0:
                    signal = await self.refresh_loop_signal.get()
                    if signal is None:
                        return
                    continue
                interval: int = self.refresh * 60
                signal_task = self.task_manager.create_task(self.refresh_loop_signal.get(), tag='stream_refresh_child', owner=self)
                sleep_task = self.task_manager.create_task(asyncio.sleep(interval), tag='stream_refresh_child', owner=self)
                done, pending = await asyncio.wait([signal_task, sleep_task], return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                done_task = done.pop()
                if done_task is signal_task and done_task.result() is None:
                    return
                self.logger.info(f'Refreshing {stream_name}')
                async with self.provider.device_lock:
                    await self.restart()
            except Exception as e:
                self.logger.error(f'Error during stream refresh: {e}')

    async def _clean_queues(self) -> None:
        while not self.event_stream_stop_event.is_set():
            await asyncio.sleep(self.expire * 4)
            for key, queue in list(self.queues.items()):
                await self._clean_queue(key, queue)

    async def _clean_queue(self, key: str, queue: asyncio.Queue[StreamEvent]) -> None:
        items: list[StreamEvent] = []
        num_dropped: int = 0
        while not queue.empty():
            item = queue.get_nowait()
            queue.task_done()
            if not item or item.expired:
                num_dropped += 1
                continue
            items.append(item)
        for item in items:
            queue.put_nowait(item)
        await asyncio.sleep(0.1)

    async def get(
        self,
        resource: str,
        action: str,
        property: str | None = None,
        skip_uuids: set[str] | None = None
    ) -> tuple[StreamEvent | None, str]:
        skip_uuids = skip_uuids or set()
        key = self._make_key(resource, action, property)
        queue = self.queues.setdefault(key, asyncio.Queue())
        first_requeued: StreamEvent | None = None
        while True:
            event: StreamEvent | None = await queue.get()
            queue.task_done()
            if not event:
                return None, action
            if first_requeued is not None and first_requeued == event:
                queue.put_nowait(event)
                await asyncio.sleep(random.uniform(0, 0.01))
                continue
            if event.expired:
                continue
            if event.uuid in skip_uuids:
                queue.put_nowait(event)
                if first_requeued is None:
                    first_requeued = event
                continue
            return event, action

    def _make_key(self, resource: str, action: str, property: str | None = None) -> str:
        return f'{resource}/{action}' + (f'/{property}' if property else '')

    def _queue_response(self, response: dict[str, Any]) -> None:
        if self.arlo.arlo_discovery_in_progress is True:
            if self._should_buffer_during_discovery(response):
                self.logger.debug(f'Buffering event during discovery: {response}')
                self._buffer_event(response)
                return
        self._queue_response_normal(response)

    def _queue_response_normal(self, response: dict[str, Any]) -> None:
        resource: str = response.get('resource')
        action: str = response.get('action')
        now: float = time.time()
        event: StreamEvent = StreamEvent(response, now, now + self.expire)
        self._queue_event(self._make_key(resource, action), event)
        if 'error' in response:
            self._queue_event(self._make_key(resource, 'error'), event)
        props: dict[str, Any] = response.get('properties', {})
        for prop in props.keys():
            self._queue_event(self._make_key(resource, action, prop), event)

    def _is_discovery_event(self, response: dict) -> bool:
        properties: dict[str, Any] = response.get('properties', {})
        return (
            response.get('action') == 'is'
            and isinstance(properties, dict)
            and properties
            and (
                'interfaceVersion' in properties
                or 'localCert' in properties
            )
        )

    def _is_realtime_event(self, response: dict[str, Any]) -> bool:
        resource = response.get('resource', '')
        action = response.get('action')
        properties: dict[str, Any] = response.get('properties', {})
        if not isinstance(properties, dict):
            properties = {}
        if isinstance(resource, str) and resource.startswith('cameras/'):
            if action == 'fullFrameSnapshotAvailable':
                return True
            if action == 'is' and (
                'activityState' in properties
                or 'presignedFullFrameSnapshotUrl' in properties
            ):
                return True
        return False

    def _should_buffer_during_discovery(self, response: dict[str, Any]) -> bool:
        if self._is_discovery_event(response):
            return False
        if self._is_realtime_event(response):
            return False
        return True

    def _buffer_event(self, response: dict) -> None:
        self._event_buffer.append(response)

    def process_buffered_events(self):
        if self._event_buffer:
            self.logger.debug(f'Processing {len(self._event_buffer)} buffered events after discovery.')
            for event in self._event_buffer:
                self._queue_response_normal(event)
            self._event_buffer.clear()

    def _queue_event(self, key: str, event: StreamEvent) -> None:
        self.queues.setdefault(key, asyncio.Queue()).put_nowait(event)

    def requeue(self, event: StreamEvent, resource: str, action: str, property: str | None = None) -> None:
        key = self._make_key(resource, action, property)
        self.queues.setdefault(key, asyncio.Queue()).put_nowait(event)

    def disconnect(self) -> None:
        stream_name = self._stream_name()
        self.logger.debug(f'Disconnecting {stream_name}...')
        self.connected = False
        try:
            self._disconnect_transport_only()
        except Exception as e:
            self.logger.debug(f'Error stopping stream transport during disconnect: {e}')
        self.event_stream_stop_event.set()

        def signal_all_queues() -> None:
            for q in self.queues.values():
                q.put_nowait(None)
            self.refresh_loop_signal.put_nowait(None)

        self._call_soon_threadsafe(signal_all_queues)
        try:
            asyncio.run_coroutine_threadsafe(
                self.task_manager.cancel_and_await_by_owner(self),
                self.event_loop
            )
        except Exception as e:
            self.logger.debug(f'Error scheduling stream task cancellation: {e}')

    def _stop_transport_only(self) -> None:
        self.connected = False
        try:
            self._disconnect_transport_only()
        except Exception as e:
            self.logger.debug(f'Error stopping stream transport: {e}')

    def _disconnect_transport_only(self) -> None:
        return

    async def _close_transport(self) -> None:
        return

    async def start(self) -> None:
        raise NotImplementedError()

    async def restart(self) -> None:
        stream_name = self._stream_name()
        if self.reconnecting:
            return
        self.reconnecting = True
        try:
            self.logger.debug(f'Restarting {stream_name} transport...')
            self._stop_transport_only()
            await asyncio.sleep(0.1)
            self.event_stream = None
            self.event_stream_thread = None
            self.initializing = True
            self.connected = False
            await self.start()
            self.logger.debug(f'{stream_name} transport restart complete.')
        finally:
            self.reconnecting = False

    def subscribe(self, topics) -> None:
        raise NotImplementedError()