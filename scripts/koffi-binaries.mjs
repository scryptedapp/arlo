// Puts koffi's native binary packages in fs/koffi so they ship inside the
// plugin zip. Versions, download URLs and checksums come from
// package-lock.json, so the binaries always match the koffi that impers
// resolved there.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const lockPackages = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;

function lockEntry(name) {
    const key = Object.keys(lockPackages).find(k => k === `node_modules/${name}` || k.endsWith(`/node_modules/${name}`));
    return key && lockPackages[key];
}

const koffi = lockEntry('koffi');
if (!koffi)
    throw new Error('koffi is missing from package-lock.json; run npm install.');

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
    const installed = path.join(dest, 'package.json');
    if (fs.existsSync(installed) && JSON.parse(fs.readFileSync(installed, 'utf8')).version === entry.version)
        continue;

    const response = await fetch(entry.resolved);
    if (!response.ok)
        throw new Error(`Downloading ${name} failed: HTTP ${response.status}.`);
    const tarball = Buffer.from(await response.arrayBuffer());

    const [algorithm, expected] = entry.integrity.split('-', 2);
    const actual = crypto.createHash(algorithm).update(tarball).digest('base64');
    if (actual !== expected)
        throw new Error(`${name} does not match its package-lock.json integrity.`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koffi-'));
    try {
        const file = path.join(tmp, 'package.tgz');
        fs.writeFileSync(file, tarball);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });
        execFileSync('tar', ['-xzf', file, '-C', dest, '--strip-components=1']);
    }
    finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`${name} ${entry.version}`);
}
