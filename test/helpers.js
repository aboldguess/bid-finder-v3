import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR ??= fs.mkdtempSync(path.join(import.meta.dirname, '..', 'node_modules', '.test-data-'));

export const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

process.env.LOG_LEVEL ??= 'error';
// Tests fill in forms instantly; the bot check's timer is tested on its own.
process.env.SIGNUP_MIN_SECONDS ??= '0';
