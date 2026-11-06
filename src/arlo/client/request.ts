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
    const [release, platform] = relative.split(path.sep);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== release) {
            fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
            log.info(`Removed unused libcurl-impersonate ${entry.name}.`);
        }
    }
    const freed = trim(path.join(dir, release, platform));
    if (freed)
        log.info(`Removed ${(freed / 1e6).toFixed(1)} MB of libcurl-impersonate ${release} files not needed at runtime.`);
}
