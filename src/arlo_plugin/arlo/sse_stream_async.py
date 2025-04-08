import asyncio
import json
import threading
import sseclient

import scrypted_arlo_go

from .stream_async import Stream
from .logging import logger


class GoSSEStream(Stream):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.shutting_down_stream = None

    async def start(self):
        if self.event_stream is not None:
            logger.debug("Go SSE event stream already initialized. Skipping start.")
            return

        logger.debug("Initializing Go SSE event stream...")

        def thread_main(self):
            event_stream = self.event_stream
            try:
                while True:
                    try:
                        event = event_stream.Next()
                    except Exception:
                        logger.info(f"Go SSE {event_stream.UUID} exited.")
                        if self.shutting_down_stream is event_stream:
                            self.shutting_down_stream = None
                        return

                    logger.debug(f"Received Go SSE event: {event}")
                    if not event.strip():
                        continue

                    try:
                        response = json.loads(event.strip())
                    except json.JSONDecodeError:
                        logger.warning("Failed to decode Go SSE event.")
                        continue

                    if response.get("action") == "logout":
                        if self.event_stream_stop_event.is_set() or self.shutting_down_stream is event_stream:
                            logger.info(f"Go SSE {event_stream.UUID} disconnected.")
                            event_stream.Close()
                            self.shutting_down_stream = None
                            return
                    elif response.get("status") == "connected":
                        if not self.connected:
                            logger.info(f"Go SSE {event_stream.UUID} connected.")
                            self.initializing = False
                            self.connected = True
                    else:
                        self.event_loop.call_soon_threadsafe(self._queue_response, response)

            except Exception:
                logger.exception("Unhandled exception in Go SSE thread.")
                self.event_loop.call_soon_threadsafe(self.event_loop.create_task, self.restart())

        try:
            self.event_stream = scrypted_arlo_go.NewSSEClient(
                'https://myapi.arlo.com/hmsweb/client/subscribe?token=' +
                self.arlo.request.session.headers.get('Authorization'),
                scrypted_arlo_go.HeadersMap(self.arlo.request.session.headers)
            )
            self.event_stream.Start()

            self.event_stream_thread = threading.Thread(
                name="GoSSEStream",
                target=thread_main,
                args=(self,)
            )
            self.event_stream_thread.daemon = True
            self.event_stream_thread.start()

            while not self.connected and not self.event_stream_stop_event.is_set():
                await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"Failed to initialize Go SSE client: {e}")

    async def restart(self):
        logger.debug("Restarting Go SSE stream...")
        self.reconnecting = True
        self.connected = False

        if self.event_stream:
            self.shutting_down_stream = self.event_stream
            self.shutting_down_stream.Close()
            self.event_stream = None

        await self.start()

        while self.shutting_down_stream is not None:
            await asyncio.sleep(1)

        self.reconnecting = False

    def subscribe(self, topics):
        logger.debug("subscribe() called, but Go SSE does not support topic subscriptions.")
        pass


class PySSEStream(Stream):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.shutting_down_stream = None

    async def start(self):
        if self.event_stream is not None:
            logger.debug("Python SSE event stream already initialized. Skipping start.")
            return

        logger.debug("Initializing Python SSE event stream...")

        def thread_main(self: PySSEStream):
            event_stream = self.event_stream
            try:
                for event in event_stream:
                    if event is None:
                        logger.warning(f"Python SSE {id(event_stream)} stream broke.")
                        return

                    logger.debug(f"Received Python SSE event: {event}")
                    payload = event.data.strip()
                    if not payload:
                        continue

                    try:
                        response = json.loads(payload)
                    except json.JSONDecodeError:
                        logger.warning("Failed to decode Python SSE event.")
                        continue

                    if response.get("action") == "logout":
                        if self.event_stream_stop_event.is_set() or self.shutting_down_stream is event_stream:
                            logger.info(f"Python SSE {id(event_stream)} disconnected.")
                            return
                    elif response.get("status") == "connected":
                        if not self.connected:
                            logger.info(f"Python SSE {id(event_stream)} connected.")
                            self.initializing = False
                            self.connected = True
                    else:
                        self.event_loop.call_soon_threadsafe(self._queue_response, response)

            except Exception:
                logger.exception("Unhandled exception in Python SSE thread.")
                self.event_loop.call_soon_threadsafe(self.event_loop.create_task, self.restart())

        try:
            self.event_stream = sseclient.SSEClient(
                'https://myapi.arlo.com/hmsweb/client/subscribe?token=' +
                self.arlo.request.session.headers.get('Authorization'),
                session=self.arlo.request.session
            )

            self.event_stream_thread = threading.Thread(
                name="PySSEStream",
                target=thread_main,
                args=(self,)
            )
            self.event_stream_thread.daemon = True
            self.event_stream_thread.start()

            while not self.connected and not self.event_stream_stop_event.is_set():
                await asyncio.sleep(0.5)

        except Exception as e:
            logger.error(f"Failed to initialize Python SSE client: {e}")

    async def restart(self):
        logger.debug("Restarting Python SSE stream...")
        self.reconnecting = True
        self.connected = False

        if self.event_stream:
            self.shutting_down_stream = self.event_stream
            self.event_stream = None

        await self.start()
        await asyncio.sleep(1)

        self.shutting_down_stream = None
        self.reconnecting = False

    def subscribe(self, topics):
        logger.debug("subscribe() called, but Python SSE does not support topic subscriptions.")
        pass