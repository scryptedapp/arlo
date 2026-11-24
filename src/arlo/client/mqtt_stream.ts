import mqtt, { MqttClient } from 'mqtt';

import { sleep, TransientRequestError } from '../util';
import type { ArloClient } from './client';
import { Stream } from './stream';

export class MQTTEventStream extends Stream {
    private client?: MqttClient;
    private cachedTopics = new Set<string>();

    constructor(arlo: ArloClient) {
        super(arlo, 'MQTT Event Stream');
    }

    private genClientId(): string {
        return `user_${this.arlo.userId}_${1_000_000_000 + Math.floor(Math.random() * 9_000_000_000)}`;
    }

    async start(signal?: AbortSignal, retryLimit = 4): Promise<void> {
        if (this.client) {
            this.logger.debug(`${this.name} already initialized. Skipping start.`);
            return;
        }
        this.logger.debug(`Starting ${this.name} (host=${this.arlo.mqttUrl}, transport=${this.arlo.mqttTransport})`);
        for (let attempt = 1; attempt <= retryLimit && !this.stopped; attempt++) {
            if (await this.connectWithTimeout(this.arlo.mqttUrl) || (!this.stopped && await this.connectWithTimeout('mqtt-cluster-z1-1.arloxcld.com')))
                break;
            this.logger.error('Failed to connect to both primary and fallback MQTT hosts.');
            if (attempt < retryLimit) {
                const delay = 2_000 * 2 ** attempt + Math.random() * 1_000;
                this.logger.debug(`Retrying MQTT connection in ${(delay / 1000).toFixed(2)} seconds (${attempt}/${retryLimit - 1})...`);
                await sleep(delay, signal);
            }
        }
        if (!this.connected) {
            this.initializing = false;
            this.logger.error(`${this.name} start failed: could not establish connection after ${retryLimit - 1} retries.`);
            throw new TransientRequestError(`${this.name} start failed after retries.`);
        }
        this.resubscribe();
    }

    private connectWithTimeout(host: string, timeout = 10_000): Promise<boolean> {
        if (this.stopped)
            return Promise.resolve(false);
        this.logger.debug(`Attempting ${this.name} connect to ${host}:${this.arlo.mqttPort}...`);
        this.beginConnectWait();
        const websockets = this.arlo.mqttTransport === 'websockets';
        const url = websockets ? `wss://${host}:${this.arlo.mqttPort}/mqtt` : `mqtts://${host}:${this.arlo.mqttPort}`;
        const client = mqtt.connect(url, {
            clientId: this.genClientId(),
            username: this.arlo.userId,
            password: this.arlo.headers.Authorization,
            clean: false,
            protocolVersion: 4,
            reconnectPeriod: 0,
            connectTimeout: timeout,
            rejectUnauthorized: true,
            wsOptions: {
                headers: {
                    Host: `${this.arlo.mqttUrl}:${this.arlo.mqttPort}`,
                    Origin: `https://${this.arlo.arloUrl}`,
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
                    `u/${this.arlo.userId}/in/userSession/connect`,
                    `u/${this.arlo.userId}/in/userSession/disconnect`,
                ];
                if (this.provider.mvssEnabled)
                    sessionTopics.push(`u/${this.arlo.userId}/in/automation/activeMode/#`);
                this.subscribe(sessionTopics);
                finish(true);
            });
            client.on('message', (_topic, payload) => this.onMessage(payload));
            client.on('error', error => {
                const code = (error as { code?: number }).code;
                this.logger.error(`${this.name} error: ${error.message}`);
                if (code === 5)
                    this.handleTransportError(`${this.name} failed to connect`, code);
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
                this.handleTransportError(`${this.name} unexpected disconnection`);
            });
            timer = setTimeout(() => {
                this.logger.error(`${this.name} connect to ${host}:${this.arlo.mqttPort} timed out after ${timeout / 1000} seconds`);
                finish(false);
            }, timeout + 1_000);
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
        this.arlo.events.dispatch(event);
    }

    private handleTransportError(context: string, code?: number): void {
        if (code === 5) {
            this.logger.error(`${context}; MQTT reports authorization failure. Requesting relogin.`);
            this.errorManager.requestAuthRecovery(`${context}; MQTT return code ${code}`);
            return;
        }
        if (this.stopped)
            return;
        this.logger.error(`${context}; scheduling event stream restart.`);
        this.provider.requestRestart('event_stream');
    }

    subscribe(topics: string[]): void {
        const added = topics.filter(topic => topic && !this.cachedTopics.has(topic));
        added.forEach(topic => this.cachedTopics.add(topic));
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
        if (!this.client || !this.connected || !this.cachedTopics.size)
            return;
        this.logger.debug(`Resubscribing to cached ${this.name} topics.`);
        this.client.subscribe([...this.cachedTopics], { qos: 0 }, error => {
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
