import asyncio
import json
import random
import ssl

import paho.mqtt.client as mqtt

from typing import Any

from .stream import Stream


class MQTTEventStream(Stream):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.cached_topics: list[tuple[str, int]] = []

    def _gen_client_id(self) -> str:
        return f'user_{self.arlo.user_id}_{random.randint(1_000_000_000, 9_999_999_999)}'

    def _cache_topics(self, topics: list[str]) -> list[tuple[str, int]]:
        if not topics:
            return []
        seen: set[str] = set()
        deduped_topics: list[str] = []
        for topic in topics:
            if topic and topic not in seen:
                seen.add(topic)
                deduped_topics.append(topic)
        new_subs: list[tuple[str, int]] = [(topic, 0) for topic in deduped_topics]
        unique_new_subs: list[tuple[str, int]] = [t for t in new_subs if t not in self.cached_topics]
        if unique_new_subs:
            self.cached_topics.extend(unique_new_subs)
        return unique_new_subs

    def _add_and_subscribe(self, client: mqtt.Client, topics: list[str]) -> None:
        stream_name = self._stream_name()
        unique_new_subs = self._cache_topics(topics)
        if unique_new_subs:
            try:
                client.subscribe(unique_new_subs)
                self.logger.debug(
                    f'Subscribed to {stream_name} topics: {json.dumps([t[0] for t in unique_new_subs], indent=2)}'
                )
            except Exception as e:
                self.logger.error(f'{stream_name} subscription error: {e}')

    async def start(self, retry_limit: int = 4) -> None:
        stream_name = self._stream_name()
        if self.event_stream is not None:
            self.logger.debug(f'{stream_name} already initialized. Skipping start.')
            return
        self.logger.debug(
            f'Starting {stream_name} (host={self.arlo.mqtt_url}, transport={self.arlo.mqtt_transport})'
        )

        def on_connect(client: mqtt.Client, userdata: Any, flags: dict[str, Any], rc: int) -> None:
            if rc != 0:
                self.logger.error(f'{stream_name} {id(client)} failed to connect with return code {rc}.')
                self._call_soon_threadsafe(
                    self._fail_connect_wait,
                    RuntimeError(f'{stream_name} {id(client)} failed to connect with return code {rc}.')
                )
                return

            def handle_connected() -> None:
                self._mark_connected(f'{stream_name} {id(client)} connected.')
                session_topics = [
                    f'u/{self.arlo.user_id}/in/userSession/connect',
                    f'u/{self.arlo.user_id}/in/userSession/disconnect',
                ]
                if self.arlo.mvss_enabled:
                    session_topics.append(f'u/{self.arlo.user_id}/in/automation/activeMode/#')
                self._add_and_subscribe(client, session_topics)

            self._call_soon_threadsafe(handle_connected)

        def on_disconnect(client: mqtt.Client, userdata: Any, rc: int) -> None:
            self.logger.warning(f'{stream_name} {id(client)} disconnected with return code {rc}.')
            if rc != 0:
                self.logger.error(
                    f'{stream_name} {id(client)} unexpected disconnection. Triggering login restart.'
                )
                try:
                    self.arlo.provider.request_restart(scope='relogin')
                except Exception as e:
                    self.logger.error(f'Error requesting provider restart after MQTT disconnect: {e}')

        def on_message(client: mqtt.Client, userdata: Any, msg: mqtt.MQTTMessage) -> None:
            try:
                payload: str = msg.payload.decode().strip()
                self.logger.debug(f'Received MQTT event: {payload}')
                response: dict[str, Any] = json.loads(payload)
                if response.get('resource'):
                    self.event_loop.call_soon_threadsafe(self._queue_response, response)
            except (ValueError, json.JSONDecodeError) as e:
                self.logger.error(f'Failed to parse MQTT message: {e}')
            except Exception as e:
                self.logger.error(f'Unexpected MQTT message handling error: {e}')

        async def connect_with_timeout(client: mqtt.Client, host: str, port: int, timeout: int = 10) -> bool:
            self._begin_connect_wait()
            client.on_connect = on_connect
            client.connect_async(host, port)
            client.loop_start()
            try:
                await self._await_connected(timeout=timeout)
                return client.is_connected()
            except asyncio.TimeoutError:
                self.logger.error(f'{stream_name} connect to {host}:{port} timed out after {timeout} seconds')
                return False
            except Exception as e:
                self.logger.error(f'{stream_name} connect error: {e}')
                return False
            finally:
                if not self.connected:
                    try:
                        client.disconnect()
                    except Exception:
                        pass
                    try:
                        client.loop_stop(force=True)
                    except Exception:
                        pass

        async def try_connect() -> bool:
            retries: int = 0
            base_delay: int = 2

            while retries < retry_limit and not self.event_stream_stop_event.is_set():
                try:
                    self.logger.debug(f'Attempting {stream_name} connect to {self.arlo.mqtt_url}:{self.arlo.mqtt_port}...')
                    self.event_stream = mqtt.Client(
                        client_id=self._gen_client_id(),
                        transport=self.arlo.mqtt_transport,
                        clean_session=False
                    )
                    self.event_stream.username_pw_set(
                        self.arlo.user_id,
                        password=self.arlo.request.session.headers.get('Authorization')
                    )
                    self.event_stream.ws_set_options(
                        path='/mqtt',
                        headers={
                            'Host': f'{self.arlo.mqtt_url}:{self.arlo.mqtt_port}',
                            'Origin': f'https://{self.arlo.arlo_url}',
                        }
                    )
                    ssl_context = ssl.create_default_context()
                    ssl_context.check_hostname = True
                    ssl_context.verify_mode = ssl.CERT_REQUIRED
                    self.event_stream.tls_set_context(ssl_context)
                    self.event_stream.on_disconnect = on_disconnect
                    self.event_stream.on_message = on_message
                    if await connect_with_timeout(self.event_stream, self.arlo.mqtt_url, self.arlo.mqtt_port):
                        return True
                    self.logger.warning(f'Failed to connect to {self.arlo.mqtt_url}. Trying fallback...')
                    if await connect_with_timeout(self.event_stream, 'mqtt-cluster-z1-1.arloxcld.com', self.arlo.mqtt_port):
                        return True
                    self.logger.error('Failed to connect to both primary and fallback MQTT hosts.')
                except Exception as e:
                    self.logger.error(f'Error initializing MQTT client: {e}')
                retries += 1
                if retries < retry_limit:
                    delay = base_delay * (2 ** retries)
                    jitter = random.uniform(0, 1)
                    total_delay = delay + jitter
                    self.logger.debug(f'Retrying MQTT connection in {total_delay:.2f} seconds ({retries}/{retry_limit - 1})...')
                    await asyncio.sleep(total_delay)
            return False

        if not await try_connect():
            self.logger.error(
                f'{stream_name} start failed: could not establish connection after {retry_limit - 1} retries. '
                f'Triggering login restart.'
            )
            self.event_stream = None
            try:
                if self.arlo and self.arlo.provider is not None:
                    self.arlo.provider.request_restart(scope='relogin')
            except Exception as e:
                self.logger.error(f'Error requesting provider restart after MQTT start failure: {e}')
            return
        if not self.event_stream_stop_event.is_set():
            self.logger.debug(f'{stream_name} start complete; resubscribing cached topics if any.')
            self.resubscribe()

    def subscribe(self, topics: list[str]) -> None:
        stream_name = self._stream_name()
        if self.event_stream and self.connected:
            self._add_and_subscribe(self.event_stream, topics)
            return
        cached = self._cache_topics(topics)
        if cached:
            self.logger.debug(f'{stream_name} not connected. Cached new topics for later.')
        else:
            self.logger.debug(f'{stream_name} not connected. No new topics to cache.')

    def resubscribe(self) -> None:
        stream_name = self._stream_name()
        if self.connected and self.event_stream and self.cached_topics:
            self.logger.debug(f'Resubscribing to cached {stream_name} topics.')
            try:
                self.event_stream.subscribe(self.cached_topics)
            except Exception as e:
                self.logger.error(f'Resubscribe to cached {stream_name} topics failed: {e}')

    def _disconnect_transport_only(self) -> None:
        if self.event_stream:
            try:
                self.event_stream.disconnect()
            except Exception:
                pass
            try:
                self.event_stream.loop_stop(force=True)
            except Exception:
                pass

    async def _close_transport(self) -> None:
        client = self.event_stream
        if not client:
            return
        try:
            client.disconnect()
        except Exception:
            pass
        try:
            client.loop_stop(force=True)
        except Exception:
            pass
        self.event_stream = None