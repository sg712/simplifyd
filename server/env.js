// Loads a .env file so you don't have to `export ANTHROPIC_API_KEY=...` in
// every new terminal. Zero-dependency; real environment variables always win.
//
// Imported for its side effect, and it must run before anything reads
// process.env — keep it first in the import list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    // Strip matching quotes; leave inner content alone.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnv() {
  const file = path.join(ROOT, '.env');
  let parsed = {};
  try {
    parsed = parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { loaded: false, keys: [] };
  }
  const keys = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      keys.push(k);
    }
  }
  return { loaded: true, keys };
}

loadEnv();
