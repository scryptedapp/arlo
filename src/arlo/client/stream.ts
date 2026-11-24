import type { Logger } from '../logging';
import { abortable, CancelledError, Deferred, setLongTimeout, withTimeout } from '../util';

export interface ArloEvent {
    resource?: string;
    action?: string;
    from?: string;
    to?: string;
    properties?: Record<string, any>;
    error?: any;
    [key: string]: any;
}

export type ActionSpec = string | null | [action: string, property: string];

const REPLAY_WINDOW = 5_000;

function matches(event: ArloEvent, resource: string, actions: ActionSpec[], fromId?: string): boolean {
    if (event.resource !== resource)
        return false;
    if (fromId !== undefined && event.from !== fromId)
        return false;
    return actions.some(spec => {
        const [action, property] = Array.isArray(spec) ? spec : [spec, undefined];
        if (action === 'error' && !property)
            return 'error' in event || event.action === 'error';
        if ((event.action ?? null) !== action)
            return false;
        return !property || (!!event.properties && property in event.properties);
    });
}

function isPropertyResponse(event: ArloEvent): boolean {
    const properties = event.properties;
    return event.action === 'is' && !!properties && typeof properties === 'object'
        && ('interfaceVersion' in properties || 'localCert' in properties);
}

interface Listener {
    resource: string;
    actions: ActionSpec[];
    fromId?: string;
    callback: (event: ArloEvent) => void;
}

export interface DispatcherHost {
    readonly setupInProgress: boolean;
}

export class EventDispatcher {
    private readonly listeners = new Set<Listener>();
    private recent: { event: ArloEvent, expires: number }[] = [];
    private held: ArloEvent[] = [];

    constructor(private readonly host: DispatcherHost, private readonly logger: Logger) {
    }

    listen(resource: string, actions: ActionSpec[], callback: (event: ArloEvent) => void,
        { fromId, replay = true }: { fromId?: string, replay?: boolean } = {}): () => void {
        const listener: Listener = { resource, actions, fromId, callback };
        this.listeners.add(listener);
        const recent = replay ? this.recentEvents().filter(event => matches(event, resource, actions, fromId)) : [];
        if (recent.length)
            queueMicrotask(() => recent.forEach(event => this.listeners.has(listener) && this.call(listener, event)));
        return () => this.listeners.delete(listener);
    }

    waitFor<T>(resource: string, actions: ActionSpec[], callback: (event: ArloEvent) => T | undefined,
        { fromId, replay, timeout, signal }: { fromId?: string, replay?: boolean, timeout?: number, signal?: AbortSignal } = {}): Promise<T> {
        const result = new Deferred<T>();
        const stop = this.listen(resource, actions, event => {
            const value = callback(event);
            if (value !== undefined)
                result.resolve(value);
        }, { fromId, replay });
        let wait = abortable(result.promise, signal);
        if (timeout !== undefined)
            wait = withTimeout(wait, timeout, `Timed out waiting for ${resource} event`);
        return wait.finally(stop);
    }

    dispatch(event: ArloEvent): void {
        if (this.host.setupInProgress && !isPropertyResponse(event)) {
            this.logger.debug(`Holding event during device setup: ${JSON.stringify(event)}`);
            this.held.push(event);
            return;
        }
        this.deliver(event);
    }

    releaseHeld(): void {
        const held = this.held;
        this.held = [];
        if (held.length)
            this.logger.debug(`Processing ${held.length} events held during device setup.`);
        held.forEach(event => this.deliver(event));
    }

    private deliver(event: ArloEvent): void {
        this.recentEvents();
        this.recent.push({ event, expires: Date.now() + REPLAY_WINDOW });
        for (const listener of [...this.listeners]) {
            if (matches(event, listener.resource, listener.actions, listener.fromId))
                this.call(listener, event);
        }
    }

    private recentEvents(): ArloEvent[] {
        const now = Date.now();
        this.recent = this.recent.filter(entry => entry.expires > now);
        return this.recent.map(entry => entry.event);
    }

    private call(listener: Listener, event: ArloEvent): void {
        try {
            listener.callback(event);
        }
        catch (e) {
            this.logger.error(`Error handling ${event.resource} event:`, e);
        }
    }
}

export interface StreamHost {
    readonly logger: Logger;
    waitForAuthReady(reason: string): Promise<void>;
    requestRestart(scope: 'event_stream'): void;
}

export abstract class Stream {
    connected = false;
    initializing = true;
    protected stopped = false;
    private connectWait?: Deferred<void>;
    private cancelRefresh?: () => void;

    constructor(protected readonly host: StreamHost, protected readonly dispatcher: EventDispatcher, readonly name: string) {
    }

    protected get logger(): Logger {
        return this.host.logger;
    }

    get active(): boolean {
        return this.connected;
    }

    abstract start(signal?: AbortSignal): Promise<void>;

    abstract subscribe(topics: string[]): void;

    protected abstract closeTransport(): Promise<void>;

    protected beginConnectWait(): void {
        this.connectWait?.reject(new CancelledError());
        this.connectWait = new Deferred();
    }

    protected markConnected(message: string): void {
        this.initializing = false;
        this.connected = true;
        this.logger.debug(message);
        this.connectWait?.resolve();
    }

    protected failConnectWait(error: Error): void {
        this.connectWait?.reject(error);
    }

    async waitConnected(timeout = 10_000): Promise<void> {
        if (this.connected)
            return;
        if (!this.connectWait)
            this.beginConnectWait();
        await withTimeout(this.connectWait!.promise, timeout, `${this.name} did not connect within ${timeout / 1000} seconds`);
    }

    setRefreshInterval(minutes: number): void {
        this.cancelRefresh?.();
        this.cancelRefresh = undefined;
        if (minutes <= 0 || this.stopped)
            return;
        this.cancelRefresh = setLongTimeout(async () => {
            this.logger.info(`Refreshing ${this.name}`);
            try {
                await this.host.waitForAuthReady(`${this.name} refresh`);
                this.host.requestRestart('event_stream');
            }
            catch (e) {
                this.logger.error('Error during stream refresh:', e);
            }
        }, minutes * 60_000);
    }

    async close(): Promise<void> {
        if (this.stopped)
            return;
        this.stopped = true;
        this.logger.debug(`Disconnecting ${this.name}...`);
        this.connected = false;
        this.cancelRefresh?.();
        this.connectWait?.reject(new CancelledError());
        try {
            await this.closeTransport();
        }
        catch (e) {
            this.logger.debug(`Error closing ${this.name} transport: ${e}`);
        }
    }
}
