// Runs scrypted-webpack with NODE_ENV=production, for publishing. A package.json
// script cannot set it on Windows, whose shell does not take VAR=value
// before a command.
import { execSync } from 'node:child_process';

execSync('scrypted-webpack', { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
