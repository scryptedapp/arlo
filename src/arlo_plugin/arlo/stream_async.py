# This file has been modified to support async semantics and better
# integration with scrypted.
# Original: https://github.com/jeffreydwalter/arlo

##
# Copyright 2016 Jeffrey D. Walter
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
##

import asyncio
import random
import threading
import time
import uuid

from .logging import logger


class StreamEvent:
    def __init__(self, item, timestamp, expiration):
        self.item = item
        self.timestamp = timestamp
        self.expiration = expiration
        self.uuid = str(uuid.uuid4())

    @property
    def expired(self):
        return time.time() > self.expiration


class Stream:
    """Queue-based EventStream with async support."""

    def __init__(self, arlo, expire=5):
        self.arlo = arlo
        self.expire = expire
        self.connected = False
        self.reconnecting = False
        self.initializing = True

        self.queues = {}
        self.refresh = 0
        self.event_stream = None
        self.event_stream_thread = None
        self.event_stream_stop_event = threading.Event()

        self.refresh_loop_signal = asyncio.Queue()
        self.event_loop = asyncio.get_event_loop()
        self.event_loop.create_task(self._refresh_interval())
        self.event_loop.create_task(self._clean_queues())

    def __del__(self):
        self.disconnect()

    @property
    def active(self):
        return self.connected or self.reconnecting

    def set_refresh_interval(self, interval):
        self.refresh = interval
        self.refresh_loop_signal.put_nowait(object())

    async def _refresh_interval(self):
        while not self.event_stream_stop_event.is_set():
            try:
                if self.refresh == 0:
                    # Wait until an interval is set
                    signal = await self.refresh_loop_signal.get()
                    if signal is None:
                        return  # Exit signal received
                    continue

                interval = self.refresh * 60  # Convert minutes to seconds
                signal_task = asyncio.create_task(self.refresh_loop_signal.get())
                sleep_task = asyncio.create_task(asyncio.sleep(interval))

                # Wait until either a signal is received or the interval expires
                done, pending = await asyncio.wait([signal_task, sleep_task], return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()

                done_task = done.pop()
                if done_task is signal_task and done_task.result() is None:
                    return  # Exit signal received

                logger.info("Refreshing event stream")
                await self.restart()
            except Exception as e:
                logger.error(f"Error during stream refresh: {e}")

    async def _clean_queues(self):
        while not self.event_stream_stop_event.is_set():
            await asyncio.sleep(self.expire * 4)
            for key, queue in list(self.queues.items()):
                await self._clean_queue(key, queue)

    async def _clean_queue(self, key, queue):
        items, num_dropped = [], 0
        while not queue.empty():
            item = queue.get_nowait()
            queue.task_done()
            if not item or item.expired:
                num_dropped += 1
                continue
            items.append(item)

        for item in items:
            queue.put_nowait(item)

        await asyncio.sleep(0.1)  # Yield to other tasks

    async def get(self, resource, action, property=None, skip_uuids=None):
        skip_uuids = skip_uuids or set()
        key = self._make_key(resource, action, property)
        queue = self.queues.setdefault(key, asyncio.Queue())

        first_requeued = None
        while True:
            event = await queue.get()
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

    def _make_key(self, resource, action, property=None):
        return f"{resource}/{action}" + (f"/{property}" if property else "")

    def _queue_response(self, response):
        resource = response.get("resource")
        action = response.get("action")
        now = time.time()
        event = StreamEvent(response, now, now + self.expire)

        # Basic response
        self._queue_event(self._make_key(resource, action), event)

        # Error response
        if 'error' in response:
            self._queue_event(self._make_key(resource, "error"), event)

        # Property-specific
        for prop in response.get("properties", {}).keys():
            self._queue_event(self._make_key(resource, action, prop), event)

    def _queue_event(self, key, event):
        self.queues.setdefault(key, asyncio.Queue()).put_nowait(event)

    def requeue(self, event, resource, action, property=None):
        key = self._make_key(resource, action, property)
        self.queues.setdefault(key, asyncio.Queue()).put_nowait(event)

    def disconnect(self):
        if self.reconnecting:
            return

        self.connected = False
        self.event_stream_stop_event.set()

        def signal_all_queues():
            for q in self.queues.values():
                q.put_nowait(None)
            self.refresh_loop_signal.put_nowait(None)

        self.event_loop.call_soon_threadsafe(signal_all_queues)

    # To be implemented by subclass
    async def start(self):
        raise NotImplementedError()

    async def restart(self):
        raise NotImplementedError()

    def subscribe(self, topics):
        raise NotImplementedError()