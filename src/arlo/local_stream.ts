import net from 'node:net';
import tls from 'node:tls';

import type { ArloBasestation } from './basestation';
import type { ArloCamera } from './camera';
import { extraDebug, Logger } from './logging';
import type { ArloProvider } from './provider';

class RTSPMessage {
    static headerNormalization: Record<string, string> = {
        'cseq': 'CSeq',
        'rtp-info': 'RTP-Info',
    };

    firstLine = '';
    headers: [string, string][] = [];
    body: Buffer = Buffer.alloc(0);

    constructor(raw: Buffer) {
        const split = raw.indexOf('\r\n\r\n');
        const head = (split < 0 ? raw : raw.subarray(0, split)).toString('latin1');
        if (split >= 0)
            this.body = raw.subarray(split + 4);
        const [firstLine, ...lines] = head.split('\r\n');
        this.firstLine = firstLine ?? '';
        for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon >= 0)
                this.headers.push([this.normalizeHeader(line.slice(0, colon).trim()), line.slice(colon + 1).trim()]);
        }
    }

    private normalizeHeader(name: string): string {
        return RTSPMessage.headerNormalization[name.toLowerCase()] ?? name;
    }

    formatted(): string {
        const lines = [this.firstLine];
        for (const [k, v] of this.headers)
            lines.push(`${k}: ${v}`);
        if (this.body.length) {
            lines.push('');
            lines.push(this.body.toString('latin1'));
        }
        return lines.join('\n');
    }

    toBytes(): Buffer {
        const lines = [this.firstLine];
        for (const [k, v] of this.headers)
            lines.push(`${k}: ${v}`);
        return Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1'), this.body]);
    }

    getHeader(name: string): string | undefined {
        return this.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    }

    setHeader(name: string, value: string): void {
        const index = this.headers.findIndex(([k]) => k.toLowerCase() === name.toLowerCase());
        if (index >= 0)
            this.headers[index] = [this.normalizeHeader(name), value];
        else
            this.headers.push([this.normalizeHeader(name), value]);
    }
}

export class ArloLocalStreamProxy {
    logger: Logger;
    listener?: net.Server;
    listenerPort = 0;
    nonce = 0;

    constructor(public provider: ArloProvider, public basestation: ArloBasestation, public camera: ArloCamera) {
        this.logger = camera.logger;
    }

    async start(): Promise<number> {
        let listenTimeout: NodeJS.Timeout | undefined;
        const listener = this.listener = net.createServer(socket => {
            clearTimeout(listenTimeout);
            this.handleConnection(socket);
        });
        await new Promise<void>((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(0, '127.0.0.1', () => resolve());
        });
        listener.on('error', e => this.logger.debug(`Local stream proxy error: ${e}`));
        listenTimeout = setTimeout(() => {
            if (this.listener !== listener)
                return;
            this.logger.debug('Nothing connected to the local stream proxy within 30 seconds; closing it.');
            listener.close();
            this.listener = undefined;
        }, 30_000);
        this.listenerPort = (listener.address() as net.AddressInfo).port;
        this.logger.debug(`ArloLocalStreamProxy listening on 127.0.0.1:${this.listenerPort}`);
        return this.listenerPort;
    }

    private handleConnection(rebroadcastSocket: net.Socket): void {
        this.nonce = 0;
        this.logger.debug(`Connecting to basestation ${this.basestation.ip}:554`);
        const basestationSocket = tls.connect({
            host: this.basestation.ip,
            port: 554,
            cert: this.basestation.peerCert,
            key: this.provider.arloPrivateKey,
            rejectUnauthorized: false,
        });
        let closed = false;
        const cleanupConnections = (error?: Error) => {
            if (closed)
                return;
            closed = true;
            if (error && (error as { code?: string }).code !== 'ECONNRESET')
                this.logger.error(`Proxy connection error: ${error.message}`);
            rebroadcastSocket.destroy();
            basestationSocket.destroy();
            this.listener?.close();
            this.listener = undefined;
        };
        rebroadcastSocket.on('data', data => this.relay(data, rebroadcastSocket, basestationSocket, true));
        basestationSocket.on('data', data => this.relay(data, basestationSocket, rebroadcastSocket, false));
        for (const socket of [rebroadcastSocket, basestationSocket]) {
            socket.on('error', cleanupConnections);
            socket.on('close', () => cleanupConnections());
        }
    }

    private relay(data: Buffer, source: net.Socket, destination: net.Socket, fromRebroadcast: boolean): void {
        const writeAndDrain = (chunk: Buffer) => {
            if (!destination.write(chunk)) {
                source.pause();
                destination.once('drain', () => source.resume());
            }
        };
        const direction = fromRebroadcast ? 'Rebroadcast → Basestation' : 'Basestation → Rebroadcast';
        if (this.isInterleaved(data)) {
            if (extraDebug())
                this.logger.debug(`Video/Audio Stream Data: ${data.length} bytes (${direction})`);
            writeAndDrain(data);
            return;
        }
        if (!this.isRtsp(data)) {
            writeAndDrain(data);
            return;
        }
        try {
            const msg = new RTSPMessage(data);
            if (fromRebroadcast)
                this.handleOutgoingNonceAndUrls(msg);
            else
                this.handleIncomingNonceAndUrls(msg);
            if (extraDebug())
                this.logger.debug(`${fromRebroadcast ? 'Outgoing' : 'Incoming'} RTSP message:\n${msg.formatted()}`);
            writeAndDrain(msg.toBytes());
        }
        catch (e) {
            this.logger.error(`RTSP parsing error in ${direction}: ${e}. Forwarding raw.`);
            writeAndDrain(data);
        }
    }

    private handleOutgoingNonceAndUrls(msg: RTSPMessage): void {
        if (this.nonce !== 0) {
            this.nonce++;
            msg.setHeader('Nonce', String(this.nonce));
        }
        const local = `localhost:${this.listenerPort}`;
        if (msg.firstLine.includes('rtsp://'))
            msg.firstLine = msg.firstLine.replace(local, this.basestation.hostName);
        for (const [key, value] of [...msg.headers]) {
            if (value.includes('rtsp://'))
                msg.setHeader(key, value.replace(local, this.basestation.hostName));
        }
    }

    private handleIncomingNonceAndUrls(msg: RTSPMessage): void {
        const newNonce = msg.getHeader('Nonce');
        if (newNonce) {
            const parsed = Number.parseInt(newNonce, 10);
            if (Number.isNaN(parsed))
                this.logger.error(`Error parsing nonce "${newNonce}"`);
            else
                this.nonce = parsed;
        }
        const local = `localhost:${this.listenerPort}`;
        if (msg.firstLine.includes('rtsp://'))
            msg.firstLine = msg.firstLine.replace(this.basestation.hostName, local);
        for (const [key, value] of [...msg.headers]) {
            if (value.includes('rtsp://'))
                msg.setHeader(key, value.replace(this.basestation.hostName, local));
        }
    }

    private isRtsp(data: Buffer): boolean {
        const methods = ['RTSP/', 'OPTIONS', 'DESCRIBE', 'SETUP', 'PLAY', 'TEARDOWN', 'GET_PARAMETER', 'SET_PARAMETER', 'ANNOUNCE', 'RECORD', 'PAUSE'];
        return methods.some(method => data.subarray(0, method.length).toString('latin1') === method);
    }

    private isInterleaved(data: Buffer): boolean {
        return data[0] === 0x24;
    }
}
