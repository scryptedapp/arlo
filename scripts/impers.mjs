// Keeps impers' two native parts, which the plugin does not bundle, matched
// to the impers that is:
// - koffi, which Scrypted installs on the server, at the version package.json
//   pins under optionalDependencies. It must be the koffi impers uses here.
// - libcurl-impersonate, which impers downloads from GitHub when the plugin
//   first starts. The plugin loads it only if its SHA-256 matches the one in
//   src/arlo/client/libcurl-sha256.json for the platform. Each platform's hash
//   is taken by running impers' own loader as if on that platform, so it is of
//   the file impers picks and unpacks there.
//
//   node scripts/impers.mjs           record the hashes (npm run update-impers runs this)
//   node scripts/impers.mjs --check   fail unless the koffi pin and the hashes match (the builds run this)

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGETS = [
    ['linux', 'x64', 'gnu'],
    ['linux', 'x64', 'musl'],
    ['linux', 'arm64', 'gnu'],
    ['linux', 'arm64', 'musl'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
];

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'src', 'arlo', 'client', 'libcurl-sha256.json');
const require = createRequire(path.join(root, 'package.json'));
const loaderUrl = pathToFileURL(path.join(path.dirname(require.resolve('impers')), 'ffi', 'loader.js')).href;

const [mode, ...args] = process.argv.slice(2);

if (mode === '--target') {
    // A child process standing in for one platform.
    const [platform, arch, libc, cache] = args;
    Object.defineProperty(process, 'platform', { value: platform });
    Object.defineProperty(process, 'arch', { value: arch });
    if (platform === 'linux') {
        const header = libc === 'gnu' ? { glibcVersionRuntime: '2.36' } : {};
        Object.defineProperty(process, 'report', { value: { getReport: () => ({ header }) } });
    }
    for (const name of ['LIBCURL_IMPERSONATE_PATH', 'LIBCURL_PATH', 'IMPER_DOWNLOAD_LIBCURL', 'IMPER_LIBCURL_RELEASE_URL'])
        delete process.env[name];
    process.env.IMPER_CACHE_DIR = cache;
    const { resolveLibrary } = await import(loaderUrl);
    const library = await resolveLibrary();
    const relative = path.relative(cache, library.path);
    if (!library.isImpersonate || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error(`impers did not download a library for ${platform}-${arch}; it chose ${library.path}`);
    const file = fs.realpathSync(library.path);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    process.stdout.write(JSON.stringify({ file: path.relative(cache, file), sha256 }));
    process.exit(0);
}

const { LIBCURL_IMPERSONATE_VERSION: release } = await import(loaderUrl);

if (mode === '--check') {
    // The koffi impers resolves from its own folder.
    let dir = path.dirname(require.resolve('koffi', { paths: [path.dirname(require.resolve('impers'))] }));
    while (!fs.existsSync(path.join(dir, 'package.json')))
        dir = path.dirname(dir);
    const used = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).optionalDependencies?.koffi;
    if (pinned !== used)
        throw new Error(`impers uses koffi ${used} here, but package.json pins ${pinned ?? 'none'} under optionalDependencies, which Scrypted installs; pin the koffi impers needs.`);
    let recorded;
    try {
        recorded = JSON.parse(fs.readFileSync(output, 'utf8')).release;
    }
    catch {
    }
    if (recorded !== release)
        throw new Error(`${path.relative(root, output)} has hashes for libcurl-impersonate ${recorded ?? '(none)'}, but impers pins ${release}; run node scripts/impers.mjs.`);
    process.exit(0);
}

// Runs one target and returns its result as soon as it is printed. A child
// now and then stays alive after printing it, so it is then ended.
function runTarget(platform, arch, libc, cache) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [import.meta.filename, '--target', platform, arch, libc ?? '', cache], { stdio: ['ignore', 'pipe', 'inherit'] });
        let output = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${platform}-${arch} took over 3 minutes`));
        }, 180_000);
        child.stdout.on('data', data => {
            output += data;
            try {
                const result = JSON.parse(output);
                clearTimeout(timer);
                child.kill('SIGKILL');
                resolve(result);
            }
            catch {
            }
        });
        child.on('exit', code => {
            clearTimeout(timer);
            reject(new Error(`${platform}-${arch} ended (code ${code}) without a result`));
        });
    });
}

const files = {};
for (const [platform, arch, libc] of TARGETS) {
    const key = [platform, arch, libc].filter(Boolean).join('-');
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'impers-libcurl-'));
    try {
        const result = await runTarget(platform, arch, libc, cache);
        files[key] = result.sha256;
        console.log(`${key} ${result.file} ${result.sha256}`);
    }
    finally {
        fs.rmSync(cache, { recursive: true, force: true });
    }
}
fs.writeFileSync(output, JSON.stringify({ release, files }, undefined, 4) + '\n');
console.log(`Wrote ${path.relative(root, output)} for libcurl-impersonate ${release}.`);
