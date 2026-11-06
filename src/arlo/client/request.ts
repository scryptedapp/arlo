import fs from 'node:fs';
import path from 'node:path';

type Impers = typeof import('impers');

interface Log {
    info(message: string): void;
    warn(message: string): void;
}

let impers: Promise<Impers> | undefined;

// impers finds or downloads libcurl-impersonate when it is first imported, so
// the cache must point into the plugin volume before that. It survives
// container updates there, and the download follows the libcurl-impersonate
// release that impers pins.
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

// Logs which libcurl was loaded and removes cached libcurl-impersonate
// releases that the bundled impers no longer uses.
export async function initImpers(log: Log): Promise<void> {
    const { Curl, resolveLibrary } = await loadImpers();
    const library = await resolveLibrary();
    log.info(`Using ${Curl.version()} from ${library.path}`);
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
    const current = relative.split(path.sep)[0];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== current) {
            fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
            log.info(`Removed unused libcurl-impersonate ${entry.name}.`);
        }
    }
}
