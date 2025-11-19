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

    def _add_and_subscribe(self, client: mqtt.Client, topics: list[str]) -> None:
        if not topics:
            return
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
            try:
                client.subscribe(unique_new_subs)
                self.logger.debug(
                    f'Subscribed to MQTT Event Stream topics: {json.dumps([t[0] for t in unique_new_subs], indent=2)}'
                )
            except Exception as e:
                self.logger.error(f'MQTT Event Stream subscription error: {e}')

    async def start(self, retry_limit: int = 4) -> None:
        if self.event_stream is not None:
            self.logger.debug('MQTT Event Stream already initialized. Skipping start.')
            return

        def on_connect(client: mqtt.Client, userdata: Any, flags: dict[str, Any], rc: int) -> None:
            if rc == 0:
                self.connected = True
                self.initializing = False
                self.logger.debug(f'MQTT Event Stream {id(client)} connected.')
                session_topics = [
                    f'u/{self.arlo.user_id}/in/userSession/connect',
                    f'u/{self.arlo.user_id}/in/userSession/disconnect',
                ]
                if self.arlo.mvss_enabled:
                    session_topics.append(f'u/{self.arlo.user_id}/in/automation/activeMode/#')
                self._add_and_subscribe(client, session_topics)
                if not self.reconnecting:
                    self.cached_topics.clear()
            else:
                self.logger.error(f'MQTT Event Stream {id(client)} failed to connect with return code {rc}.')

        def on_disconnect(client: mqtt.Client, userdata: Any, rc: int) -> None:
            self.logger.warning(f'MQTT Event Stream {id(client)} disconnected with return code {rc}.')
            if rc != 0:
                self.logger.error(f'MQTT Event Stream {id(client)} unexpected disconnection. Attempting to reconnect...')
                self.event_loop.call_soon_threadsafe(self._safe_reconnect)

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
            done: asyncio.Event = asyncio.Event()

            def on_connect_timeout(client: mqtt.Client, userdata: Any, flags: dict[str, Any], rc: int) -> None:
                if rc == 0:
                    on_connect(client, userdata, flags, rc)
                    done.set()
                else:
                    self.logger.error(f'MQTT Event Stream connect failed with return code {rc}.')
                    done.set()

            client.on_connect = on_connect_timeout
            client.connect_async(host, port)
            client.loop_start()
            try:
                await asyncio.wait_for(done.wait(), timeout=timeout)
                return client.is_connected()
            except asyncio.TimeoutError:
                self.logger.error(f'MQTT Event Stream connect to {host}:{port} timed out after {timeout} seconds')
                client.loop_stop()
                return False

        async def try_connect() -> bool:
            retries: int = 0
            base_delay: int = 2

            while retries < retry_limit and not self.event_stream_stop_event.is_set():
                try:
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
            self.logger.error(f'MQTTStream start failed: could not establish connection after {retry_limit - 1} retries.')
            self.event_stream = None
            return
        wait_timeout = 10
        waited = 0
        poll_interval = 0.05
        while not self.connected and not self.event_stream_stop_event.is_set() and waited < wait_timeout:
            await asyncio.sleep(poll_interval)
            waited += poll_interval
        if not self.connected:
            self.logger.error('MQTT Event Stream failed to connect within timeout.')
            self.event_stream = None
            return
        if not self.event_stream_stop_event.is_set():
            self.resubscribe()

    async def restart(self) -> None:
        self.reconnecting = True
        self.connected = False
        self.logger.debug('Restarting MQTT Event Stream...')
        if self.event_stream:
            try:
                self.event_stream.disconnect()
            except Exception as e:
                self.logger.warning(f'Error during MQTT Event Stream disconnect: {e}')
            try:
                self.event_stream.loop_stop()
            except Exception:
                pass
        self.event_stream = None
        await self.start()
        await asyncio.sleep(1)
        self.reconnecting = False

    def subscribe(self, topics: list[str]) -> None:
        if self.event_stream and self.connected:
            self._add_and_subscribe(self.event_stream, topics)
        else:
            self.logger.debug('MQTT Event Stream not connected. Topics will be cached for later.')

    def resubscribe(self) -> None:
        if self.connected and self.event_stream and self.cached_topics:
            self.logger.debug('Resubscribing to cached MQTT topics.')
            try:
                self.event_stream.subscribe(self.cached_topics)
            except Exception as e:
                self.logger.error(f'Resubscribe to cached MQTT topics failed: {e}')

    def disconnect(self) -> None:
        self.logger.debug('Disconnecting MQTT Event Stream...')
        super().disconnect()
        if self.event_stream:
            try:
                self.event_stream.disconnect()
                self.event_stream.loop_stop()
            except Exception as e:
                self.logger.warning(f'Error during MQTT Event Stream disconnect: {e}')
            self.event_stream = None

    def _safe_reconnect(self) -> None:
        if not self.reconnecting:
            asyncio.ensure_future(self.restart())