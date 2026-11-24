import crypto from 'node:crypto';
import WebSocket from 'ws';

import type { Logger } from '../logging';
import { AsyncLock, Deferred, TaskManager, withTimeout } from '../util';

function randString(n: number, chars = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
    let result = '';
    for (let i = 0; i < n; i++)
        result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function genBranch(): string {
    return 'z9hG4bK' + randString(7, '0123456789');
}

// The entries of a comma-separated header, ignoring commas inside <> or quotes.
function splitHeaderList(value: string): string[] {
    const entries: string[] = [];
    let start = 0;
    let inAngle = false;
    let inQuote = false;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (c === '"')
            inQuote = !inQuote;
        else if (!inQuote && c === '<')
            inAngle = true;
        else if (!inQuote && c === '>')
            inAngle = false;
        else if (c === ',' && !inAngle && !inQuote) {
            entries.push(value.slice(start, i).trim());
            start = i + 1;
        }
    }
    entries.push(value.slice(start).trim());
    return entries.filter(Boolean);
}

function md5(...parts: string[]): string {
    return crypto.createHash('md5').update(parts.join(':')).digest('hex');
}

export class SIPMessage {
    method?: string;
    statusCode?: number;
    reason?: string;
    uri?: string;
    // Header names are kept lower case, as the Python plugin sent them.
    readonly headers = new Map<string, string[]>();
    body = '';

    static parse(raw: string): SIPMessage {
        const message = new SIPMessage();
        const lines = raw.split('\r\n');
        const status = /^SIP\/2\.0 (\d+) (.+)$/.exec(lines[0]);
        const request = /^(\w+) (.+) SIP\/2\.0$/.exec(lines[0]);
        if (status) {
            message.statusCode = Number(status[1]);
            message.reason = status[2];
        }
        else if (request) {
            message.method = request[1];
            message.uri = request[2];
        }
        let index = 1;
        for (; index < lines.length; index++) {
            const line = lines[index];
            if (line === '') {
                index++;
                break;
            }
            const colon = line.indexOf(':');
            if (colon > 0)
                message.addHeader(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        message.body = lines.slice(index).join('\r\n');
        return message;
    }

    getHeader(name: string): string | undefined {
        return this.headers.get(name.toLowerCase())?.[0];
    }

    getHeaders(name: string): string[] {
        return this.headers.get(name.toLowerCase()) ?? [];
    }

    setHeader(name: string, value: string): void {
        this.headers.set(name.toLowerCase(), [value]);
    }

    addHeader(name: string, value: string): void {
        const key = name.toLowerCase();
        this.headers.set(key, [...this.headers.get(key) ?? [], value]);
    }

    // Headers end with an empty line even without a body; the Python plugin
    // left that line off messages without a body.
    build(): string {
        const start = this.method ? `${this.method} ${this.uri} SIP/2.0` : `SIP/2.0 ${this.statusCode} ${this.reason}`;
        const lines = [start];
        for (const [name, values] of this.headers)
            values.forEach(value => lines.push(`${name}: ${value}`));
        return lines.join('\r\n') + '\r\n\r\n' + this.body;
    }

    toString(): string {
        return `<SIPMessage method=${this.method} status_code=${this.statusCode} uri=${this.uri}>`;
    }
}

export class AuthHeader {
    constructor(readonly mode: string, readonly params: Record<string, string>) {
    }

    static parse(header: string): AuthHeader {
        if (!header.startsWith('Digest'))
            throw new Error('unsupported header mode, expected "Digest"');
        const params: Record<string, string> = {};
        for (const pair of header.slice('Digest'.length).split(',')) {
            const kv = pair.trim();
            const equals = kv.indexOf('=');
            if (equals < 0)
                throw new Error(`could not parse header param ${kv}`);
            let value = kv.slice(equals + 1);
            if (value.startsWith('"') && value.endsWith('"'))
                value = value.slice(1, -1);
            params[kv.slice(0, equals)] = value;
        }
        if (params.algorithm !== 'MD5')
            throw new Error(`unsupported auth digest ${params.algorithm}`);
        return new AuthHeader('Digest', params);
    }

    updateResponseDigest(method: string, password: string): void {
        const p = this.params;
        if (p.algorithm !== 'MD5')
            throw new Error(`cannot compute response digest with algorithm ${p.algorithm}`);
        if (p.qop !== 'auth')
            throw new Error(`cannot compute response digest with qop ${p.qop}`);
        for (const key of ['username', 'realm', 'uri', 'nonce', 'cnonce', 'nc']) {
            if (!(key in p))
                throw new Error(`missing ${key} in auth header`);
        }
        const ha1 = md5(p.username, p.realm, password);
        const ha2 = md5(method, p.uri);
        p.response = md5(ha1, p.nonce, p.nc, p.cnonce, p.qop, ha2);
    }

    toString(): string {
        const params = Object.entries(this.params)
            .map(([key, value]) => ['algorithm', 'qop', 'nc'].includes(key) ? `${key}=${value}` : `${key}="${value}"`);
        return `${this.mode} ${params.join(', ')}`;
    }
}

export interface SIPConfig {
    DeviceID: string;
    CallerURI: string;
    CalleeURI: string;
    Password: string;
    UserAgent: string;
    WebsocketURI: string;
    WebsocketOrigin: string;
    WebsocketHeaders: Record<string, string>;
    SDP: string;
}

const READ_TIMEOUT = 5_000;
const CONNECT_TIMEOUT = 10_000;

// Places a SIP call to an Arlo camera over a WebSocket to get its SDP answer,
// and starts and stops talk with SIP MESSAGEs, one request and its reply at a
// time.
export class SIPManager {
    // Called once if the call ends from the far side: the camera's BYE, or the
    // websocket closing when close() was not asked for.
    onEnded?: () => void;
    private readonly randHost = randString(12) + '.invalid';
    private readonly transactions = new AsyncLock();
    private closing = false;
    private ended = false;
    private ws?: WebSocket;
    private readonly inbox: string[] = [];
    private inboxWaiter?: Deferred<void>;
    private inviteResponse?: SIPMessage;
    private callId = '';
    private cseq = 1;
    private branch = '';
    private tag = '';
    private toTag?: string;
    private routeSet: string[] = [];

    constructor(private readonly logger: Logger, private readonly config: SIPConfig, private readonly taskManager: TaskManager) {
    }

    private get callerUser(): string {
        return this.config.CallerURI.split(':')[1].split('@')[0];
    }

    private async connectWebsocket(): Promise<void> {
        this.logger.debug(`Connecting to SIP websocket at ${this.config.WebsocketURI}`);
        const ws = new WebSocket(this.config.WebsocketURI, ['sip'], {
            headers: this.config.WebsocketHeaders,
            origin: this.config.WebsocketOrigin,
        });
        ws.on('message', data => {
            const text = data.toString();
            if (text.startsWith('BYE ')) {
                this.logger.debug(`Got SIP BYE:\n${text}`);
                // The call is over; no BYE goes back.
                this.inviteResponse = undefined;
                this.farEnd('The camera ended the SIP call.');
                return;
            }
            this.inbox.push(text);
            this.inboxWaiter?.resolve();
        });
        ws.on('error', e => this.logger.debug(`SIP websocket error: ${e}`));
        ws.on('close', () => {
            this.inboxWaiter?.reject(new Error('SIP websocket closed'));
            this.farEnd('The SIP websocket closed.');
        });
        try {
            await withTimeout(new Promise<void>((resolve, reject) => {
                ws.once('open', () => resolve());
                ws.once('error', reject);
                ws.once('close', () => reject(new Error('SIP websocket closed before it opened')));
            }), CONNECT_TIMEOUT, `SIP websocket did not open within ${CONNECT_TIMEOUT / 1000} seconds`);
        }
        catch (e) {
            this.closing = true;
            ws.terminate();
            throw e;
        }
        this.ws = ws;
        this.logger.debug('SIP websocket connected.');
    }

    private farEnd(reason: string): void {
        if (this.closing || this.ended)
            return;
        this.ended = true;
        this.logger.debug(reason);
        this.taskManager.cancelAndAwaitByOwner(this).catch(() => { });
        this.ws?.close();
        this.onEnded?.();
    }

    // Sends a request and reads its reply, after any request already waiting
    // for one.
    private transaction(msg: SIPMessage): Promise<SIPMessage> {
        return this.transactions.run(async () => {
            await this.write(msg);
            return this.read();
        });
    }

    private contact(): string {
        return `<sip:${this.callerUser}@${this.randHost};transport=ws>`;
    }

    private buildInvite(localSdp: string, auth?: string): SIPMessage {
        const msg = new SIPMessage();
        msg.method = 'INVITE';
        msg.uri = this.config.CalleeURI;
        msg.setHeader('Via', `SIP/2.0/WSS ${this.randHost};branch=${this.branch}`);
        msg.setHeader('Max-Forwards', '70');
        msg.setHeader('To', `<${this.config.CalleeURI}>`);
        msg.setHeader('From', `<${this.config.CallerURI}>;tag=${this.tag}`);
        msg.setHeader('Call-ID', this.callId);
        msg.setHeader('CSeq', `${this.cseq} INVITE`);
        msg.setHeader('Contact', this.contact());
        msg.setHeader('User-Agent', this.config.UserAgent);
        msg.setHeader('Supported', 'outbound');
        // Arlo's own app names the device on every INVITE, the trailing
        // semicolon included. Without it Arlo ends a talk call within a second.
        msg.setHeader('X-extension', `${this.config.DeviceID};`);
        msg.setHeader('Content-Type', 'application/sdp');
        msg.setHeader('Content-Length', String(Buffer.byteLength(localSdp)));
        if (auth)
            msg.setHeader('Proxy-Authorization', auth);
        msg.body = localSdp;
        return msg;
    }

    private buildAck(): SIPMessage {
        const msg = new SIPMessage();
        msg.method = 'ACK';
        msg.uri = this.config.CalleeURI;
        msg.setHeader('Via', `SIP/2.0/WSS ${this.randHost};branch=${genBranch()}`);
        msg.setHeader('Max-Forwards', '70');
        msg.setHeader('To', `<${this.config.CalleeURI}>` + (this.toTag ? `;tag=${this.toTag}` : ''));
        msg.setHeader('From', `<${this.config.CallerURI}>;tag=${this.tag}`);
        msg.setHeader('Call-ID', this.callId);
        msg.setHeader('CSeq', `${this.cseq} ACK`);
        msg.setHeader('Contact', this.contact());
        msg.setHeader('User-Agent', this.config.UserAgent);
        msg.setHeader('Supported', 'outbound');
        msg.setHeader('Content-Length', '0');
        this.routeSet.forEach(route => msg.addHeader('Route', route));
        return msg;
    }

    private buildBye(): SIPMessage {
        const msg = this.buildAck();
        msg.method = 'BYE';
        msg.setHeader('CSeq', `${this.cseq + 1} BYE`);
        return msg;
    }

    private buildMessage(payload: string): SIPMessage {
        const msg = new SIPMessage();
        msg.method = 'MESSAGE';
        msg.uri = this.config.CalleeURI;
        msg.setHeader('Via', `SIP/2.0/WSS ${this.randHost};branch=${genBranch()}`);
        msg.setHeader('Max-Forwards', '70');
        msg.setHeader('To', `<${this.config.CalleeURI}>`);
        msg.setHeader('From', `<${this.config.CallerURI}>;tag=${randString(8)}`);
        msg.setHeader('Call-ID', randString(16));
        msg.setHeader('CSeq', '1 MESSAGE');
        msg.setHeader('Contact', this.contact());
        msg.setHeader('User-Agent', this.config.UserAgent);
        msg.setHeader('Supported', 'outbound');
        msg.setHeader('Content-Type', 'text/plain');
        msg.setHeader('Content-Length', String(Buffer.byteLength(payload)));
        msg.body = payload;
        return msg;
    }

    private async write(msg: SIPMessage): Promise<void> {
        // Arlo expects the WebRTC-UDP transport name quoted.
        const text = msg.build().replaceAll('WebRTC-UDP', '"WebRTC-UDP"');
        this.logger.debug(`Sending SIP message:\n${text}`);
        await new Promise<void>((resolve, reject) => this.ws!.send(text, e => e ? reject(e) : resolve()));
    }

    private async read(): Promise<SIPMessage> {
        if (!this.inbox.length) {
            this.inboxWaiter = new Deferred();
            await withTimeout(this.inboxWaiter.promise, READ_TIMEOUT, 'Timed out waiting for a SIP response');
        }
        const raw = this.inbox.shift()!;
        this.logger.debug(`Got SIP response:\n${raw}`);
        return SIPMessage.parse(raw);
    }

    // Sends the INVITE, answers a proxy authentication challenge, and returns
    // the camera's SDP answer.
    async start(): Promise<string> {
        await this.connectWebsocket();
        try {
            this.callId = randString(16);
            this.cseq = 1;
            this.branch = genBranch();
            this.tag = randString(8);
            await this.write(this.buildInvite(this.config.SDP));
            if ((await this.read()).statusCode !== 100)
                throw new Error('Did not receive 100 Trying');
            let response = await this.read();
            if (response.statusCode === 407) {
                this.logger.debug('Received 407 Proxy Authentication Required.');
                const auth = AuthHeader.parse(response.getHeader('Proxy-Authenticate') ?? '');
                auth.params.username = this.callerUser;
                auth.params.uri = this.config.CalleeURI;
                auth.params.cnonce = randString(12);
                auth.params.nc = '00000001';
                auth.updateResponseDigest('INVITE', this.config.Password);
                this.cseq++;
                this.branch = genBranch();
                const invite = this.buildInvite(this.config.SDP, auth.toString());
                await this.write(this.buildAck());
                await this.write(invite);
                if ((await this.read()).statusCode !== 100)
                    throw new Error('Did not receive 100 Trying after auth');
                response = await this.read();
            }
            if (response.statusCode !== 200)
                throw new Error(`Did not receive 200 OK, got ${response.statusCode}`);
            const to = response.getHeader('To');
            if (to?.includes('tag='))
                this.toTag = to.split('tag=').pop()!.split(';')[0];
            // In-dialog requests carry the recorded route as Route headers,
            // from this end inwards: the reverse of the 200 OK's Record-Route
            // list. Echoed back as Record-Route, the ACK never reached Arlo's
            // media server, which ended the call after 32 seconds.
            this.routeSet = response.getHeaders('Record-Route').flatMap(splitHeaderList).reverse();
            await this.write(this.buildAck());
            this.inviteResponse = response;
            this.logger.debug('SIPManager session started successfully.');
            return response.body;
        }
        catch (e) {
            this.logger.error('Exception in SIPManager.start:', e);
            await this.close();
            throw e;
        }
    }

    async close(): Promise<void> {
        this.logger.debug('Closing SIPManager session.');
        this.closing = true;
        await this.taskManager.cancelAndAwaitByOwner(this);
        if (this.inviteResponse && this.ws?.readyState === WebSocket.OPEN) {
            try {
                await this.write(this.buildBye());
            }
            catch (e) {
                this.logger.warn(`Exception sending BYE: ${e}`);
            }
        }
        this.inviteResponse = undefined;
        this.ws?.close();
        this.ws = undefined;
    }

    async startTalk(): Promise<void> {
        await this.talk('startTalk');
    }

    async stopTalk(): Promise<void> {
        await this.talk('stopTalk');
    }

    private async talk(action: 'startTalk' | 'stopTalk'): Promise<void> {
        const response = await this.transaction(this.buildMessage(`deviceId:${this.config.DeviceID};${action}`));
        if (response.statusCode !== 200 && response.statusCode !== 202)
            throw new Error(`Did not receive 200 OK or 202 Accepted for ${action}, got ${response.statusCode}`);
    }
}

