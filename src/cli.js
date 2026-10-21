// Command-line jobs: `npm run ingest [-- <source-key>]` and `npm run digest`.
import { getDb } from './db/index.js';
import { runAll } from './ingest/run.js';
import { runDigests } from './notify/digest.js';

const [command, arg] = process.argv.slice(2);
const db = getDb();

if (command === 'ingest') {
  console.table(await runAll(db, { only: arg }));
} else if (command === 'digest') {
  console.table(await runDigests(db));
} else {
  console.log('Usage: node src/cli.js ingest [source-key] | digest');
  process.exitCode = 1;
}
