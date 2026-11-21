// koffi is not bundled: Scrypted installs it on the server from the version
// package.json pins under optionalDependencies. That must be the koffi impers
// is built and tested with here, the one impers resolves in node_modules.
//
//   node scripts/koffi-version.mjs --check    fail unless the pin is that version
//   node scripts/koffi-version.mjs --update   pin the newest koffi impers accepts (npm run update-impers runs this)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The koffi impers resolves, found from impers' own folder.
function koffiForImpers() {
    let dir = path.dirname(require.resolve('koffi', { paths: [path.dirname(require.resolve('impers'))] }));
    while (!fs.existsSync(path.join(dir, 'package.json')))
        dir = path.dirname(dir);
    return readJson(path.join(dir, 'package.json')).version;
}

// Runs npm, the one running this script where there is one.
function npm(args) {
    const cli = process.env.npm_execpath;
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
    if (cli?.endsWith('.js'))
        return execFileSync(process.execPath, [cli, ...args], options);
    return execFileSync('npm', args, { ...options, shell: process.platform === 'win32' });
}

const mode = process.argv[2];
const pinned = readJson(path.join(root, 'package.json')).optionalDependencies?.koffi;

if (mode === '--check') {
    const used = koffiForImpers();
    if (pinned !== used)
        throw new Error(`impers uses koffi ${used} here, but package.json pins ${pinned ?? 'none'} under optionalDependencies, which Scrypted installs; run node scripts/koffi-version.mjs --update.`);
}
else if (mode === '--update') {
    const range = readJson(path.join(path.dirname(require.resolve('impers')), '..', 'package.json')).dependencies.koffi;
    const versions = [].concat(JSON.parse(npm(['view', `koffi@${range}`, 'version', '--json'])));
    const newest = versions.at(-1);
    if (newest !== pinned)
        npm(['install', `koffi@${newest}`, '--save-optional', '--save-exact']);
    console.log(`koffi ${newest} (impers accepts ${range})`);
}
else {
    throw new Error('Use --check or --update.');
}
