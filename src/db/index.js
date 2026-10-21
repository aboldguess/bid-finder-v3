// SQLite access. One synchronous connection per process (better-sqlite3),
// which suits a single Raspberry Pi and keeps queries simple.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const schema = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');

export function openDb(file = config.dbFile) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
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
