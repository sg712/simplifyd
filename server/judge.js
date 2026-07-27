// Runs user-submitted JavaScript against a problem's test cases in a separate
// node process with a hard timeout. This is process isolation, not a hardened
// security sandbox — don't expose this judge to hostile traffic without
// containerizing it (see README).
import { execFile } from 'node:child_process';

const TIMEOUT_MS = 4000;
const MAX_OUTPUT = 256 * 1024;

function buildHarness(functionName, tests) {
  return `
'use strict';
const __tests = ${JSON.stringify(tests)};
const __results = [];

function deepEqual(a, b) {
  if (a === b) return true; // note: treats -0 and 0 as equal, unlike Object.is
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// --- user code is spliced in below ---
USER_CODE_PLACEHOLDER

for (const t of __tests) {
  const entry = { pass: false };
  try {
    if (typeof ${JSON.stringify(functionName)} === 'undefined' || typeof ${functionName} !== 'function') {
      throw new Error('Function "${functionName}" is not defined. Keep the starter function name.');
    }
    const started = Date.now();
    const actual = ${functionName}(...structuredClone(t.args));
    entry.ms = Date.now() - started;
    entry.actual = actual === undefined ? null : actual;
    entry.pass = deepEqual(actual, t.expected);
  } catch (err) {
    entry.error = String(err && err.stack ? err.stack.split('\\n').slice(0, 4).join('\\n') : err);
  }
  __results.push(entry);
}
process.stdout.write('\\n__JUDGE_RESULT__' + JSON.stringify(__results));
`;
}

export function runTests(userCode, functionName, tests) {
  return new Promise((resolve) => {
    const harness = buildHarness(functionName, tests).replace(
      'USER_CODE_PLACEHOLDER',
      userCode
    );
    const child = execFile(
      process.execPath,
      ['--max-old-space-size=128', '-e', harness],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: {} },
      (err, stdout = '', stderr = '') => {
        const marker = stdout.lastIndexOf('__JUDGE_RESULT__');
        if (marker !== -1) {
          try {
            const results = JSON.parse(stdout.slice(marker + '__JUDGE_RESULT__'.length));
            return resolve({
              ok: true,
              results,
              logs: stdout.slice(0, marker).slice(0, 4000),
            });
          } catch {}
        }
        if (err && err.killed) {
          return resolve({
            ok: false,
            error: `Time limit exceeded (${TIMEOUT_MS / 1000}s). Look for an infinite loop or a slow algorithm.`,
          });
        }
        resolve({
          ok: false,
          error: (stderr || String(err || 'Unknown execution error')).slice(0, 2000),
        });
      }
    );
    child.on('error', () => resolve({ ok: false, error: 'Failed to start judge process' }));
  });
}
