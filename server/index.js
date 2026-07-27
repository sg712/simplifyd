import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, save } from './store.js';
import { runTests } from './judge.js';
import { aiAvailable, getAiHint } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const problems = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'problems.json'), 'utf8')
);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const db = getDb();

// ---------- helpers ----------

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = () => Math.floor(Date.now() / DAY_MS);
const todaysProblem = () => problems[dayNumber() % problems.length];

const HINT_COST_PCT = 0.15; // each hint shaves 15% off the base award
const MIN_AWARD_PCT = 0.4;
const MAX_HINTS = 3;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function parseCookies(req) {
  const out = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).dc_session;
  const session = token && db.sessions[token];
  if (!session) return null;
  return db.users[session.username] || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

function todayState(user) {
  user.days ??= {};
  const key = String(dayNumber());
  user.days[key] ??= { attempts: 0, hintsUsed: 0, solved: false, awarded: 0 };
  return user.days[key];
}

function computeAward(problem, hintsUsed, streak) {
  const base = problem.points;
  const afterHints = Math.max(
    Math.round(base * (1 - hintsUsed * HINT_COST_PCT)),
    Math.round(base * MIN_AWARD_PCT)
  );
  const streakBonus = 10 * Math.min(streak, 5);
  return afterHints + streakBonus;
}

function publicUser(user) {
  const state = todayState(user);
  return {
    username: user.username,
    points: user.points,
    streak: user.streak,
    solvedTotal: Object.values(user.days || {}).filter((d) => d.solved).length,
    assistantEnabled: user.assistantEnabled,
    today: {
      solved: state.solved,
      attempts: state.attempts,
      hintsUsed: state.hintsUsed,
      awarded: state.awarded,
    },
  };
}

function summarizeRun(results, tests) {
  return results
    .map((r, i) => {
      const label = `Test ${i + 1} (${JSON.stringify(tests[i].args)})`;
      if (r.pass) return `${label}: PASS`;
      if (r.error) return `${label}: ERROR ${r.error}`;
      return `${label}: FAIL expected ${JSON.stringify(tests[i].expected)}, got ${JSON.stringify(r.actual)}`;
    })
    .join('\n');
}

// ---------- auth ----------

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) {
    return res.status(400).json({ error: 'Username must be 3-20 chars: letters, numbers, underscore' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const key = username.toLowerCase();
  if (db.users[key]) return res.status(409).json({ error: 'Username is taken' });

  const salt = crypto.randomBytes(16).toString('hex');
  db.users[key] = {
    username,
    salt,
    passHash: hashPassword(password, salt),
    createdAt: Date.now(),
    points: 0,
    streak: 0,
    lastSolvedDay: null,
    days: {},
    assistantEnabled: false, // Sage is opt-in
    seenSagePrompt: false,
  };
  createSession(res, key);
  save();
  res.json({ user: publicUser(db.users[key]) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.users[(username || '').toLowerCase()];
  if (!user || hashPassword(password || '', user.salt) !== user.passHash) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  createSession(res, username.toLowerCase());
  save();
  res.json({ user: publicUser(user) });
});

function createSession(res, usernameKey) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { username: usernameKey, createdAt: Date.now() };
  res.setHeader(
    'Set-Cookie',
    `dc_session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`
  );
}

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).dc_session;
  if (token) delete db.sessions[token];
  save();
  res.setHeader('Set-Cookie', 'dc_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), aiAvailable: aiAvailable() });
});

// ---------- daily problem ----------

app.get('/api/problem/today', requireAuth, (req, res) => {
  const problem = todaysProblem();
  const state = todayState(req.user);
  const msUntilNext = (dayNumber() + 1) * DAY_MS - Date.now();
  res.json({
    problem: {
      id: problem.id,
      title: problem.title,
      difficulty: problem.difficulty,
      points: problem.points,
      statement: problem.statement,
      constraints: problem.constraints,
      functionName: problem.functionName,
      starterCode: problem.starterCode,
      examples: problem.examples,
    },
    today: state,
    msUntilNext,
    hintCostPct: HINT_COST_PCT,
    maxHints: MAX_HINTS,
  });
});

// ---------- run & submit ----------

app.post('/api/run', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'No code to run' });
  }
  const problem = todaysProblem();
  const result = await runTests(code, problem.functionName, problem.examples);
  if (!result.ok) return res.json({ ok: false, error: result.error });
  res.json({
    ok: true,
    results: result.results.map((r, i) => ({ ...r, args: problem.examples[i].args, expected: problem.examples[i].expected })),
    allPass: result.results.every((r) => r.pass),
  });
});

app.post('/api/submit', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'No code to submit' });
  }
  const user = req.user;
  const state = todayState(user);
  if (state.solved) return res.status(400).json({ error: 'Already solved today — come back tomorrow!' });

  const problem = todaysProblem();
  const tests = [...problem.examples, ...problem.hiddenTests];
  state.attempts += 1;

  const result = await runTests(code, problem.functionName, tests);
  if (!result.ok) {
    save();
    return res.json({ ok: false, error: result.error, attempts: state.attempts });
  }

  const passed = result.results.filter((r) => r.pass).length;
  const allPass = passed === tests.length;

  if (!allPass) {
    save();
    // Only reveal details for visible example tests; hidden tests report pass/fail.
    const firstFail = result.results.findIndex((r) => !r.pass);
    const isVisible = firstFail < problem.examples.length;
    return res.json({
      ok: true,
      accepted: false,
      passed,
      total: tests.length,
      attempts: state.attempts,
      firstFailure: isVisible
        ? {
            args: tests[firstFail].args,
            expected: tests[firstFail].expected,
            actual: result.results[firstFail].actual ?? null,
            error: result.results[firstFail].error || null,
          }
        : { hidden: true, error: result.results[firstFail].error || null },
    });
  }

  // Accepted — award points, update streak.
  const today = dayNumber();
  user.streak = user.lastSolvedDay === today - 1 ? user.streak + 1 : 1;
  user.lastSolvedDay = today;
  const award = computeAward(problem, state.hintsUsed, user.streak);
  state.solved = true;
  state.awarded = award;
  state.problemId = problem.id;
  user.points += award;
  save();

  res.json({
    ok: true,
    accepted: true,
    passed,
    total: tests.length,
    award,
    hintsUsed: state.hintsUsed,
    streak: user.streak,
    points: user.points,
  });
});

// ---------- leaderboard ----------

app.get('/api/leaderboard', (req, res) => {
  const rows = Object.values(db.users)
    .map((u) => ({
      username: u.username,
      points: u.points,
      streak: u.streak,
      solvedTotal: Object.values(u.days || {}).filter((d) => d.solved).length,
      solvedToday: Boolean(u.days?.[String(dayNumber())]?.solved),
    }))
    .sort((a, b) => b.points - a.points || b.solvedTotal - a.solvedTotal)
    .slice(0, 50)
    .map((row, i) => ({ rank: i + 1, ...row }));
  res.json({ leaderboard: rows });
});

// ---------- Sage (AI assistant) ----------

app.post('/api/assistant/toggle', requireAuth, (req, res) => {
  req.user.assistantEnabled = Boolean(req.body?.enabled);
  req.user.seenSagePrompt = true;
  save();
  res.json({ assistantEnabled: req.user.assistantEnabled });
});

app.post('/api/assistant/hint', requireAuth, async (req, res) => {
  const user = req.user;
  if (!user.assistantEnabled) {
    return res.status(403).json({ error: 'Sage is disabled. Enable the assistant to get hints.' });
  }
  const state = todayState(user);
  if (state.solved) {
    return res.status(400).json({ error: "You already solved today's problem!" });
  }
  if (state.hintsUsed >= MAX_HINTS) {
    return res.status(400).json({ error: 'No hints left for today.' });
  }

  const problem = todaysProblem();
  const { code, message } = req.body || {};
  const hintLevel = state.hintsUsed + 1;

  // Re-run the visible examples server-side so Sage sees the real failure mode.
  let runSummary = null;
  if (typeof code === 'string' && code.trim()) {
    const run = await runTests(code, problem.functionName, problem.examples);
    runSummary = run.ok ? summarizeRun(run.results, problem.examples) : `Code failed to run: ${run.error}`;
  }

  let hint;
  let source = 'ai';
  if (aiAvailable()) {
    try {
      hint = await getAiHint({
        problem,
        code,
        hintLevel,
        runSummary,
        userMessage: typeof message === 'string' ? message : null,
      });
    } catch (err) {
      console.error('Sage AI error, falling back to static hint:', err.message);
    }
  }
  if (!hint) {
    hint = problem.hints[hintLevel - 1];
    source = 'static';
  }

  state.hintsUsed = hintLevel;
  save();
  res.json({
    hint,
    source,
    hintLevel,
    hintsRemaining: MAX_HINTS - hintLevel,
    pointsPenaltyPct: Math.round(HINT_COST_PCT * 100),
  });
});

// ---------- boot ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DailyCode running on http://localhost:${PORT}`);
  console.log(`Sage AI hints: ${aiAvailable() ? 'live (Claude API)' : 'static fallback (set ANTHROPIC_API_KEY for live hints)'}`);
});
