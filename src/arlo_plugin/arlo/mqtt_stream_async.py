import asyncio
import json
import random
import paho.mqtt.client as mqtt

from .stream_async import Stream
from .logging import logger

class MQTTStream(Stream):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cached_topics = []

    def _gen_client_number(self):
        return random.randint(1000000000, 9999999999)

    async def start(self):
        if self.event_stream is not None:
            logger.debug("MQTT event stream already initialized. Skipping start.")
            return

        def on_connect(client, userdata, flags, rc):
            if rc == 0:
                self.connected = True
                self.initializing = False
                logger.info(f"MQTT {id(client)} connected successfully")
                client.subscribe([
                    (f"u/{self.arlo.user_id}/in/userSession/connect", 0),
                    (f"u/{self.arlo.user_id}/in/userSession/disconnect", 0),
                ])
            else:
                logger.error(f"MQTT {id(client)} failed to connect with return code {rc}")

        def on_disconnect(client, userdata, rc):
            logger.warning(f"MQTT {id(client)} disconnected with return code {rc}")
            if rc != 0:
                logger.error("Unexpected disconnection. Attempting to reconnect...")
                self.event_stream.reconnect()

        def on_message(client, userdata, msg):
            payload = msg.payload.decode()
            logger.debug(f"Received event: {payload}")

            try:
                response = json.loads(payload.strip())
            except json.JSONDecodeError:
                logger.error("Failed to decode MQTT message payload")
                return

            if response.get('resource') is not None:
                self.event_loop.call_soon_threadsafe(self._queue_response, response)

        # Debugging: Log MQTT connection details
        logger.debug(f"MQTT Username: {self.arlo.user_id}")
        logger.debug(f"MQTT WebSocket Host: {self.arlo.mqtt_url}:{self.arlo.mqtt_port}")
        logger.debug(f"MQTT WebSocket Origin: https://my.arlo.com")

        try:
            self.event_stream = mqtt.Client(
                client_id=f"user_{self.arlo.user_id}_{self._gen_client_number()}",
                transport=self.arlo.mqtt_transport,
                clean_session=False
            )
            logger.debug("MQTT client created successfully.")

            self.event_stream.username_pw_set(
                self.arlo.user_id,
                password=self.arlo.request.session.headers.get('Authorization')
            )
            logger.debug("MQTT username and password set.")

            self.event_stream.ws_set_options(
                path="/mqtt",
                headers={"Host": f"{self.arlo.mqtt_url}:{self.arlo.mqtt_port}", "Origin": "https://my.arlo.com"}
            )
            logger.debug("MQTT WebSocket options set.")

            self.event_stream.tls_set()
            logger.debug("MQTT TLS configuration set.")

            self.event_stream.on_connect = on_connect
            self.event_stream.on_disconnect = on_disconnect
            self.event_stream.on_message = on_message

            logger.debug("Attempting to connect to MQTT broker...")
            self.event_stream.connect_async(self.arlo.mqtt_url, port=self.arlo.mqtt_port)
            self.event_stream.loop_start()
            logger.debug("MQTT loop started.")
        except Exception as e:
            logger.error(f"Error initializing MQTT client: {e}")
            return

        while not self.connected and not self.event_stream_stop_event.is_set():
            logger.debug("Waiting for MQTT connection...")
            await asyncio.sleep(0.5)

        if not self.event_stream_stop_event.is_set() and self.cached_topics:
            logger.debug("MQTT connection established. Resubscribing to topics.")
            self.resubscribe()

    async def restart(self):
        self.reconnecting = True
        self.connected = False
        logger.debug("Restarting MQTT stream...")
        self.event_stream.disconnect()
        self.event_stream = None
        await self.start()
        # give it an extra sleep to ensure any previous connections have disconnected properly
        # this is so we can mark reconnecting to False properly
        await asyncio.sleep(1)
        self.reconnecting = False

    def subscribe(self, topics):
        logger.debug(f"Subscribing to topics:\n{json.dumps(topics, indent=2)}")
        if topics:
            new_subscriptions = [(topic, 0) for topic in topics]
            self.event_stream.subscribe(new_subscriptions)
            self.cached_topics.extend(new_subscriptions)

    def resubscribe(self):
        if self.cached_topics:
            logger.debug("Resubscribing to cached topics.")
            self.event_stream.subscribe(self.cached_topics)

    def disconnect(self):
        logger.debug("Disconnecting MQTT stream...")
        super().disconnect()
        self.event_stream.disconnect()