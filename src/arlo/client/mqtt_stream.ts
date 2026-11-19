import mqtt, { MqttClient } from 'mqtt';

import { sleep, TransientRequestError } from '../util';
import { EventDispatcher, Stream, StreamHost } from './stream';

const FALLBACK_HOST = 'mqtt-cluster-z1-1.arloxcld.com';
const CONNECT_TIMEOUT = 10_000;
const MAX_ATTEMPTS = 4;

// What the MQTT stream needs from the client.
export interface MQTTClientInfo {
    readonly userId: string;
    readonly authorization: string;
    readonly mqttUrl: string;
    readonly mqttPort: number;
    readonly mqttTransport: 'tcp' | 'websockets';
    readonly mvssEnabled: boolean;
}

export interface MQTTStreamHost extends StreamHost {
    requestAuthRecovery(reason: string): void;
}

// Arlo's event stream over MQTT: TLS on port 443, or a WebSocket when the
// session names another port. A dropped connection restarts the whole event
// stream, which reconnects with the current session.
export class MQTTEventStream extends Stream {
    private client?: MqttClient;
    private readonly topics = new Set<string>();

    constructor(host: MQTTStreamHost, dispatcher: EventDispatcher, private readonly info: MQTTClientInfo) {
        super(host, dispatcher, 'MQTT Event Stream');
    }

    private get mqttHost(): MQTTStreamHost {
        return this.host as MQTTStreamHost;
    }

    private clientId(): string {
        return `user_${this.info.userId}_${1_000_000_000 + Math.floor(Math.random() * 9_000_000_000)}`;
    }

    async start(signal?: AbortSignal): Promise<void> {
        if (this.client) {
            this.logger.debug(`${this.name} already initialized. Skipping start.`);
            return;
        }
        this.logger.debug(`Starting ${this.name} (host=${this.info.mqttUrl}, transport=${this.info.mqttTransport})`);
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !this.stopped; attempt++) {
            if (await this.connect(this.info.mqttUrl) || (!this.stopped && await this.connect(FALLBACK_HOST)))
                break;
            this.logger.error('Failed to connect to both primary and fallback MQTT hosts.');
            if (attempt < MAX_ATTEMPTS) {
                const delay = 2_000 * 2 ** attempt + Math.random() * 1_000;
                this.logger.debug(`Retrying MQTT connection in ${(delay / 1000).toFixed(2)} seconds (${attempt}/${MAX_ATTEMPTS - 1})...`);
                await sleep(delay, signal);
            }
        }
        if (!this.connected) {
            // Finished trying, so the client builds a new stream next time
            // instead of waiting on this one.
            this.initializing = false;
            this.logger.error(`${this.name} start failed: could not establish connection after ${MAX_ATTEMPTS - 1} retries.`);
            throw new TransientRequestError(`${this.name} start failed after retries.`);
        }
        this.resubscribe();
    }

    private connect(host: string): Promise<boolean> {
        if (this.stopped)
            return Promise.resolve(false);
        this.logger.debug(`Attempting ${this.name} connect to ${host}:${this.info.mqttPort}...`);
        this.beginConnectWait();
        const websockets = this.info.mqttTransport === 'websockets';
        const url = websockets ? `wss://${host}:${this.info.mqttPort}/mqtt` : `mqtts://${host}:${this.info.mqttPort}`;
        const client = mqtt.connect(url, {
            clientId: this.clientId(),
            username: this.info.userId,
            password: this.info.authorization,
            clean: false,
            protocolVersion: 4,
            reconnectPeriod: 0,
            connectTimeout: CONNECT_TIMEOUT,
            rejectUnauthorized: true,
            wsOptions: {
                headers: {
                    Host: `${this.info.mqttUrl}:${this.info.mqttPort}`,
                    Origin: 'https://my.arlo.com',
                },
            },
        });
        this.client = client;
        return new Promise(resolve => {
            let settled = false;
            let timer: NodeJS.Timeout | undefined;
            const finish = (connected: boolean) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (!connected) {
                    client.end(true);
                    if (this.client === client)
                        this.client = undefined;
                }
                resolve(connected);
            };
            client.on('connect', () => {
                this.markConnected(`${this.name} connected to ${host}.`);
                const sessionTopics = [
                    `u/${this.info.userId}/in/userSession/connect`,
                    `u/${this.info.userId}/in/userSession/disconnect`,
                ];
                if (this.info.mvssEnabled)
                    sessionTopics.push(`u/${this.info.userId}/in/automation/activeMode/#`);
                this.subscribe(sessionTopics);
                finish(true);
            });
            client.on('message', (_topic, payload) => this.onMessage(payload));
            client.on('error', error => {
                const code = (error as { code?: number }).code;
                this.logger.error(`${this.name} error: ${error.message}`);
                if (code === 5)
                    this.onTransportError(`${this.name} failed to connect`, code);
                this.failConnectWait(error);
                finish(false);
            });
            client.on('close', () => {
                if (!settled) {
                    finish(false);
                    return;
                }
                if (this.client !== client || this.stopped)
                    return;
                this.connected = false;
                this.logger.warn(`${this.name} disconnected.`);
                this.onTransportError(`${this.name} unexpected disconnection`);
            });
            timer = setTimeout(() => {
                this.logger.error(`${this.name} connect to ${host}:${this.info.mqttPort} timed out after ${CONNECT_TIMEOUT / 1000} seconds`);
                finish(false);
            }, CONNECT_TIMEOUT + 1_000);
        });
    }

    private onMessage(payload: Buffer): void {
        let event: any;
        try {
            event = JSON.parse(payload.toString().trim());
        }
        catch (e) {
            this.logger.error(`Failed to parse MQTT message: ${e}`);
            return;
        }
        if (!event?.resource)
            return;
        this.logger.debug(`Received MQTT event: ${JSON.stringify(event)}`);
        this.dispatcher.dispatch(event);
    }

    // A refused login (code 5) means the session is no longer valid; anything
    // else restarts the event stream.
    private onTransportError(context: string, code?: number): void {
        if (code === 5) {
            this.logger.error(`${context}; MQTT reports authorization failure. Requesting relogin.`);
            this.mqttHost.requestAuthRecovery(`${context}; MQTT return code ${code}`);
            return;
        }
        if (this.stopped)
            return;
        this.logger.error(`${context}; scheduling event stream restart.`);
        this.host.requestRestart('event_stream');
    }

    subscribe(topics: string[]): void {
        const added = topics.filter(topic => topic && !this.topics.has(topic));
        added.forEach(topic => this.topics.add(topic));
        if (!added.length)
            return;
        if (!this.client || !this.connected) {
            this.logger.debug(`${this.name} not connected. Cached new topics for later.`);
            return;
        }
        this.client.subscribe(added, { qos: 0 }, error => {
            if (error)
                this.logger.error(`${this.name} subscription error: ${error.message}`);
            else
                this.logger.debug(`Subscribed to ${this.name} topics: ${JSON.stringify(added, undefined, 2)}`);
        });
    }

    private resubscribe(): void {
        if (!this.client || !this.connected || !this.topics.size)
            return;
        this.logger.debug(`Resubscribing to cached ${this.name} topics.`);
        this.client.subscribe([...this.topics], { qos: 0 }, error => {
            if (error)
                this.logger.error(`Resubscribe to cached ${this.name} topics failed: ${error.message}`);
        });
    }

    protected async closeTransport(): Promise<void> {
        const client = this.client;
        this.client = undefined;
        await client?.endAsync(true);
    }
}
