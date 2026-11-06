import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { extraDebug, Logger } from '../logging';
import {
    BadRequestError,
    CancelledError,
    ErrorManager,
    InvalidResponseError,
    RateLimitedError,
    sleep,
    TransientRequestError,
    UnauthorizedError,
} from '../util';

type Impers = typeof import('impers');
type Session = InstanceType<Impers['Session']>;
type Response = InstanceType<Impers['Response']>;

interface Log {
    debug(message: string): void;
    warn(message: string): void;
}

let impers: Promise<Impers> | undefined;

// impers finds or downloads libcurl-impersonate when it is first imported, so
// the cache must point into the plugin volume before that. It survives
// container updates there. impers keeps one folder per libcurl-impersonate
// release it pins, so a newer impers with a newer pin downloads that release.
function cacheDir(): string | undefined {
    const volume = process.env.SCRYPTED_PLUGIN_VOLUME;
    return volume && path.join(volume, 'impers-cache');
}

export function loadImpers(): Promise<Impers> {
    if (!impers) {
        const dir = cacheDir();
        if (dir)
            process.env.IMPER_CACHE_DIR = dir;
        impers = import('impers');
    }
    return impers;
}

// The release archive also carries static and import libraries, headers,
// pkg-config files and a build probe, none of which loading the shared library
// needs. The license files stay.
function unneeded(name: string, isDirectory: boolean): boolean {
    if (isDirectory)
        return name === 'include';
    return /\.(a|lib|pc)$/.test(name) || name.includes('runtime-probe');
}

function size(file: string): number {
    const stat = fs.lstatSync(file);
    if (!stat.isDirectory())
        return stat.size;
    return fs.readdirSync(file).reduce((total, name) => total + size(path.join(file, name)), 0);
}

// Deletes unneeded files under dir, and folders left empty, returning the
// bytes freed.
function trim(dir: string): number {
    let freed = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (unneeded(entry.name, entry.isDirectory())) {
            freed += size(file);
            fs.rmSync(file, { recursive: true, force: true });
        }
        else if (entry.isDirectory()) {
            freed += trim(file);
            if (!fs.readdirSync(file).length)
                fs.rmdirSync(file);
        }
    }
    return freed;
}

// Logs which libcurl was loaded, removes cached libcurl-impersonate releases
// the bundled impers no longer uses, and trims the one in use.
export async function initImpers(log: Log): Promise<void> {
    const { Curl, resolveLibrary } = await loadImpers();
    const library = await resolveLibrary();
    log.debug(`Using ${Curl.version()} from ${library.path}`);
    if (!library.isImpersonate) {
        log.warn('libcurl-impersonate is not loaded; Arlo requests will not look like a browser.');
        return;
    }
    const dir = cacheDir();
    if (!dir)
        return;
    const relative = path.relative(dir, library.path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        log.warn('Using a libcurl-impersonate installed on this system instead of the release impers pins.');
        return;
    }
    const [release, platform] = relative.split(path.sep);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== release) {
            fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
            log.debug(`Removed unused libcurl-impersonate ${entry.name}.`);
        }
    }
    const freed = trim(path.join(dir, release, platform));
    if (freed)
        log.debug(`Removed ${(freed / 1e6).toFixed(1)} MB of libcurl-impersonate ${release} files not needed at runtime.`);
}

export type Params = Record<string, unknown>;

export interface RequestOptions {
    params?: Params;
    headers?: Record<string, string>;
    // Return the whole JSON body, without checking it reports success.
    raw?: boolean;
    // Leave out the eventId and time query parameters the Arlo web app adds.
    skipEventId?: boolean;
    // Treat a 401 as an empty result instead of starting session recovery,
    // for logout and other cleanup.
    suppressRestartOn401?: boolean;
    signal?: AbortSignal;
}

const TIMEOUT = 10;
const MAX_ATTEMPTS = 3;

function addQueryParams(url: string, params: Params): string {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(params))
        parsed.searchParams.set(key, String(value));
    return parsed.toString();
}

function isSuccess(body: any): boolean {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return false;
    if (body.meta && Object.keys(body.meta).length)
        return body.meta.code === 200;
    return body.success === true;
}

// Arlo Cloud requests through an impers session that impersonates Chrome.
// Failed requests are sorted by the ErrorManager; temporary failures are
// retried up to three times, waiting 1 and then 2 seconds.
export class Request {
    private constructor(
        private readonly impers: Impers,
        private readonly session: Session,
        private readonly errorManager: ErrorManager,
        private readonly logger: Logger) {
    }

    static async create(errorManager: ErrorManager, logger: Logger): Promise<Request> {
        const impers = await loadImpers();
        logger.debug('Impersonating Chrome');
        return new Request(impers, new impers.Session({ impersonate: 'chrome' }), errorManager, logger);
    }

    get(url: string, options?: RequestOptions): Promise<any> {
        return this.request('GET', url, options);
    }

    options(url: string, options?: RequestOptions): Promise<any> {
        return this.request('OPTIONS', url, options);
    }

    post(url: string, options?: RequestOptions): Promise<any> {
        return this.request('POST', url, options);
    }

    put(url: string, options?: RequestOptions): Promise<any> {
        return this.request('PUT', url, options);
    }

    // Headers sent with every request, such as the session's Authorization.
    setHeaders(headers: Record<string, string>): void {
        for (const [name, value] of Object.entries(headers))
            this.session.headers.set(name, value);
    }

    dumpCookies(): string {
        return JSON.stringify(this.session.cookies.toObject());
    }

    loadCookies(cookies: string): void {
        this.session.cookies.update(JSON.parse(cookies));
    }

    async close(): Promise<void> {
        await this.session.close();
    }

    private async request(method: string, url: string, options: RequestOptions = {}): Promise<any> {
        const { params = {}, headers = {}, raw = false, skipEventId = false, suppressRestartOn401 = false, signal } = options;
        await this.errorManager.waitForAuthReady(url, { suppressRestartOn401, signal });
        const startedAt = Date.now();
        if (!skipEventId)
            url = addQueryParams(url, { eventId: `FE!${crypto.randomUUID()}`, time: Date.now() });
        if (extraDebug())
            this.logger.debug(`HTTP ${method} ${url} params=${JSON.stringify(params)} headers=${JSON.stringify(headers)}`);

        for (let attempt = 1; ; attempt++) {
            const retry = attempt < MAX_ATTEMPTS;
            const backoff = 2 ** (attempt - 1) * 1000;
            try {
                this.errorManager.beforeRequest(method, url, { suppressRestartOn401 });
                const response = await this.session.request(method, url, {
                    params: method === 'GET' ? params as Record<string, string> : undefined,
                    json: method === 'POST' || method === 'PUT' ? params : undefined,
                    headers,
                    timeout: TIMEOUT,
                    signal,
                });
                return this.handleResponse(response, method, url, raw, startedAt, suppressRestartOn401);
            }
            catch (e) {
                if (signal?.aborted || e instanceof this.impers.AbortError)
                    throw new CancelledError();
                if (e instanceof UnauthorizedError || e instanceof RateLimitedError || e instanceof BadRequestError || e instanceof InvalidResponseError)
                    throw e;
                let error = e;
                if (e instanceof this.impers.RequestException)
                    error = new TransientRequestError(`Network error for ${method} ${url}: ${e.message}`, { method, url });
                if (!(error instanceof TransientRequestError))
                    throw error;
                if (!retry)
                    throw error;
                this.logger.warn(`Temporary HTTP error ${method} ${url}: ${error.message}. Backoff ${backoff / 1000}s.`);
                await sleep(backoff, signal);
            }
        }
    }

    private handleResponse(response: Response, method: string, url: string, raw: boolean, startedAt: number, suppressRestartOn401: boolean): any {
        const status = response.statusCode;
        if (status < 200 || status >= 300)
            return this.errorManager.handleHttpError(status, method, url, startedAt, { suppressRestartOn401 });
        if (method === 'OPTIONS') {
            this.errorManager.markHttpSuccess();
            return {};
        }
        let body: any;
        try {
            body = response.json();
        }
        catch (e) {
            this.logger.error(`Invalid JSON from ${url}: ${e}`);
            throw new InvalidResponseError(`Invalid JSON response from ${url}`, { method, url });
        }
        if (extraDebug())
            this.logger.debug(`Response ${method} ${url}: ${JSON.stringify(body)}`);
        if (raw) {
            this.errorManager.markHttpSuccess();
            return body;
        }
        if (isSuccess(body)) {
            this.errorManager.markHttpSuccess();
            return 'data' in body ? body.data : body;
        }
        this.errorManager.raiseBodyError(body, method, url, startedAt);
    }
}
