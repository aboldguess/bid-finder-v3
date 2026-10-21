import fs from 'node:fs';
import path from 'node:path';

process.env.DATA_DIR ??= fs.mkdtempSync(path.join(import.meta.dirname, '..', 'node_modules', '.test-data-'));

export const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
