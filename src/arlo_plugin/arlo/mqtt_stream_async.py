import asyncio
import json
import random
import ssl
import paho.mqtt.client as mqtt

from .stream_async import Stream
from .logging import logger


class MQTTStream(Stream):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cached_topics = []

    def _gen_client_id(self):
        return f"user_{self.arlo.user_id}_{random.randint(1_000_000_000, 9_999_999_999)}"

    def _add_and_subscribe(self, client, topics):
        if not topics:
            return
        seen = set()
        deduped_topics = []
        for topic in topics:
            if topic and topic not in seen:
                seen.add(topic)
                deduped_topics.append(topic)
        new_subs = [(topic, 0) for topic in deduped_topics]
        unique_new_subs = [t for t in new_subs if t not in self.cached_topics]
        if unique_new_subs:
            self.cached_topics.extend(unique_new_subs)
            try:
                client.subscribe(unique_new_subs)
                logger.debug(f"Subscribed to MQTT topics: {json.dumps([t[0] for t in unique_new_subs], indent=2)}")
            except Exception as e:
                logger.error(f"MQTT subscription error: {e}")

    async def start(self):
        if self.event_stream is not None:
            logger.debug("MQTT event stream already initialized. Skipping start.")
            return

        def on_connect(client, userdata, flags, rc):
            if rc == 0:
                self.connected = True
                self.initializing = False
                logger.info(f"MQTT {id(client)} connected successfully")
                session_topics = [
                    f"u/{self.arlo.user_id}/in/userSession/connect",
                    f"u/{self.arlo.user_id}/in/userSession/disconnect",
                ]
                self._add_and_subscribe(client, session_topics)
            else:
                logger.error(f"MQTT {id(client)} failed to connect with return code {rc}")

        def on_disconnect(client, userdata, rc):
            logger.warning(f"MQTT {id(client)} disconnected with return code {rc}")
            if rc != 0:
                logger.error("Unexpected disconnection. Attempting to reconnect...")
                self.event_loop.call_soon_threadsafe(self._safe_reconnect)

        def on_message(client, userdata, msg):
            try:
                payload = msg.payload.decode().strip()
                logger.debug(f"Received MQTT event: {payload}")
                response = json.loads(payload)
                if response.get("resource"):
                    self.event_loop.call_soon_threadsafe(self._queue_response, response)
            except (ValueError, json.JSONDecodeError) as e:
                logger.error(f"Failed to parse MQTT message: {e}")
            except Exception as e:
                logger.error(f"Unexpected MQTT message handling error: {e}")

        logger.debug(f"MQTT Setup for user: {self.arlo.user_id}")
        logger.debug(f"MQTT Host: {self.arlo.mqtt_url}:{self.arlo.mqtt_port}")

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
                path="/mqtt",
                headers={
                    "Host": f"{self.arlo.mqtt_url}:{self.arlo.mqtt_port}",
                    "Origin": "https://my.arlo.com"
                }
            )

            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_REQUIRED
            self.event_stream.tls_set_context(ssl_context)
            self.event_stream.on_connect = on_connect
            self.event_stream.on_disconnect = on_disconnect
            self.event_stream.on_message = on_message

            self.event_stream.connect_async(self.arlo.mqtt_url, port=self.arlo.mqtt_port)
            self.event_stream.loop_start()
        except Exception as e:
            logger.error(f"Error initializing MQTT client: {e}")
            return

        while not self.connected and not self.event_stream_stop_event.is_set():
            await asyncio.sleep(0.5)

        if not self.event_stream_stop_event.is_set():
            self.resubscribe()

    async def restart(self):
        self.reconnecting = True
        self.connected = False
        logger.debug("Restarting MQTT stream...")

        if self.event_stream:
            try:
                self.event_stream.disconnect()
            except Exception as e:
                logger.warning(f"Error during MQTT disconnect: {e}")
            try:
                self.event_stream.loop_stop()
            except Exception:
                pass

        self.event_stream = None
        await self.start()
        await asyncio.sleep(1)
        self.reconnecting = False

    def subscribe(self, topics):
        if self.event_stream and self.connected:
            self._add_and_subscribe(self.event_stream, topics)
        else:
            logger.debug("Stream not connected. Topics will be cached for later.")

    def resubscribe(self):
        if self.connected and self.event_stream and self.cached_topics:
            logger.debug("Resubscribing to cached MQTT topics.")
            try:
                self.event_stream.subscribe(self.cached_topics)
            except Exception as e:
                logger.error(f"Resubscription failed: {e}")

    def disconnect(self):
        logger.debug("Disconnecting MQTT stream...")
        super().disconnect()
        if self.event_stream:
            try:
                self.event_stream.disconnect()
                self.event_stream.loop_stop()
            except Exception as e:
                logger.warning(f"Error during MQTT disconnect: {e}")
            self.event_stream = None

    def _safe_reconnect(self):
        if not self.reconnecting:
            asyncio.ensure_future(self.restart())