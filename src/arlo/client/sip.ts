import crypto from 'node:crypto';
import WebSocket from 'ws';

import type { Logger } from '../logging';
import type { ArloProvider } from '../provider';
import { AsyncLock, Deferred, sleep, TaskManager, withTimeout } from '../util';

function randString(n: number, chars = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
    let result = '';
    for (let i = 0; i < n; i++)
        result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function genBranch(): string {
    return 'z9hG4bK' + randString(7, '0123456789');
}

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

function hangUpReason(bye: SIPMessage): string {
    const reasons = bye.getHeaders('Reason').flatMap(splitHeaderList)
        .map(reason => /text="([^"]*)"/.exec(reason)?.[1] || reason);
    return reasons.length ? `Arlo hung up (reason: ${reasons.join(', ')})` : 'Arlo hung up';
}

function md5Digest(...parts: string[]): string {
    return crypto.createHash('md5').update(parts.join(':')).digest('hex');
}

export class SIPMessage {
    method?: string;
    statusCode?: number;
    reason?: string;
    uri?: string;
    headers = new Map<string, string[]>();
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
    constructor(public mode: string, public params: Record<string, string>) {
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
        const ha1 = md5Digest(p.username, p.realm, password);
        const ha2 = md5Digest(method, p.uri);
        p.response = md5Digest(ha1, p.nonce, p.nc, p.cnonce, p.qop, ha2);
    }

    toString(): string {
        const params = Object.entries(this.params)
            .map(([key, value]) => ['algorithm', 'qop', 'nc'].includes(key) ? `${key}=${value}` : `${key}="${value}"`);
        return `${this.mode} ${params.join(', ')}`;
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
}

interface SIPConfig {
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

export class SIPManager {
    onEnded?: (reason: string) => void;
    talking = false;
    taskManager: TaskManager;
    randHost = randString(12) + '.invalid';
    timeout = 5_000;
    ws?: WebSocket;
    inviteResp?: SIPMessage;
    callId = '';
    cseq = 1;
    branch = '';
    tag = '';
    toTag?: string;
    routeSet: string[] = [];
    private transactionLock = new AsyncLock();
    private closed = false;
    private inbox: string[] = [];
    private inboxWaiter?: Deferred<void>;

    constructor(public logger: Logger, public sipCfg: SIPConfig, public provider: ArloProvider) {
        this.taskManager = provider.taskManager;
    }

    private get callerUser(): string {
        return this.sipCfg.CallerURI.split(':')[1].split('@')[0];
    }

    async connectWebsocket(): Promise<void> {
        this.logger.debug(`Connecting to SIP websocket at ${this.sipCfg.WebsocketURI}`);
        const ws = new WebSocket(this.sipCfg.WebsocketURI, ['sip'], {
            headers: this.sipCfg.WebsocketHeaders,
            origin: this.sipCfg.WebsocketOrigin,
        });
        ws.on('message', data => {
            const text = data.toString();
            if (text.startsWith('BYE ')) {
                this.logger.debug(`Got SIP BYE:\n${text}`);
                this.inviteResp = undefined;
                this.remoteEnded(hangUpReason(SIPMessage.parse(text)));
                return;
            }
            this.inbox.push(text);
            this.inboxWaiter?.resolve();
        });
        ws.on('error', e => this.logger.debug(`SIP websocket error: ${e}`));
        ws.on('close', () => {
            this.inboxWaiter?.reject(new Error('SIP websocket closed'));
            this.remoteEnded("the connection to Arlo's SIP server closed");
        });
        try {
            await withTimeout(new Promise<void>((resolve, reject) => {
                ws.once('open', () => resolve());
                ws.once('error', reject);
                ws.once('close', () => reject(new Error('SIP websocket closed before it opened')));
            }), 10_000, 'SIP websocket did not open within 10 seconds');
        }
        catch (e) {
            this.closed = true;
            ws.terminate();
            throw e;
        }
        this.ws = ws;
        this.logger.debug('SIP websocket connected.');
    }

    private remoteEnded(reason: string): void {
        if (this.closed)
            return;
        this.closed = true;
        this.logger.debug(`The SIP call ended: ${reason}.`);
        this.taskManager.cancelAndAwaitByOwner(this).catch(() => { });
        this.ws?.close();
        this.onEnded?.(reason);
    }

    buildInvite(localSdp: string, auth?: string): SIPMessage {
        const msg = new SIPMessage();
        msg.method = 'INVITE';
        msg.uri = this.sipCfg.CalleeURI;
        msg.setHeader('Via', `SIP/2.0/WSS ${this.randHost};branch=${this.branch}`);
        msg.setHeader('Max-Forwards', '70');
        msg.setHeader('To', `<${this.sipCfg.CalleeURI}>`);
        msg.setHeader('From', `<${this.sipCfg.CallerURI}>;tag=${this.tag}`);
        msg.setHeader('Call-ID', this.callId);
        msg.setHeader('CSeq', `${this.cseq} INVITE`);
        msg.setHeader('Contact', `<sip:${this.callerUser}@${this.randHost};transport=ws>`);
        msg.setHeader('User-Agent', this.sipCfg.UserAgent);
        msg.setHeader('Supported', 'outbound');
        msg.setHeader('X-extension', `${this.sipCfg.DeviceID};`);
        msg.setHeader('Content-Type', 'application/sdp');
        msg.setHeader('Content-Length', String(Buffer.byteLength(localSdp)));
        if (auth)
            msg.setHeader('Proxy-Authorization', auth);
        msg.body = localSdp;
        return msg;
    }

    buildAck(): SIPMessage {
        const msg = new SIPMessage();
        msg.method = 'ACK';
        msg.uri = this.sipCfg.CalleeURI;
        msg.setHeader('Via', `SIP/2.0/WSS ${this.randHost};branch=${genBranch()}`);
        msg.setHeader('Max-Forwards', '70');
        msg.setHeader('To', `<${this.sipCfg.CalleeURI}>` + (this.toTag ? `;tag=${this.toTag}` : ''));
        msg.setHeader('From', `<${this.sipCfg.CallerURI}>;tag=${this.tag}`);
        msg.setHeader('Call-ID', this.callId);
        msg.setHeader('CSeq', `${this.cseq} ACK`);
        msg.setHeader('Contact', `<sip:${this.callerUser}@${this.randHost};transport=ws>`);
        msg.setHeader('User-Agent', this.sipCfg.UserAgent);
        msg.setHeader('Supported', 'outbound');
        msg.setHeader('Content-Length', '0');
        this.routeSet.forEach(route => msg.addHeader('Route', route));
        return msg;
    }

    buildBye(): SIPMessage {
        const msg = this.buildAck();
        msg.method = 'BYE';
        msg.setHeader('CSeq', `${this.cseq + 1} BYE`);
        return msg;
    }

    buildMessage(payload: string): SIPMessage {
        const msg = new SIPMessage();
        msg.method = 'MESSAGE';
        msg.uri = this.sipCfg.CalleeURI;
        msg.setHeader('Via', `SIP/2.0/WSS ${this.randHost};branch=${genBranch()}`);
        msg.setHeader('Max-Forwards', '70');
        msg.setHeader('To', `<${this.sipCfg.CalleeURI}>`);
        msg.setHeader('From', `<${this.sipCfg.CallerURI}>;tag=${randString(8)}`);
        msg.setHeader('Call-ID', randString(16));
        msg.setHeader('CSeq', '1 MESSAGE');
        msg.setHeader('Contact', `<sip:${this.callerUser}@${this.randHost};transport=ws>`);
        msg.setHeader('User-Agent', this.sipCfg.UserAgent);
        msg.setHeader('Supported', 'outbound');
        msg.setHeader('Content-Type', 'text/plain');
        msg.setHeader('Content-Length', String(Buffer.byteLength(payload)));
        msg.body = payload;
        return msg;
    }

    async writeWebsocket(msg: SIPMessage): Promise<void> {
        const text = msg.build().replaceAll('WebRTC-UDP', '"WebRTC-UDP"');
        this.logger.debug(`Sending SIP message:\n${text}`);
        await new Promise<void>((resolve, reject) => this.ws.send(text, e => e ? reject(e) : resolve()));
    }

    async readWebsocket(): Promise<SIPMessage> {
        if (!this.inbox.length) {
            this.inboxWaiter = new Deferred();
            await withTimeout(this.inboxWaiter.promise, this.timeout, 'Timed out waiting for a SIP response');
        }
        const raw = this.inbox.shift();
        this.logger.debug(`Got SIP response:\n${raw}`);
        return SIPMessage.parse(raw);
    }

    private transaction(msg: SIPMessage): Promise<SIPMessage> {
        return this.transactionLock.run(async () => {
            await this.writeWebsocket(msg);
            return this.readWebsocket();
        });
    }

    async start(): Promise<string> {
        await this.connectWebsocket();
        try {
            this.callId = randString(16);
            this.cseq = 1;
            this.branch = genBranch();
            this.tag = randString(8);
            await this.writeWebsocket(this.buildInvite(this.sipCfg.SDP));
            if ((await this.readWebsocket()).statusCode !== 100)
                throw new Error('Did not receive 100 Trying');
            let response = await this.readWebsocket();
            if (response.statusCode === 407) {
                this.logger.debug('Received 407 Proxy Authentication Required.');
                const auth = AuthHeader.parse(response.getHeader('Proxy-Authenticate') ?? '');
                auth.params.username = this.callerUser;
                auth.params.uri = this.sipCfg.CalleeURI;
                auth.params.cnonce = randString(12);
                auth.params.nc = '00000001';
                auth.updateResponseDigest('INVITE', this.sipCfg.Password);
                this.cseq++;
                this.branch = genBranch();
                const invite = this.buildInvite(this.sipCfg.SDP, auth.toString());
                await this.writeWebsocket(this.buildAck());
                await this.writeWebsocket(invite);
                if ((await this.readWebsocket()).statusCode !== 100)
                    throw new Error('Did not receive 100 Trying after auth');
                response = await this.readWebsocket();
            }
            if (response.statusCode !== 200)
                throw new Error(`Did not receive 200 OK, got ${response.statusCode}`);
            const to = response.getHeader('To');
            if (to?.includes('tag='))
                this.toTag = to.split('tag=').pop().split(';')[0];
            this.routeSet = response.getHeaders('Record-Route').flatMap(splitHeaderList).reverse();
            await this.writeWebsocket(this.buildAck());
            this.inviteResp = response;
            this.logger.debug('SIPManager session started successfully.');
            return response.body;
        }
        catch (e) {
            this.logger.error('Exception in SIPManager.start:', e);
            await this.close();
            throw e;
        }
    }

    private async keepaliveLoop(signal: AbortSignal): Promise<void> {
        try {
            while (true) {
                await sleep(30_000, signal);
                const response = await this.transaction(this.buildMessage('keepAlive'));
                if (response.statusCode !== 200 && response.statusCode !== 202) {
                    this.logger.warn(`Did not receive 200 OK or 202 Accepted for keepAlive, got ${response.statusCode}`);
                    return;
                }
            }
        }
        catch (e) {
            if (!signal.aborted)
                this.logger.warn(`Talk keepAlive stopped: ${e instanceof Error ? e.message : e}`);
        }
    }

    async close(): Promise<void> {
        this.logger.debug('Closing SIPManager session.');
        this.closed = true;
        this.talking = false;
        await this.taskManager.cancelAndAwaitByOwner(this);
        if (this.inviteResp && this.ws?.readyState === WebSocket.OPEN) {
            try {
                await this.transactionLock.run(async () => {
                    await this.writeWebsocket(this.buildBye());
                    let response = await this.readWebsocket();
                    while (!response.getHeader('CSeq')?.endsWith('BYE'))
                        response = await this.readWebsocket();
                    if (response.statusCode !== 200)
                        this.logger.warn(`Arlo answered BYE with ${response.statusCode} ${response.reason}`);
                });
            }
            catch (e) {
                this.logger.warn(`Exception sending BYE: ${e}`);
            }
        }
        this.inviteResp = undefined;
        this.ws?.close();
        this.ws = undefined;
    }

    async startTalk(): Promise<void> {
        await this.taskManager.cancelAndAwaitByTag('sip_keepalive', this);
        this.talking = true;
        await this.talk('startTalk');
        this.taskManager.createTask(signal => this.keepaliveLoop(signal), { tag: 'sip_keepalive', owner: this });
    }

    async stopTalk(): Promise<void> {
        await this.taskManager.cancelAndAwaitByTag('sip_keepalive', this);
        this.talking = false;
        await this.talk('stopTalk');
    }

    private async talk(action: 'startTalk' | 'stopTalk'): Promise<void> {
        const response = await this.transaction(this.buildMessage(`deviceId:${this.sipCfg.DeviceID};${action}`));
        if (response.statusCode !== 200 && response.statusCode !== 202)
            throw new Error(`Did not receive 200 OK or 202 Accepted for ${action}, got ${response.statusCode}`);
    }
}

