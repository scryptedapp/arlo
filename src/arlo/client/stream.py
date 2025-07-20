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
    logger: logging.Logger = StdoutLoggerFactory.get_logger(name='Client')

    def __init__(self, arlo: ArloClient, expire: int = 5) -> None:
        self.arlo: ArloClient = arlo
        self.expire: int = expire
        self.connected: bool = False
        self.reconnecting: bool = False
        self.initializing: bool = True
        self.queues: dict[str, asyncio.Queue[StreamEvent]] = {}
        self.refresh: int = 0
        self.event_stream: mqtt.Client | sse.SSEClient | None = None
        self.event_stream_thread: threading.Thread | None = None
        self.event_stream_stop_event: threading.Event = threading.Event()
        self.refresh_loop_signal: asyncio.Queue[object | None] = asyncio.Queue()
        self.event_loop: asyncio.AbstractEventLoop = asyncio.get_event_loop()
        self.event_loop.create_task(self._refresh_interval())
        self.event_loop.create_task(self._clean_queues())
        self._event_buffer: list[dict[str, Any]] = []

    def __del__(self) -> None:
        self.disconnect()

    @property
    def active(self) -> bool:
        return self.connected or self.reconnecting

    def set_refresh_interval(self, interval: int) -> None:
        self.refresh = interval
        self.refresh_loop_signal.put_nowait(object())

    async def _refresh_interval(self) -> None:
        while not self.event_stream_stop_event.is_set():
            try:
                if self.refresh == 0:
                    signal = await self.refresh_loop_signal.get()
                    if signal is None:
                        return
                    continue
                interval: int = self.refresh * 60
                signal_task = asyncio.create_task(self.refresh_loop_signal.get())
                sleep_task = asyncio.create_task(asyncio.sleep(interval))
                done, pending = await asyncio.wait([signal_task, sleep_task], return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                done_task = done.pop()
                if done_task is signal_task and done_task.result() is None:
                    return
                self.logger.info('Refreshing event stream')
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
        if getattr(self.arlo, 'arlo_discovery_in_progress', False):
            if not self._is_discovery_event(response):
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
        if self.reconnecting:
            return
        self.connected = False
        self.event_stream_stop_event.set()

        def signal_all_queues() -> None:
            for q in self.queues.values():
                q.put_nowait(None)
            self.refresh_loop_signal.put_nowait(None)

        self.event_loop.call_soon_threadsafe(signal_all_queues)

    async def start(self) -> None:
        raise NotImplementedError()

    async def restart(self) -> None:
        raise NotImplementedError()

    def subscribe(self, topics) -> None:
        raise NotImplementedError()