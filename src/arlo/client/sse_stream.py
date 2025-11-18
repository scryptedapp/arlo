import asyncio
import json
import threading

import sseclient as sse

from typing import Any

import scrypted_sdk

from .stream import Stream

class SSEEventStream(Stream):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.event_stream: sse.SSEClient | None = None
        self.event_stream_thread: threading.Thread | None = None
        self.shutting_down_stream: sse.SSEClient | None = None

    async def start(self) -> None:
        if self.event_stream is not None:
            self.logger.debug('SSE Event Stream already initialized. Skipping start.')
            return
        self.logger.debug('Initializing SSE Event Stream...')

        def thread_main(self: 'SSEEventStream') -> None:
            event_stream: sse.SSEClient | None = self.event_stream
            try:
                for event in event_stream:
                    if event is None:
                        self.logger.warning(f'SSE Event Stream {id(event_stream)} broke.')
                        return
                    self.logger.debug(f'Received SSE event: {event}')
                    payload: str = event.data.strip()
                    if not payload:
                        continue
                    try:
                        response: dict[str, Any] = json.loads(payload)
                    except json.JSONDecodeError:
                        self.logger.warning('Failed to decode SSE event.')
                        continue
                    if response.get('action') == 'logout':
                        if self.event_stream_stop_event.is_set() or self.shutting_down_stream is event_stream:
                            self.logger.debug(f'SSE Event Stream {id(event_stream)} disconnected.')
                            return
                    elif response.get('status') == 'connected':
                        if not self.connected:
                            self.logger.debug(f'SSE Event Stream {id(event_stream)} connected.')
                            self.initializing = False
                            self.connected = True
                    else:
                        self.event_loop.call_soon_threadsafe(self._queue_response, response)
            except Exception:
                self.logger.exception('Unhandled exception in SSE Event Stream thread.')
                self.event_loop.call_soon_threadsafe(self.event_loop.create_task, self.restart())

        try:
            self.event_stream = sse.SSEClient(
                'https://myapi.arlo.com/hmsweb/client/subscribe?token=' +
                self.arlo.request.session.headers.get('Authorization'),
                session=self.arlo.request.session
            )
            self.event_stream_thread = threading.Thread(
                name='SSEEventStream',
                target=thread_main,
                args=(self,)
            )
            self.event_stream_thread.daemon = True
            self.event_stream_thread.start()
            while not self.connected and not self.event_stream_stop_event.is_set():
                await asyncio.sleep(0.5)
        except Exception as e:
            self.logger.error(f'Failed to initialize SSE Event Stream: {e}')
            try:
                await scrypted_sdk.deviceManager.requestRestart()
                self.logger.error('Requested plugin restart due to persistent SSE connection failure.')
            except Exception as restart_exc:
                self.logger.error(f'Failed to request plugin restart: {restart_exc}')

    async def restart(self) -> None:
        self.logger.debug('Restarting SSE Event stream...')
        self.reconnecting = True
        self.connected = False
        if self.event_stream:
            self.shutting_down_stream = self.event_stream
            self.event_stream = None
        await self.start()
        await asyncio.sleep(1)
        self.shutting_down_stream = None
        self.reconnecting = False

    def subscribe(self, topics: list[str]) -> None:
        self.logger.debug('SSE Event Stream does not support topic subscriptions.')