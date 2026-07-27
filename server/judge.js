// Runs user-submitted code against a problem's tests, in a scratch directory,
// in a child process with a hard timeout.
//
// This is process isolation, not a hardened security sandbox — fine for a demo
// or a trusted group. For hostile traffic, run it inside a locked-down
// container with no network and a read-only filesystem (see README).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LANGUAGES, isAvailable } from './languages.js';

const RUN_TIMEOUT_MS = 6000;
const COMPILE_TIMEOUT_MS = 20000;
const MAX_OUTPUT = 512 * 1024;

function exec(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, opts, (err, stdout = '', stderr = '') => {
      resolve({ err, stdout, stderr });
    });
    child.on('error', (err) => resolve({ err, stdout: '', stderr: String(err) }));
  });
}

// Harness output: one `__DC__<i>|<STATUS>|<base64>` line per completed test.
// Tests missing from the output crashed the process (segfault, OOM, timeout).
function parseResults(stdout, testCount) {
  const results = Array.from({ length: testCount }, () => null);
  for (const line of stdout.split('\n')) {
    const m = /^__DC__(\d+)\|(PASS|FAIL|ERR)\|(.*)$/.exec(line.trim());
    if (!m) continue;
    const idx = Number(m[1]);
    if (idx < 0 || idx >= testCount) continue;
    let payload = '';
    try {
      payload = Buffer.from(m[3], 'base64').toString('utf8');
    } catch {}
    results[idx] =
      m[2] === 'ERR'
        ? { pass: false, error: payload.slice(0, 600) }
        : { pass: m[2] === 'PASS', actual: payload.slice(0, 400) };
  }
  return results;
}

function stripLogs(stdout) {
  return stdout
    .split('\n')
    .filter((l) => !l.startsWith('__DC__'))
    .join('\n')
    .trim()
    .slice(0, 4000);
}

// Drill mode: the user writes a complete little program and we compare what it
// prints. No harness — their file *is* the program.
export async function runProgram(userCode, langId) {
  const lang = LANGUAGES[langId];
  if (!lang) return { ok: false, error: `Unknown language: ${langId}` };
  if (!isAvailable(langId)) {
    return { ok: false, error: `${lang.label} isn't available on this server.` };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dailycode-drill-'));
  try {
    await fs.writeFile(path.join(dir, lang.file), userCode);

    if (lang.compile) {
      const [cmd, args] = lang.compile();
      const { err, stderr } = await exec(cmd, args, {
        cwd: dir,
        timeout: COMPILE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
      });
      if (err) {
        return {
          ok: false,
          phase: 'compile',
          error: err.killed ? 'Compilation timed out.' : cleanCompileError(stderr, lang.id),
        };
      }
    }

    const [runCmd, runArgs] = lang.run();
    const { err, stdout, stderr } = await exec(runCmd, runArgs, {
      cwd: dir,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      env: { PATH: process.env.PATH, HOME: dir },
    });

    if (err && err.killed) {
      return {
        ok: false,
        phase: 'run',
        error: `Time limit exceeded (${RUN_TIMEOUT_MS / 1000}s). Is there a loop that never ends?`,
      };
    }
    if (err) {
      return {
        ok: false,
        phase: 'run',
        error: (stderr || String(err)).slice(0, 1500),
        stdout: stdout.slice(0, 4000),
      };
    }
    return { ok: true, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 1000) };
  } catch (err) {
    return { ok: false, error: `Judge error: ${err.message}` };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Compare printed output leniently on whitespace but strictly on content.
export function normalizeOutput(s) {
  return String(s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export async function runTests(userCode, problem, tests, langId) {
  const lang = LANGUAGES[langId];
  if (!lang) return { ok: false, error: `Unknown language: ${langId}` };
  if (!isAvailable(langId)) {
    return { ok: false, error: `${lang.label} isn't available on this server.` };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dailycode-'));
  try {
    await fs.writeFile(path.join(dir, lang.file), lang.harness(problem, userCode, tests));

    if (lang.compile) {
      const [cmd, args] = lang.compile();
      const { err, stderr } = await exec(cmd, args, {
        cwd: dir,
        timeout: COMPILE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
      });
      if (err) {
        const message = err.killed
          ? 'Compilation timed out.'
          : cleanCompileError(stderr, lang.id);
        return { ok: false, error: message, phase: 'compile' };
      }
    }

    const [runCmd, runArgs] = lang.run();
    const { err, stdout, stderr } = await exec(runCmd, runArgs, {
      cwd: dir,
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      env: { PATH: process.env.PATH, HOME: dir },
    });

    const parsed = parseResults(stdout, tests.length);
    const completed = parsed.filter(Boolean).length;

    if (err && err.killed && completed < tests.length) {
      return {
        ok: false,
        error: `Time limit exceeded (${RUN_TIMEOUT_MS / 1000}s) on test ${completed + 1}. Look for an infinite loop or an algorithm that's too slow.`,
        phase: 'run',
      };
    }
    if (completed === 0) {
      return {
        ok: false,
        error: (stderr || String(err || 'Your program produced no results.')).slice(0, 1500),
        phase: 'run',
      };
    }

    // Fill any gap left by a mid-run crash (segfault, OOM) as a failure.
    const results = parsed.map(
      (r) => r || { pass: false, error: 'Program crashed before this test finished.' }
    );
    return { ok: true, results, logs: stripLogs(stdout) };
  } catch (err) {
    return { ok: false, error: `Judge error: ${err.message}` };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Compiler errors reference our generated harness; trim it to the part the
// user can act on and hide the wrapper's line numbers where we can.
function cleanCompileError(stderr, langId) {
  const lines = stderr.split('\n').filter((l) => l.trim());
  const relevant = lines.filter((l) => !/^\s*(\^|~|\||\d+\s*\|)/.test(l)).slice(0, 12);
  const label = langId === 'java' ? 'Java' : 'C++';
  return `${label} compile error:\n${relevant.join('\n').slice(0, 1500)}`;
}
