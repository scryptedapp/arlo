import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from './logging';
import type { ArloProvider } from './provider';

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
    tasks = new Set<Task>();

    constructor(private logger: Logger) {
    }

    createTask<T>(fn: (signal: AbortSignal) => Promise<T>, { tag, owner }: { tag: string, owner: object }): Task<T> {
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

/** Base error for request-related failures. */
export class RequestError extends Error {
    statusCode?: number;
    retryAfter?: number;
    method?: string;
    url?: string;

    constructor(message: string, { statusCode, retryAfter, method, url }: { statusCode?: number, retryAfter?: number, method?: string, url?: string } = {}) {
        super(message);
        this.name = new.target.name;
        this.statusCode = statusCode;
        this.retryAfter = retryAfter;
        this.method = method;
        this.url = url;
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

class RateLimitPause {
    delay = 65 * 60_000;
    noticeInterval = 300_000;
    nextNotice = 0;

    activate(): number {
        const now = Date.now();
        this.nextNotice = now + this.noticeInterval;
        return now + this.delay;
    }

    shouldLogWait(): boolean {
        const now = Date.now();
        if (now < this.nextNotice)
            return false;
        this.nextNotice = now + this.noticeInterval;
        return true;
    }

    formatRemaining(ms: number): string {
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

export class ErrorManager {
    static authFlowMarkers = [
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

    recoverAuth: (reason: string, signal: AbortSignal) => Promise<void>;
    restartPlugin: () => void;
    rateLimit = new RateLimitPause();
    authReadyEvent = new AsyncEvent(true);
    authRecoveryTask?: Task;
    authDepth = 0;
    authReason = '';
    authStartedAt = 0;
    authSucceeded = false;
    lastAuthSuccessAt = 0;

    constructor(public provider: ArloProvider, { recoverAuth, restartPlugin }: { recoverAuth: (reason: string, signal: AbortSignal) => Promise<void>, restartPlugin: () => void }) {
        this.recoverAuth = recoverAuth;
        this.restartPlugin = restartPlugin;
    }

    get logger(): Logger {
        return this.provider.logger;
    }

    get authTransitionActive(): boolean {
        return !this.authReadyEvent.isSet();
    }

    get rateLimitUntil(): number {
        const until = Number(this.provider.storage.getItem('arlo_rate_limit_until'));
        return Number.isFinite(until) ? until : 0;
    }

    set rateLimitUntil(until: number) {
        this.provider.storage.setItem('arlo_rate_limit_until', String(until || 0));
    }

    get rateLimitDisableActive(): boolean {
        return this.provider.storage.getItem('arlo_rate_limit_disable_active') === 'true';
    }

    set rateLimitDisableActive(active: boolean) {
        this.provider.storage.setItem('arlo_rate_limit_disable_active', String(active));
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
            this.authReadyEvent.clear();
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
        if (!this.authReadyEvent.isSet())
            this.logger.debug(`Arlo auth transition ${this.authSucceeded ? 'succeeded' : 'ended'}: ${this.authReason || 'auth refresh'}`);
        this.authReason = '';
        this.authReadyEvent.set();
    }

    rateLimitRemaining(): number {
        return Math.max(0, this.rateLimitUntil - Date.now());
    }

    formatRemaining(ms: number): string {
        return this.rateLimit.formatRemaining(ms);
    }

    rateLimitResumeTime(): string {
        const date = new Date(this.rateLimitUntil);
        const pad = (n: number) => String(n).padStart(2, '0');
        const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
            .formatToParts(date).find(part => part.type === 'timeZoneName')?.value ?? '';
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
            + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`.trim();
    }

    handleRateLimitStartup(): boolean {
        const remaining = this.rateLimitRemaining();
        if (remaining > 0) {
            this.rateLimitDisableActive = true;
            this.provider.storage.setItem('disable_plugin', 'true');
            this.logger.warn(
                'Arlo plugin is disabled because Arlo/Cloudflare returned 429 Too Many Requests. '
                + `Waiting about ${this.formatRemaining(remaining)} before trying again after ${this.rateLimitResumeTime()}. `
                + 'No Arlo Cloud requests, relogin, or MFA will run during this pause.');
            this.provider.taskManager.createTask(signal => this.restartAfterRateLimitPause(signal), { tag: 'rate_limit_pause', owner: this.provider });
            return true;
        }
        if (this.rateLimitDisableActive) {
            this.logger.info('Arlo rate-limit pause has ended. Re-enabling plugin.');
            this.clearRateLimitPause();
            this.provider.storage.setItem('disable_plugin', 'false');
        }
        return false;
    }

    handleDisablePluginSetting(requestedDisable: boolean): boolean {
        const remaining = this.rateLimitRemaining();
        if (!requestedDisable && remaining > 0) {
            this.provider.storage.setItem('disable_plugin', 'true');
            this.rateLimitDisableActive = true;
            this.logger.warn(
                'Arlo plugin cannot be re-enabled yet because the Arlo/Cloudflare 429 pause '
                + `has about ${this.formatRemaining(remaining)} remaining. `
                + `The plugin can be re-enabled after ${this.rateLimitResumeTime()}.`);
            return false;
        }
        if (!requestedDisable && this.rateLimitDisableActive)
            this.clearRateLimitPause();
        this.provider.storage.setItem('disable_plugin', requestedDisable ? 'true' : 'false');
        this.logger.debug(`Arlo plugin will be ${requestedDisable ? 'disabled' : 'enabled'}. Restarting...`);
        return true;
    }

    clearRateLimitPause(): void {
        this.rateLimitUntil = 0;
        this.rateLimitDisableActive = false;
    }

    private async restartAfterRateLimitPause(signal: AbortSignal): Promise<void> {
        const remaining = this.rateLimitRemaining();
        if (remaining > 0)
            await sleep(remaining, signal);
        if (this.rateLimitRemaining() > 0) {
            this.restartPlugin();
            return;
        }
        this.clearRateLimitPause();
        this.provider.storage.setItem('disable_plugin', 'false');
        this.logger.info('Arlo rate-limit pause complete. Restarting plugin to resume Arlo Cloud.');
        this.restartPlugin();
    }

    beforeRequest(method: string, url: string, { suppressRestartOn401 = false }: { suppressRestartOn401?: boolean } = {}): void {
        if (this.rateLimitRemaining() > 0) {
            const remaining = this.logRateLimitWait(method, url);
            throw new RateLimitedError(
                `Arlo requests are paused for ${Math.floor(remaining / 1000)} seconds due to rate limiting.`,
                { statusCode: 429, retryAfter: remaining, method, url });
        }
        if (this.shouldDeferCloudRequest(url, suppressRestartOn401))
            throw new TransientRequestError('Arlo auth refresh is in progress; cloud request was deferred.', { method, url });
    }

    async waitForAuthReady(url = '', { timeout = 75_000, suppressRestartOn401 = false, signal }: { timeout?: number, suppressRestartOn401?: boolean, signal?: AbortSignal } = {}): Promise<void> {
        if (!this.shouldDeferCloudRequest(url, suppressRestartOn401))
            return;
        this.logger.debug(`Waiting for Arlo auth transition (${this.authReason || 'auth refresh'}) before cloud request: ${url}`);
        try {
            await withTimeout(this.authReadyEvent.wait(signal), timeout);
        }
        catch (e) {
            if (e instanceof TimeoutError)
                throw new TransientRequestError(`Arlo auth transition did not finish within ${timeout / 1000} seconds.`, { url });
            throw e;
        }
    }

    shouldDeferCloudRequest(url: string, suppressRestartOn401: boolean): boolean {
        if (suppressRestartOn401 || this.authReadyEvent.isSet())
            return false;
        return !ErrorManager.authFlowMarkers.some(marker => url.includes(marker));
    }

    handleHttpError(statusCode: number, method: string, url: string, requestStartedAt?: number, { suppressRestartOn401 = false }: { suppressRestartOn401?: boolean } = {}): Record<string, never> {
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

    raiseRequestError(statusCode: number | undefined, message: string, method: string, url: string, requestStartedAt?: number): never {
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
        if (this.authRecoveryTask && !this.authRecoveryTask.done) {
            this.logger.debug(`Session recovery already in progress. Latest reason: ${reason}`);
            return;
        }
        if (this.authTransitionActive) {
            this.logger.debug(`Ignoring a 401 during an Arlo auth transition (${this.authReason || 'auth refresh'}): ${reason}`);
            return;
        }
        this.authRecoveryTask = this.provider.taskManager.createTask(signal => this.recoverAuth(reason, signal), { tag: 'auth_recovery', owner: this.provider });
    }

    private activateRateLimit(source: string): number {
        const until = this.rateLimit.activate();
        this.rateLimitUntil = until;
        this.rateLimitDisableActive = true;
        this.provider.storage.setItem('disable_plugin', 'true');
        const remaining = until - Date.now();
        this.logger.warn(
            'Arlo/Cloudflare returned 429 Too Many Requests. '
            + `Disabling Arlo plugin for about ${this.formatRemaining(remaining)} until ${this.rateLimitResumeTime()}. `
            + 'No Arlo Cloud requests, relogin, or MFA will run during this pause.'
            + (source ? ` Source: ${source}` : ''));
        this.restartPlugin();
        return remaining;
    }

    private logRateLimitWait(method?: string, url?: string): number {
        const remaining = this.rateLimitRemaining();
        const target = method && url ? ` ${method} ${url}` : '';
        if (this.rateLimit.shouldLogWait()) {
            this.logger.warn(
                `Arlo Cloud requests are still paused for about ${this.formatRemaining(remaining)} after a 429 rate limit. `
                + `Skipping${target}; no network request was sent.`);
        }
        else {
            this.logger.debug(`Arlo request skipped during active rate limit pause (${Math.floor(remaining / 1000)} seconds remaining):${target}`);
        }
        return remaining;
    }

    private isStaleAuthError(requestStartedAt?: number): boolean {
        if (this.authTransitionActive && requestStartedAt && this.authStartedAt) {
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
