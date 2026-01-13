import asyncio
import json
import threading

import sseclient as sse

from typing import Any

from .stream import Stream


class SSEEventStream(Stream):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.event_stream: sse.SSEClient | None = None
        self.event_stream_thread: threading.Thread | None = None
        self.shutting_down_stream: sse.SSEClient | None = None

    def _close_event_stream_transport(self, event_stream: sse.SSEClient | None) -> None:
        if event_stream is None:
            return
        try:
            event_stream.resp.close()
        except Exception:
            pass

    async def start(self) -> None:
        stream_name = self._stream_name()
        if self.event_stream is not None:
            self.logger.debug(f'{stream_name} already initialized. Skipping start.')
            return
        self.logger.debug(f'Starting {stream_name} (host=myapi.arlo.com, transport=SSE)')
        self._begin_connect_wait()

        def thread_main(self: 'SSEEventStream') -> None:
            event_stream: sse.SSEClient | None = self.event_stream
            try:
                for event in event_stream:
                    if event_stream is None:
                        return
                    if self.event_stream is not event_stream and self.shutting_down_stream is not event_stream:
                        self.logger.debug(f'{stream_name} {id(event_stream)} is stale. Exiting thread.')
                        return
                    if self.shutting_down_stream is event_stream:
                        self.logger.debug(f'{stream_name} {id(event_stream)} shutting down. Exiting thread.')
                        return
                    if event is None:
                        self.logger.warning(f'{stream_name} {id(event_stream)} broke.')
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
                            self.logger.debug(f'{stream_name} {id(event_stream)} disconnected.')
                            return
                    elif response.get('status') == 'connected':
                        if not self.connected:
                            self._call_soon_threadsafe(
                                self._mark_connected,
                                f'{stream_name} {id(event_stream)} connected.'
                            )
                    else:
                        self.event_loop.call_soon_threadsafe(self._queue_response, response)
            except Exception:
                self.logger.exception('Unhandled exception in SSE Event Stream thread. Triggering login restart.')
                try:
                    if self.arlo and self.arlo.provider is not None:
                        self.arlo.provider.request_restart(scope='relogin')
                except Exception as e:
                    self.logger.error(f'Error requesting provider restart after SSE failure: {e}')
            finally:
                pass

        try:
            self.logger.debug(f'Attempting {stream_name} connect...')
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
            try:
                await self._await_connected(timeout=30)
            except asyncio.TimeoutError:
                self.logger.error(f'{stream_name} connect timed out after 30 seconds')
                raise
            self.logger.debug(f'{stream_name} start complete.')
        except Exception as e:
            self.logger.error(
                f'Failed to start {stream_name}: {e}. Triggering login restart.'
            )
            try:
                self._disconnect_transport_only()
            except Exception:
                pass
            try:

                self.arlo.provider.request_restart(scope='relogin')
            except Exception as e2:
                self.logger.error(f'Error requesting provider restart after SSE init failure: {e2}')

    def subscribe(self, topics: list[str]) -> None:
        self.logger.debug('SSE Event Stream does not support topic subscriptions.')

    async def _close_transport(self) -> None:
        self._disconnect_transport_only()
        thread = self.event_stream_thread
        if thread and thread.is_alive():
            try:
                await asyncio.to_thread(thread.join, 2)
            except Exception:
                pass
        self.event_stream_thread = None
        self.event_stream = None

    def _disconnect_transport_only(self) -> None:
        event_stream = self.event_stream
        if event_stream is None:
            return
        try:
            self.shutting_down_stream = event_stream
        except Exception:
            pass
        self._close_event_stream_transport(event_stream)