// Tiny JSON-file persistence layer. Good enough for a single-process app;
// swap for a real database if this ever needs to scale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

const EMPTY = { users: {}, sessions: {} };

let db;
try {
  db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
} catch {
  db = structuredClone(EMPTY);
}
db.users ??= {};
db.sessions ??= {};

let saveTimer = null;
export function save() {
  // Debounce writes so bursts of updates hit disk once.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_PATH);
  }, 50);
}

export function getDb() {
  return db;
}
