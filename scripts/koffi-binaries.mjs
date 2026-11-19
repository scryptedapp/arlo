// Puts koffi's native binary packages in fs/koffi so they ship inside the
// plugin zip. Versions and checksums come from package-lock.json, so the
// binaries always match the koffi that impers resolved there, and the build
// stops if the koffi code it bundles from node_modules is another version.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const PLATFORMS = [
    'linux-x64',
    'linux-arm64',
    'darwin-x64',
    'darwin-arm64',
    'win32-x64',
    'win32-arm64',
];

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'fs', 'koffi', '@koromix');
// What each package in target was unpacked from, kept out of the zip.
const recordFile = path.join(root, 'node_modules', '.cache', 'koffi-binaries.json');
const lockPackages = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;

function lockEntry(name) {
    const key = Object.keys(lockPackages).find(k => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`));
    return key && lockPackages[key];
}

// The koffi webpack bundles: the one impers resolves.
function bundledKoffi() {
    const require = createRequire(path.join(root, 'package.json'));
    let dir = path.dirname(require.resolve('koffi', { paths: [path.dirname(require.resolve('impers'))] }));
    while (!fs.existsSync(path.join(dir, 'package.json')))
        dir = path.dirname(dir);
    return { dir, version: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version };
}

// Runs npm, the one running this script where there is one, so its proxy,
// registry and certificate settings apply.
function npm(args, options) {
    const cli = process.env.npm_execpath;
    if (cli?.endsWith('.js'))
        return execFileSync(process.execPath, [cli, ...args], options);
    return execFileSync('npm', args, { ...options, shell: process.platform === 'win32' });
}

const koffi = lockEntry('koffi');
if (!koffi)
    throw new Error('koffi is missing from package-lock.json; run npm install.');
const bundled = bundledKoffi();
if (bundled.version !== koffi.version)
    throw new Error(`node_modules has koffi ${bundled.version} but package-lock.json has ${koffi.version}; run npm ci.`);

let record = {};
try {
    record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
}
catch {
}

const wanted = new Set(PLATFORMS.map(p => `koffi-${p}`));
fs.mkdirSync(target, { recursive: true });
for (const dir of fs.readdirSync(target)) {
    if (!wanted.has(dir))
        fs.rmSync(path.join(target, dir), { recursive: true, force: true });
}

for (const platform of PLATFORMS) {
    const name = `@koromix/koffi-${platform}`;
    const entry = lockEntry(name);
    if (!entry)
        throw new Error(`${name} is missing from package-lock.json.`);
    if (entry.version !== koffi.version)
        throw new Error(`${name} ${entry.version} does not match koffi ${koffi.version} in package-lock.json.`);

    const dest = path.join(target, `koffi-${platform}`);
    if (record[name] === entry.integrity && fs.existsSync(dest))
        continue;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koffi-'));
    // Unpacked next to dest and moved into place whole, so an interrupted run
    // never leaves a partial package that looks complete.
    const staging = path.join(target, `.koffi-${platform}-${process.pid}`);
    try {
        const [packed] = JSON.parse(npm(['pack', `${name}@${entry.version}`, '--pack-destination', tmp, '--ignore-scripts', '--json'],
            { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
        const tarball = fs.readFileSync(path.join(tmp, packed.filename));

        const [algorithm, expected] = entry.integrity.split('-', 2);
        const actual = crypto.createHash(algorithm).update(tarball).digest('base64');
        if (actual !== expected)
            throw new Error(`${name} does not match its package-lock.json integrity.`);

        fs.mkdirSync(staging, { recursive: true });
        // From stdin, so no Windows path reaches tar, which some read as a
        // remote host.
        execFileSync('tar', ['-xzf', '-', '--strip-components=1'], { cwd: staging, input: tarball });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(staging, dest);
    }
    finally {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    record[name] = entry.integrity;
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.writeFileSync(recordFile, JSON.stringify(record, undefined, 2) + '\n');
    console.log(`${name} ${entry.version}`);
}

// The binary packages carry no license text; koffi's covers them.
fs.copyFileSync(path.join(bundled.dir, 'LICENSE.txt'), path.join(root, 'fs', 'koffi', 'LICENSE.txt'));
