// SQLite access. One synchronous connection per process (better-sqlite3),
// which suits a single Raspberry Pi and keeps queries simple.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrate } from './migrations.js';

const schema = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');

export function openDb(file = config.dbFile) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schema);
  migrate(db);
  // Gathers the statistics SQLite's planner needs to pick the right index
  // (for example first-seen time for alerts). Cheap: only re-analyses tables that changed a lot.
  db.pragma('optimize=0x10002');
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`).get()) db.exec('ANALYZE');
  return db;
}

let shared;
export function getDb() {
  shared ??= openDb();
  return shared;
}

// Lets tests swap in an in-memory database.
export function setDb(db) {
  shared = db;
}
