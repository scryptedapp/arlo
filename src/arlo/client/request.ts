import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { extraDebug, Logger } from '../logging';
import type { ArloProvider } from '../provider';
import LIBCURL_SHA256 from './libcurl-sha256.json';
import { CancelledError, ErrorManager, InvalidResponseError, sleep, TransientRequestError } from '../util';

type Impers = typeof import('impers');
type Session = InstanceType<Impers['Session']>;

let impersLoad: Promise<Impers> | undefined;
let checkedImpersLoad: Promise<Impers> | undefined;

export const BROWSER = {
    target: 'chrome152_macos',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
};

const NOT_LOADED = 'libcurl-impersonate is not loaded, so the plugin sends no requests to Arlo Cloud: '
    + 'without it they do not look like a browser, and Cloudflare blocks them. '
    + 'On its first start the plugin downloads it from GitHub (api.github.com and its release downloads); '
    + 'once the Scrypted server can reach them, restart the plugin.';

function impersCacheDir(): string | undefined {
    const volume = process.env.SCRYPTED_PLUGIN_VOLUME;
    return volume && path.join(volume, 'impers-cache');
}

export function loadImpers(): Promise<Impers> {
    if (!impersLoad) {
        const dir = impersCacheDir();
        if (dir)
            process.env.IMPER_CACHE_DIR = dir;
        impersLoad = checkDownloadedLibrary().then(() => import('impers'));
    }
    return impersLoad;
}

async function checkDownloadedLibrary(): Promise<void> {
    const dir = impersCacheDir();
    if (!dir)
        return;
    const { LIBCURL_IMPERSONATE_VERSION: release, resolveLibrary } = await import('impers-loader');
    const library = await resolveLibrary();
    const relative = path.relative(dir, library.path);
    if (!library.isImpersonate || relative.startsWith('..') || path.isAbsolute(relative))
        return;
    const platform = `${process.platform}-${process.arch}`;
    const expected = LIBCURL_SHA256.release !== release ? [] : Object.entries(LIBCURL_SHA256.files)
        .filter(([key]) => key === platform || key.startsWith(`${platform}-`))
        .map(([, sha256]) => sha256);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(fs.realpathSync(library.path))).digest('hex');
    if (expected.includes(actual))
        return;
    fs.rmSync(path.join(dir, release), { recursive: true, force: true });
    throw new Error(`The libcurl-impersonate ${release} downloaded from GitHub does not match its recorded SHA-256, `
        + 'so it was deleted and not loaded, and the plugin sends no requests to Arlo Cloud.');
}

function loadCheckedImpers(): Promise<Impers> {
    checkedImpersLoad ??= (async () => {
        const loaded = await loadImpers();
        const library = await loaded.resolveLibrary();
        if (!library.isImpersonate || !loaded.Curl.hasImpersonateSupport())
            throw new Error(NOT_LOADED);
        const probe = new loaded.Curl();
        try {
            probe.impersonate(BROWSER.target);
        }
        catch (e) {
            throw new Error(`The libcurl-impersonate at ${library.path} cannot impersonate ${BROWSER.target}, so the plugin sends no requests to Arlo Cloud: ${e}`);
        }
        finally {
            probe.cleanup();
        }
        return loaded;
    })();
    return checkedImpersLoad;
}

function trimRelease(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        const unneeded = entry.isDirectory()
            ? entry.name === 'include'
            : /\.(a|lib|pc)$/.test(entry.name) || entry.name.includes('runtime-probe');
        if (unneeded) {
            fs.rmSync(file, { recursive: true, force: true });
        }
        else if (entry.isDirectory()) {
            trimRelease(file);
            if (!fs.readdirSync(file).length)
                fs.rmdirSync(file);
        }
    }
}
export async function initImpers(logger: Logger): Promise<void> {
    const { Curl, resolveLibrary } = await loadImpers();
    const library = await resolveLibrary();
    logger.debug(`Using ${Curl.version()} from ${library.path}`);
    if (!library.isImpersonate) {
        logger.error(NOT_LOADED);
        return;
    }
    const dir = impersCacheDir();
    if (!dir)
        return;
    const relative = path.relative(dir, library.path);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        logger.warn('Using a libcurl-impersonate installed on this system instead of the release impers pins.');
        return;
    }
    const [release, platform] = relative.split(path.sep);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== release) {
            fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
            logger.debug(`Removed unused libcurl-impersonate ${entry.name}.`);
        }
    }
    trimRelease(path.join(dir, release, platform));
}

export interface RequestOptions {
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
    raw?: boolean;
    skipEventId?: boolean;
    suppressRestartOn401?: boolean;
    signal?: AbortSignal;
}

export class Request {
    errorManager: ErrorManager;
    timeout = 10;
    maxRetries = 3;
    session: Session;

    private constructor(private impers: Impers, public provider: ArloProvider, private logger: Logger) {
        this.errorManager = provider.errorManager;
        this.session = this.initializeSession();
    }

    static async create(provider: ArloProvider, logger: Logger): Promise<Request> {
        return new Request(await loadCheckedImpers(), provider, logger);
    }

    private initializeSession(): Session {
        this.logger.debug(`Impersonating ${BROWSER.target}`);
        return new this.impers.Session({ impersonate: BROWSER.target });
    }

    async renew(): Promise<void> {
        const previous = this.session;
        this.session = this.initializeSession();
        await previous.close().catch(() => { });
    }

    genEventId(): string {
        return `FE!${crypto.randomUUID()}`;
    }

    getTime(): number {
        return Date.now();
    }

    private addQueryParams(url: string, params: Record<string, unknown>): string {
        const parsed = new URL(url);
        for (const [key, value] of Object.entries(params))
            parsed.searchParams.set(key, String(value));
        return parsed.toString();
    }

    private isSuccess(body: any): boolean {
        if (!body || typeof body !== 'object' || Array.isArray(body))
            return false;
        if (body.meta && Object.keys(body.meta).length)
            return body.meta.code === 200;
        return body.success === true;
    }

    private async request(method: string, url: string, options: RequestOptions = {}): Promise<any> {
        const { params = {}, headers = {}, raw = false, skipEventId = false, suppressRestartOn401 = false, signal } = options;
        await this.errorManager.waitForAuthReady(url, { suppressRestartOn401, signal });
        const requestStartedAt = Date.now();
        if (!skipEventId)
            url = this.addQueryParams(url, { eventId: this.genEventId(), time: this.getTime() });
        if (extraDebug())
            this.logger.debug(`HTTP ${method} ${url} params=${JSON.stringify(params)} headers=${JSON.stringify(headers)}`);

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            const backoff = 2 ** attempt;
            try {
                this.errorManager.beforeRequest(method, url, { suppressRestartOn401 });
                const response = await this.session.request(method, url, {
                    params: method === 'GET' ? params as Record<string, string> : undefined,
                    json: method === 'POST' || method === 'PUT' ? params : undefined,
                    headers,
                    timeout: this.timeout,
                    signal,
                });
                const statusCode = response.statusCode;
                if (statusCode < 200 || statusCode >= 300)
                    return this.errorManager.handleHttpError(statusCode, method, url, requestStartedAt, { suppressRestartOn401 });
                if (method === 'OPTIONS') {
                    this.errorManager.markHttpSuccess();
                    return {};
                }
                let body: any;
                try {
                    body = response.json();
                    if (extraDebug())
                        this.logger.debug(`Response ${method} ${url}: ${JSON.stringify(body)}`);
                }
                catch (e) {
                    this.logger.error(`Invalid JSON from ${url}: ${e}`);
                    throw new InvalidResponseError(`Invalid JSON response from ${url}`, { method, url });
                }
                if (raw) {
                    this.errorManager.markHttpSuccess();
                    return body;
                }
                if (this.isSuccess(body)) {
                    this.errorManager.markHttpSuccess();
                    return 'data' in body ? body.data : body;
                }
                this.errorManager.raiseBodyError(body, method, url, requestStartedAt);
            }
            catch (e) {
                if (signal?.aborted || e instanceof this.impers.AbortError)
                    throw new CancelledError();
                if (e instanceof TransientRequestError) {
                    if (attempt < this.maxRetries - 1) {
                        this.logger.warn(`Temporary HTTP error ${method} ${url}: ${e.message}. Backoff ${backoff}s.`);
                        await sleep(backoff * 1000, signal);
                        continue;
                    }
                    throw e;
                }
                if (e instanceof this.impers.RequestException) {
                    if (attempt < this.maxRetries - 1) {
                        this.logger.warn(`Network error ${method} ${url}: ${e.message}. Backoff ${backoff}s.`);
                        await sleep(backoff * 1000, signal);
                        continue;
                    }
                    throw new TransientRequestError(`Network error for ${method} ${url}: ${e.message}`, { method, url });
                }
                throw e;
            }
        }
        throw new TransientRequestError(`Failed after ${this.maxRetries} attempts for ${method} ${url}`);
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

    dumpsCookies(): string {
        return JSON.stringify(this.session.cookies.toObject());
    }

    loadsCookies(cookies: string): void {
        this.session.cookies.update(JSON.parse(cookies));
    }

    async close(): Promise<void> {
        await this.session.close();
    }
}
