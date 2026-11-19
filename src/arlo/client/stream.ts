import type { Logger } from '../logging';
import { abortable, CancelledError, Deferred, withTimeout } from '../util';

// An Arlo event as it arrives on the event stream.
export interface ArloEvent {
    resource?: string;
    action?: string;
    from?: string;
    to?: string;
    properties?: Record<string, any>;
    error?: any;
    [key: string]: any;
}

// Which events a listener wants: an action (null for events without one), or
// an action with a property the event's properties must contain. The action
// 'error' matches any event that carries an error.
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

// A property response answers the plugin's own property requests, which
// device discovery waits for, so it is never held back.
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

// Delivers events from whichever event stream is running to the listeners
// registered with the client, so listeners survive stream restarts. Events
// stay replayable for five seconds, for listeners that register just after
// the event they wait for; a listener waiting for the answer to its own
// request turns replay off, so another request's answer cannot pass for it. While device setup runs, events other than property
// responses are held and delivered when it finishes.
export class EventDispatcher {
    private readonly listeners = new Set<Listener>();
    private recent: { event: ArloEvent, expires: number }[] = [];
    private held: ArloEvent[] = [];

    constructor(private readonly host: DispatcherHost, private readonly logger: Logger) {
    }

    // Calls callback for each matching event until the returned function is
    // called. Matching events from the last five seconds are replayed first,
    // unless replay is false.
    listen(resource: string, actions: ActionSpec[], callback: (event: ArloEvent) => void,
        { fromId, replay = true }: { fromId?: string, replay?: boolean } = {}): () => void {
        const listener: Listener = { resource, actions, fromId, callback };
        this.listeners.add(listener);
        const recent = replay ? this.recentEvents().filter(event => matches(event, resource, actions, fromId)) : [];
        if (recent.length)
            queueMicrotask(() => recent.forEach(event => this.listeners.has(listener) && this.call(listener, event)));
        return () => this.listeners.delete(listener);
    }

    // Resolves with the first value callback returns for a matching event.
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

    // Delivers the events held during device setup.
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

// The connection that brings Arlo events in. Subclasses supply the transport.
// A stream is used once: restarting the event stream replaces it.
export abstract class Stream {
    connected = false;
    initializing = true;
    protected stopped = false;
    private connectWait?: Deferred<void>;
    private refreshTimer?: NodeJS.Timeout;

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

    // Restarts the event stream every interval minutes; 0 turns this off.
    setRefreshInterval(minutes: number): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
        if (minutes <= 0 || this.stopped)
            return;
        this.refreshTimer = setTimeout(async () => {
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
        clearTimeout(this.refreshTimer);
        this.connectWait?.reject(new CancelledError());
        try {
            await this.closeTransport();
        }
        catch (e) {
            this.logger.debug(`Error closing ${this.name} transport: ${e}`);
        }
    }
}
