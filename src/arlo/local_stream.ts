import net from 'node:net';
import tls from 'node:tls';

import type { ArloBasestation } from './basestation';
import type { ArloCamera } from './camera';
import { extraDebug, Logger } from './logging';

const HEADER_NORMALIZATION: Record<string, string> = {
    'cseq': 'CSeq',
    'rtp-info': 'RTP-Info',
};

const RTSP_METHODS = ['RTSP/', 'OPTIONS', 'DESCRIBE', 'SETUP', 'PLAY', 'TEARDOWN', 'GET_PARAMETER', 'SET_PARAMETER', 'ANNOUNCE', 'RECORD', 'PAUSE'];

function normalizeHeader(name: string): string {
    return HEADER_NORMALIZATION[name.toLowerCase()] ?? name;
}

class RTSPMessage {
    firstLine = '';
    readonly headers: [string, string][] = [];
    body: Buffer<ArrayBufferLike> = Buffer.alloc(0);

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
                this.headers.push([normalizeHeader(line.slice(0, colon).trim()), line.slice(colon + 1).trim()]);
        }
    }

    formatted(): string {
        return [this.firstLine, ...this.headers.map(([k, v]) => `${k}: ${v}`), ...(this.body.length ? ['', this.body.toString('latin1')] : [])].join('\n');
    }

    toBuffer(): Buffer {
        const head = [this.firstLine, ...this.headers.map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n';
        return Buffer.concat([Buffer.from(head, 'latin1'), this.body]);
    }

    getHeader(name: string): string | undefined {
        return this.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    }

    setHeader(name: string, value: string): void {
        const index = this.headers.findIndex(([k]) => k.toLowerCase() === name.toLowerCase());
        if (index >= 0)
            this.headers[index] = [normalizeHeader(name), value];
        else
            this.headers.push([normalizeHeader(name), value]);
    }
}

export class ArloLocalStreamProxy {
    private server?: net.Server;
    private port = 0;
    private nonce = 0;
    private readonly logger: Logger;

    constructor(private readonly privateKey: string, private readonly basestation: ArloBasestation, camera: ArloCamera) {
        this.logger = camera.logger;
    }

    async start(): Promise<number> {
        let unused: NodeJS.Timeout | undefined;
        const server = this.server = net.createServer(socket => {
            clearTimeout(unused);
            this.handleConnection(socket);
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        server.on('error', e => this.logger.debug(`Local stream proxy error: ${e}`));
        unused = setTimeout(() => {
            if (this.server !== server)
                return;
            this.logger.debug('Nothing connected to the local stream proxy within 30 seconds; closing it.');
            server.close();
            this.server = undefined;
        }, 30_000);
        this.port = (server.address() as net.AddressInfo).port;
        this.logger.debug(`ArloLocalStreamProxy listening on 127.0.0.1:${this.port}`);
        return this.port;
    }

    private handleConnection(rebroadcast: net.Socket): void {
        this.nonce = 0;
        this.logger.debug(`Connecting to basestation ${this.basestation.ip}:554`);
        const basestation = tls.connect({
            host: this.basestation.ip,
            port: 554,
            cert: this.basestation.peerCert,
            key: this.privateKey,
            rejectUnauthorized: false,
        });
        let closed = false;
        const close = (error?: Error) => {
            if (closed)
                return;
            closed = true;
            if (error && (error as { code?: string }).code !== 'ECONNRESET')
                this.logger.error(`Proxy connection error: ${error.message}`);
            rebroadcast.destroy();
            basestation.destroy();
            this.server?.close();
            this.server = undefined;
        };
        rebroadcast.on('data', data => this.relay(data, rebroadcast, basestation, true));
        basestation.on('data', data => this.relay(data, basestation, rebroadcast, false));
        for (const socket of [rebroadcast, basestation]) {
            socket.on('error', close);
            socket.on('close', () => close());
        }
    }

    private relay(data: Buffer, source: net.Socket, destination: net.Socket, fromRebroadcast: boolean): void {
        const write = (chunk: Buffer) => {
            if (!destination.write(chunk)) {
                source.pause();
                destination.once('drain', () => source.resume());
            }
        };
        const direction = fromRebroadcast ? 'Rebroadcast → Basestation' : 'Basestation → Rebroadcast';
        if (data[0] === 0x24) {
            if (extraDebug())
                this.logger.debug(`Video/Audio Stream Data: ${data.length} bytes (${direction})`);
            write(data);
            return;
        }
        if (!RTSP_METHODS.some(method => data.subarray(0, method.length).toString('latin1') === method)) {
            write(data);
            return;
        }
        try {
            const message = new RTSPMessage(data);
            if (fromRebroadcast)
                this.rewriteOutgoing(message);
            else
                this.rewriteIncoming(message);
            if (extraDebug())
                this.logger.debug(`${fromRebroadcast ? 'Outgoing' : 'Incoming'} RTSP message:\n${message.formatted()}`);
            write(message.toBuffer());
        }
        catch (e) {
            this.logger.error(`RTSP parsing error in ${direction}: ${e}. Forwarding raw.`);
            write(data);
        }
    }

    private rewriteOutgoing(message: RTSPMessage): void {
        if (this.nonce !== 0) {
            this.nonce++;
            message.setHeader('Nonce', String(this.nonce));
        }
        const local = `localhost:${this.port}`;
        if (message.firstLine.includes('rtsp://'))
            message.firstLine = message.firstLine.replace(local, this.basestation.hostName!);
        for (const [key, value] of [...message.headers]) {
            if (value.includes('rtsp://'))
                message.setHeader(key, value.replace(local, this.basestation.hostName!));
        }
    }

    private rewriteIncoming(message: RTSPMessage): void {
        const nonce = message.getHeader('Nonce');
        if (nonce) {
            const parsed = Number.parseInt(nonce, 10);
            if (Number.isNaN(parsed))
                this.logger.error(`Error parsing nonce "${nonce}"`);
            else
                this.nonce = parsed;
        }
        const local = `localhost:${this.port}`;
        if (message.firstLine.includes('rtsp://'))
            message.firstLine = message.firstLine.replace(this.basestation.hostName!, local);
        for (const [key, value] of [...message.headers]) {
            if (value.includes('rtsp://'))
                message.setHeader(key, value.replace(this.basestation.hostName!, local));
        }
    }
}
