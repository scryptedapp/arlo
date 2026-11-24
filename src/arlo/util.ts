import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from './logging';

export class CancelledError extends Error {
    name = 'CancelledError';

    constructor(message = 'Cancelled') {
        super(message);
    }
}

export class TimeoutError extends Error {
    name = 'TimeoutError';
}

const MAX_TIMER = 2 ** 31 - 1;

export function setLongTimeout(callback: () => void, ms: number): () => void {
    const end = Date.now() + ms;
    let timer: NodeJS.Timeout;
    const arm = () => {
        const remaining = end - Date.now();
        if (remaining > 0)
            timer = setTimeout(arm, Math.min(remaining, MAX_TIMER));
        else
            callback();
    };
    timer = setTimeout(arm, Number.isNaN(ms) ? 0 : Math.min(Math.max(ms, 0), MAX_TIMER));
    return () => clearTimeout(timer);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(new CancelledError());
        const onAbort = () => {
            cancel();
            reject(new CancelledError());
        };
        const cancel = setLongTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal)
        return promise;
    if (signal.aborted)
        return Promise.reject(new CancelledError());
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new CancelledError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(message ?? `Timed out after ${ms / 1000} seconds`)), ms);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

export class Deferred<T> {
    promise: Promise<T>;
    done = false;
    private settle: { resolve: (value: T) => void, reject: (error: unknown) => void };

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => this.settle = { resolve, reject });
        this.promise.catch(() => { });
    }

    resolve(value: T): void {
        if (this.done)
            return;
        this.done = true;
        this.settle.resolve(value);
    }

    reject(error: unknown): void {
        if (this.done)
            return;
        this.done = true;
        this.settle.reject(error);
    }
}

export class AsyncEvent {
    private waiting?: Deferred<void>;

    constructor(private flag = false) {
    }

    isSet(): boolean {
        return this.flag;
    }

    set(): void {
        this.flag = true;
        this.waiting?.resolve();
        this.waiting = undefined;
    }

    clear(): void {
        this.flag = false;
    }

    wait(signal?: AbortSignal): Promise<void> {
        if (this.flag)
            return Promise.resolve();
        this.waiting ??= new Deferred();
        return abortable(this.waiting.promise, signal);
    }
}

export class AsyncLock {
    private tail: Promise<void> = Promise.resolve();
    private holders = 0;

    get locked(): boolean {
        return this.holders > 0;
    }

    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        this.holders++;
        const previous = this.tail;
        let release: () => void;
        this.tail = new Promise(resolve => release = resolve);
        let acquired = false;
        try {
            await abortable(previous, signal);
            acquired = true;
            return await fn();
        }
        finally {
            this.holders--;
            if (acquired)
                release();
            else
                previous.then(release);
        }
    }
}

export interface TaskOptions {
    tag: string;
    owner: object;
}

export class Task<T = unknown> {
    controller = new AbortController();
    promise: Promise<T>;
    done = false;

    constructor(public tag: string, public owner: object) {
    }

    get signal(): AbortSignal {
        return this.controller.signal;
    }
}

const currentTask = new AsyncLocalStorage<Task>();

export class TaskManager {
    private tasks = new Set<Task>();

    constructor(private logger: Logger) {
    }

    createTask<T>(fn: (signal: AbortSignal) => Promise<T>, { tag, owner }: TaskOptions): Task<T> {
        if (!tag)
            throw new Error('A task needs a tag.');
        const task = new Task<T>(tag, owner);
        this.tasks.add(task);
        task.promise = currentTask.run(task, async () => fn(task.signal));
        task.promise.then(undefined, (error: unknown) => {
            if (error instanceof CancelledError || task.signal.aborted)
                return;
            const logger = (owner as { logger?: Logger }).logger ?? this.logger;
            logger.error(`Background task ${tag} failed:`, error);
        }).finally(() => {
            task.done = true;
            this.tasks.delete(task);
        });
        return task;
    }

    cancelAndAwaitByTag(tag: string, owner?: object): Promise<void> {
        return this.cancelAndAwait(task => task.tag === tag && (!owner || task.owner === owner));
    }

    cancelAndAwaitByOwner(owner: object): Promise<void> {
        return this.cancelAndAwait(task => task.owner === owner);
    }

    cancelAllExcept(tag?: string, owner?: object): void {
        for (const task of this.select(task => (!owner || task.owner === owner) && task.tag !== tag))
            task.controller.abort();
    }

    private select(match: (task: Task) => boolean): Task[] {
        const current = currentTask.getStore();
        return [...this.tasks].filter(task => task !== current && !task.done && match(task));
    }

    private async cancelAndAwait(match: (task: Task) => boolean): Promise<void> {
        const tasks = this.select(match);
        for (const task of tasks)
            task.controller.abort();
        await Promise.allSettled(tasks.map(task => task.promise));
    }
}

export interface RequestErrorDetails {
    statusCode?: number;
    retryAfter?: number;
    method?: string;
    url?: string;
}

/** Base error for request-related failures. */
export class RequestError extends Error {
    statusCode?: number;
    retryAfter?: number;
    method?: string;
    url?: string;

    constructor(message: string, details: RequestErrorDetails = {}) {
        super(message);
        this.name = new.target.name;
        Object.assign(this, details);
    }
}

/** Raised when a request proves the Arlo session token is no longer valid. */
export class UnauthorizedRestartException extends RequestError { }

/** Raised when Arlo or Cloudflare asks the plugin to stop sending requests. */
export class RateLimitedError extends RequestError { }

/** Raised for temporary network or server failures that should not trigger auth. */
export class TransientRequestError extends RequestError { }

/** Response could not be parsed or was invalid for expected schema. */
export class InvalidResponseError extends RequestError { }

/** HTTP 4xx non-auth client errors that should not trigger restart. */
export class BadRequestError extends RequestError { }

const MINUTE = 60_000;

export class RateLimitPause {
    static delay = 65 * MINUTE;
    static noticeInterval = 5 * MINUTE;

    private nextNotice = 0;

    activate(): number {
        const now = Date.now();
        this.nextNotice = now + RateLimitPause.noticeInterval;
        return now + RateLimitPause.delay;
    }

    shouldLogWait(): boolean {
        const now = Date.now();
        if (now < this.nextNotice)
            return false;
        this.nextNotice = now + RateLimitPause.noticeInterval;
        return true;
    }

    static formatRemaining(ms: number): string {
        const totalMinutes = Math.ceil(Math.max(0, Math.floor(ms / 1000)) / 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (hours && minutes)
            return `${hours}h ${minutes}m`;
        if (hours)
            return `${hours}h`;
        return `${Math.max(1, minutes)}m`;
    }
}

function formatLocalTime(time: number): string {
    const date = new Date(time);
    const pad = (n: number) => String(n).padStart(2, '0');
    const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
        .formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`.trim();
}

const AUTH_FLOW_MARKERS = [
    'ocapi-app.arlo.com/api/',
    '/api/auth',
    '/api/getFactorId',
    '/api/getFactors',
    '/api/startAuth',
    '/api/finishAuth',
    '/api/validateAccessToken',
    '/api/startPairingFactor',
    '/hmsweb/users/session',
    '/hmsweb/logout',
    '/hmsweb/client/unsubscribe',
];

const AUTH_WAIT = 75_000;

export interface ErrorManagerHost {
    storage: Storage;
    logger: Logger;
    taskManager: TaskManager;
}

export interface ErrorManagerOptions {
    recoverAuth(reason: string, signal: AbortSignal): Promise<void>;
    restartPlugin(): void;
}

export interface RequestOptions {
    suppressRestartOn401?: boolean;
}

export class ErrorManager {
    private rateLimit = new RateLimitPause();
    private authReady = new AsyncEvent(true);
    private authRecovery?: Task;
    private authDepth = 0;
    private authReason = '';
    private authStartedAt = 0;
    private authSucceeded = false;
    private lastAuthSuccessAt = 0;

    constructor(private host: ErrorManagerHost, private options: ErrorManagerOptions) {
    }

    private get logger(): Logger {
        return this.host.logger;
    }

    private get storage(): Storage {
        return this.host.storage;
    }

    private get rateLimitUntil(): number {
        const until = Number(this.storage.getItem('arlo_rate_limit_until'));
        return Number.isFinite(until) ? until : 0;
    }

    private set rateLimitUntil(until: number) {
        this.storage.setItem('arlo_rate_limit_until', String(until || 0));
    }

    private get rateLimitDisableActive(): boolean {
        return this.storage.getItem('arlo_rate_limit_disable_active') === 'true';
    }

    private set rateLimitDisableActive(active: boolean) {
        this.storage.setItem('arlo_rate_limit_disable_active', String(active));
    }

    private set disablePlugin(disabled: boolean) {
        this.storage.setItem('disable_plugin', String(disabled));
    }

    rateLimitRemaining(): number {
        return Math.max(0, this.rateLimitUntil - Date.now());
    }

    private resumeTime(): string {
        return formatLocalTime(this.rateLimitUntil);
    }

    async authTransition<T>(reason: string, fn: () => Promise<T>): Promise<T> {
        this.beginAuthTransition(reason);
        try {
            return await fn();
        }
        finally {
            this.endAuthTransition(false);
        }
    }

    beginAuthTransition(reason: string): void {
        if (this.authDepth === 0) {
            this.logger.debug(`Arlo auth transition started: ${reason}`);
            this.authStartedAt = Date.now();
            this.authSucceeded = false;
            this.authReady.clear();
        }
        this.authDepth++;
        this.authReason = reason;
    }

    endAuthTransition(success: boolean): void {
        if (success) {
            this.authSucceeded = true;
            this.lastAuthSuccessAt = Date.now();
        }
        if (this.authDepth > 0)
            this.authDepth--;
        if (this.authDepth > 0)
            return;
        if (!this.authReady.isSet())
            this.logger.debug(`Arlo auth transition ${this.authSucceeded ? 'succeeded' : 'ended'}: ${this.authReason || 'auth refresh'}`);
        this.authReason = '';
        this.authReady.set();
    }

    handleRateLimitStartup(): boolean {
        const remaining = this.rateLimitRemaining();
        if (remaining > 0) {
            this.rateLimitDisableActive = true;
            this.disablePlugin = true;
            this.logger.warn(
                'Arlo plugin is disabled because Arlo/Cloudflare returned 429 Too Many Requests. '
                + `Waiting about ${RateLimitPause.formatRemaining(remaining)} before trying again after ${this.resumeTime()}. `
                + 'No Arlo Cloud requests, relogin, or MFA will run during this pause.');
            this.host.taskManager.createTask(signal => this.restartAfterRateLimitPause(signal), { tag: 'rate_limit_pause', owner: this.host });
            return true;
        }
        if (this.rateLimitDisableActive) {
            this.logger.info('Arlo rate-limit pause has ended. Re-enabling plugin.');
            this.clearRateLimitPause();
            this.disablePlugin = false;
        }
        return false;
    }

    handleDisablePluginSetting(requestedDisable: boolean): boolean {
        const remaining = this.rateLimitRemaining();
        if (!requestedDisable && remaining > 0) {
            this.disablePlugin = true;
            this.rateLimitDisableActive = true;
            this.logger.warn(
                'Arlo plugin cannot be re-enabled yet because the Arlo/Cloudflare 429 pause '
                + `has about ${RateLimitPause.formatRemaining(remaining)} remaining. `
                + `The plugin can be re-enabled after ${this.resumeTime()}.`);
            return false;
        }
        if (!requestedDisable && this.rateLimitDisableActive)
            this.clearRateLimitPause();
        this.disablePlugin = requestedDisable;
        this.logger.debug(`Arlo plugin will be ${requestedDisable ? 'disabled' : 'enabled'}. Restarting...`);
        return true;
    }

    private clearRateLimitPause(): void {
        this.rateLimitUntil = 0;
        this.rateLimitDisableActive = false;
    }

    private async restartAfterRateLimitPause(signal: AbortSignal): Promise<void> {
        const remaining = this.rateLimitRemaining();
        if (remaining > 0)
            await sleep(remaining, signal);
        if (this.rateLimitRemaining() > 0) {
            this.options.restartPlugin();
            return;
        }
        this.clearRateLimitPause();
        this.disablePlugin = false;
        this.logger.info('Arlo rate-limit pause complete. Restarting plugin to resume Arlo Cloud.');
        this.options.restartPlugin();
    }

    beforeRequest(method: string, url: string, { suppressRestartOn401 = false }: RequestOptions = {}): void {
        if (this.rateLimitRemaining() > 0) {
            const remaining = this.logRateLimitWait(method, url);
            throw new RateLimitedError(
                `Arlo requests are paused for ${Math.floor(remaining / 1000)} seconds due to rate limiting.`,
                { statusCode: 429, retryAfter: remaining, method, url });
        }
        if (this.shouldDeferCloudRequest(url, suppressRestartOn401))
            throw new TransientRequestError('Arlo auth refresh is in progress; cloud request was deferred.', { method, url });
    }

    async waitForAuthReady(url = '', { timeout = AUTH_WAIT, suppressRestartOn401 = false, signal }: { timeout?: number, suppressRestartOn401?: boolean, signal?: AbortSignal } = {}): Promise<void> {
        if (!this.shouldDeferCloudRequest(url, suppressRestartOn401))
            return;
        this.logger.debug(`Waiting for Arlo auth transition (${this.authReason || 'auth refresh'}) before cloud request: ${url}`);
        try {
            await withTimeout(this.authReady.wait(signal), timeout);
        }
        catch (e) {
            if (e instanceof TimeoutError)
                throw new TransientRequestError(`Arlo auth transition did not finish within ${timeout / 1000} seconds.`, { url });
            throw e;
        }
    }

    private shouldDeferCloudRequest(url: string, suppressRestartOn401: boolean): boolean {
        if (suppressRestartOn401 || this.authReady.isSet())
            return false;
        return !AUTH_FLOW_MARKERS.some(marker => url.includes(marker));
    }

    handleHttpError(statusCode: number, method: string, url: string, requestStartedAt?: number, { suppressRestartOn401 = false }: RequestOptions = {}): Record<string, never> {
        if (suppressRestartOn401 && statusCode === 401) {
            this.logger.debug(`Ignoring 401 for cleanup request ${method} ${url}.`);
            return {};
        }
        this.raiseRequestError(statusCode, `HTTP error ${statusCode} for ${method} ${url}`, method, url, requestStartedAt);
    }

    raiseBodyError(body: unknown, method: string, url: string, requestStartedAt?: number): never {
        const code = Number((body as { meta?: { code?: unknown } })?.meta?.code);
        this.raiseRequestError(Number.isInteger(code) ? code : undefined,
            `Request (${method} ${url}) failed: ${JSON.stringify(body)}`, method, url, requestStartedAt);
    }

    private raiseRequestError(statusCode: number | undefined, message: string, method: string, url: string, requestStartedAt?: number): never {
        if (statusCode === 401) {
            this.requestAuthRecovery(message, requestStartedAt);
            throw new UnauthorizedRestartException(message, { statusCode, method, url });
        }
        if (statusCode === 429) {
            const retryAfter = this.activateRateLimit(message);
            throw new RateLimitedError(message, { statusCode, retryAfter, method, url });
        }
        if (statusCode === 408 || statusCode === 425 || (statusCode !== undefined && statusCode >= 500 && statusCode < 600))
            throw new TransientRequestError(message, { statusCode, method, url });
        throw new BadRequestError(message, { statusCode, method, url });
    }

    markHttpSuccess(): void {
        if (this.rateLimitDisableActive && this.rateLimitRemaining() <= 0)
            this.clearRateLimitPause();
    }

    requestAuthRecovery(reason: string, requestStartedAt?: number): void {
        if (this.rateLimitRemaining() > 0) {
            this.logRateLimitWait('AUTH_RECOVERY', reason);
            return;
        }
        if (this.isStaleAuthError(requestStartedAt))
            return;
        if (this.authRecovery && !this.authRecovery.done) {
            this.logger.debug(`Session recovery already in progress. Latest reason: ${reason}`);
            return;
        }
        if (!this.authReady.isSet()) {
            this.logger.debug(`Ignoring a 401 during an Arlo auth transition (${this.authReason || 'auth refresh'}): ${reason}`);
            return;
        }
        this.authRecovery = this.host.taskManager.createTask(signal => this.options.recoverAuth(reason, signal), { tag: 'auth_recovery', owner: this.host });
    }

    private activateRateLimit(source: string): number {
        const until = this.rateLimit.activate();
        this.rateLimitUntil = until;
        this.rateLimitDisableActive = true;
        this.disablePlugin = true;
        const remaining = until - Date.now();
        this.logger.warn(
            'Arlo/Cloudflare returned 429 Too Many Requests. '
            + `Disabling Arlo plugin for about ${RateLimitPause.formatRemaining(remaining)} until ${this.resumeTime()}. `
            + 'No Arlo Cloud requests, relogin, or MFA will run during this pause.'
            + (source ? ` Source: ${source}` : ''));
        this.options.restartPlugin();
        return remaining;
    }

    private logRateLimitWait(method?: string, url?: string): number {
        const remaining = this.rateLimitRemaining();
        const target = method && url ? ` ${method} ${url}` : '';
        if (this.rateLimit.shouldLogWait()) {
            this.logger.warn(
                `Arlo Cloud requests are still paused for about ${RateLimitPause.formatRemaining(remaining)} after a 429 rate limit. `
                + `Skipping${target}; no network request was sent.`);
        }
        else {
            this.logger.debug(`Arlo request skipped during active rate limit pause (${Math.floor(remaining / 1000)} seconds remaining):${target}`);
        }
        return remaining;
    }

    private isStaleAuthError(requestStartedAt?: number): boolean {
        if (!this.authReady.isSet() && requestStartedAt && this.authStartedAt) {
            if (requestStartedAt >= this.authStartedAt)
                return false;
            this.logger.debug(`Ignoring stale 401 from request that began before active Arlo auth transition: ${this.authReason || 'auth refresh'}`);
            return true;
        }
        if (requestStartedAt && this.lastAuthSuccessAt && requestStartedAt < this.lastAuthSuccessAt) {
            this.logger.debug('Ignoring stale 401 from request that began before the latest successful Arlo auth.');
            return true;
        }
        return false;
    }
}
