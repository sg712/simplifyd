import './env.js'; // must be first — loads .env before anything reads process.env
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, save } from './store.js';
import { runTests } from './judge.js';
import { detectLanguages, availableLanguages, isAvailable, starterFor, LANGUAGES } from './languages.js';
import {
  DRILLS_TO_GRADUATE,
  getDrill,
  forgetDrill,
  publicDrill,
  checkDrill,
} from './drills.js';
import {
  aiAvailable,
  getDrillHint,
  getChallengeHint,
  getDrillReview,
  observeCode,
  chatWithSage,
  checkCredentials,
  status as aiStatus,
  MODEL as SAGE_MODEL,
} from './ai.js';

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

const DRILL_POINTS = 25;
const HINT_COST_PCT = 0.15;
const MIN_AWARD_PCT = 0.4;
const MAX_HINTS = 3;
const DEFAULT_LANG = 'javascript';

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');

function parseCookies(req) {
  const out = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

function requireAuth(req, res, next) {
  const token = parseCookies(req).dc_session;
  const session = token && db.sessions[token];
  const user = session && db.users[session.username];
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  req.userKey = session.username;
  next();
}

function pickLanguage(user, requested) {
  const candidate = requested || user.language || DEFAULT_LANG;
  if (LANGUAGES[candidate] && isAvailable(candidate)) return candidate;
  const firstAvailable = Object.keys(LANGUAGES).find(isAvailable);
  return firstAvailable || DEFAULT_LANG;
}

function todayState(user) {
  user.days ??= {};
  const key = String(dayNumber());
  user.days[key] ??= { attempts: 0, hintsUsed: 0, solved: false, awarded: 0 };
  return user.days[key];
}

const graduated = (user) => (user.training?.completed?.length || 0) >= DRILLS_TO_GRADUATE;

function publicUser(user) {
  const state = todayState(user);
  const completed = user.training?.completed || [];
  return {
    username: user.username,
    points: user.points,
    streak: user.streak,
    language: user.language || DEFAULT_LANG,
    assistantEnabled: user.assistantEnabled,
    solvedTotal: Object.values(user.days || {}).filter((d) => d.solved).length,
    training: {
      completed: completed.length,
      total: DRILLS_TO_GRADUATE,
      graduated: graduated(user),
      hintsUsedOnCurrent: user.training?.hintsUsedOnCurrent || 0,
    },
    today: {
      solved: state.solved,
      attempts: state.attempts,
      hintsUsed: state.hintsUsed,
      awarded: state.awarded,
    },
  };
}

// ---------- auth ----------

function createSession(res, usernameKey) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { username: usernameKey, createdAt: Date.now() };
  res.setHeader(
    'Set-Cookie',
    `dc_session=${token}; HttpOnly; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`
  );
}

app.post('/api/register', (req, res) => {
  const { username, password, language } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const key = username.toLowerCase();
  if (db.users[key]) return res.status(409).json({ error: 'That username is taken' });

  const salt = crypto.randomBytes(16).toString('hex');
  db.users[key] = {
    username,
    salt,
    passHash: hashPassword(password, salt),
    createdAt: Date.now(),
    points: 0,
    streak: 0,
    lastSolvedDay: null,
    language: LANGUAGES[language] && isAvailable(language) ? language : DEFAULT_LANG,
    days: {},
    training: { completed: [], hintsUsedOnCurrent: 0 },
    assistantEnabled: true, // Sage runs the training ladder, so it's on by default
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

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req).dc_session;
  if (token) delete db.sessions[token];
  save();
  res.setHeader('Set-Cookie', 'dc_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    user: publicUser(req.user),
    aiAvailable: aiAvailable(),
    sage: publicAiStatus(),
    languages: availableLanguages(),
  });
});

app.get('/api/config', (req, res) => {
  res.json({ languages: availableLanguages(), aiAvailable: aiAvailable(), sage: publicAiStatus() });
});

// What the client is told about Sage's health. No secrets — just enough to
// explain itself when it's running in fallback mode.
function publicAiStatus() {
  return {
    live: aiStatus.live,
    configured: aiStatus.configured,
    reason: aiStatus.reason,
    detail: aiStatus.detail,
  };
}

app.post('/api/language', requireAuth, (req, res) => {
  const lang = pickLanguage(req.user, req.body?.language);
  req.user.language = lang;
  save();
  res.json({ language: lang });
});

// ---------- training ----------

app.get('/api/training/current', requireAuth, async (req, res) => {
  const user = req.user;
  user.training ??= { completed: [], hintsUsedOnCurrent: 0 };
  const language = pickLanguage(user, req.query.language);
  if (user.language !== language) {
    user.language = language;
    save();
  }

  if (graduated(user)) {
    return res.json({ graduated: true, completed: user.training.completed.length, total: DRILLS_TO_GRADUATE });
  }

  const index = user.training.completed.length;
  const last = user.training.completed[index - 1];
  const drill = await getDrill({
    userKey: req.userKey,
    index,
    language,
    history: user.training.completed.map((c) => ({ title: c.title, concept: c.concept })),
    recentCode: last?.code,
  });

  res.json({
    graduated: false,
    language,
    drill: publicDrill(drill, index),
    hintsUsed: user.training.hintsUsedOnCurrent || 0,
    maxHints: MAX_HINTS,
    aiAvailable: aiAvailable(),
  });
});

app.post('/api/training/submit', requireAuth, async (req, res) => {
  const user = req.user;
  user.training ??= { completed: [], hintsUsedOnCurrent: 0 };
  if (graduated(user)) return res.status(400).json({ error: 'Training already complete' });

  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'No code to run' });

  const language = pickLanguage(user, req.body?.language);
  const index = user.training.completed.length;
  const drill = await getDrill({
    userKey: req.userKey,
    index,
    language,
    history: user.training.completed.map((c) => ({ title: c.title, concept: c.concept })),
    recentCode: user.training.completed[index - 1]?.code,
  });

  if (drill.brokenReference) {
    return res.status(500).json({ error: `This drill can't be graded right now: ${drill.brokenReference}` });
  }

  const result = await checkDrill(drill, code, language);
  if (!result.pass) {
    save();
    return res.json({ ok: true, pass: false, ...result });
  }

  const hintsUsed = user.training.hintsUsedOnCurrent || 0;
  const award = Math.max(
    Math.round(DRILL_POINTS * (1 - hintsUsed * HINT_COST_PCT)),
    Math.round(DRILL_POINTS * MIN_AWARD_PCT)
  );
  user.points += award;
  user.training.completed.push({
    id: drill.id,
    title: drill.title,
    concept: drill.concept,
    code,
    language,
    hintsUsed,
    at: Date.now(),
  });
  user.training.hintsUsedOnCurrent = 0;
  save();

  let review = null;
  if (aiAvailable()) {
    try {
      review = await getDrillReview({ drill, code, language });
    } catch (err) {
      console.warn('Sage review failed:', err.message);
    }
  }

  const nowGraduated = graduated(user);
  res.json({
    ok: true,
    pass: true,
    output: result.output,
    award,
    points: user.points,
    review,
    completed: user.training.completed.length,
    total: DRILLS_TO_GRADUATE,
    graduated: nowGraduated,
  });
});

app.post('/api/training/hint', requireAuth, async (req, res) => {
  const user = req.user;
  user.training ??= { completed: [], hintsUsedOnCurrent: 0 };
  if (graduated(user)) return res.status(400).json({ error: 'Training already complete' });
  if ((user.training.hintsUsedOnCurrent || 0) >= MAX_HINTS) {
    return res.status(400).json({ error: 'No hints left on this drill' });
  }

  const language = pickLanguage(user, req.body?.language);
  const index = user.training.completed.length;
  const drill = await getDrill({
    userKey: req.userKey,
    index,
    language,
    history: user.training.completed.map((c) => ({ title: c.title, concept: c.concept })),
    recentCode: user.training.completed[index - 1]?.code,
  });

  const hintLevel = (user.training.hintsUsedOnCurrent || 0) + 1;
  const { code } = req.body || {};

  // Run their code first so Sage sees the real failure, not a guess at it.
  let output = null;
  if (typeof code === 'string' && code.trim()) {
    const attempt = await checkDrill(drill, code, language);
    output = attempt.error ? `(error) ${attempt.error}` : attempt.output;
  }

  let hint = null;
  let source = 'sage';
  if (aiAvailable()) {
    try {
      hint = await getDrillHint({
        drill,
        code,
        language,
        hintLevel,
        output,
        expected: drill.expectedOutput,
      });
    } catch (err) {
      console.warn('Sage hint failed, using curriculum hint:', err.message);
    }
  }
  if (!hint) {
    hint = (drill.hints || [])[hintLevel - 1] || 'Re-read the expected output carefully — the format has to match exactly.';
    source = 'curriculum';
  }

  user.training.hintsUsedOnCurrent = hintLevel;
  save();
  res.json({ hint, source, hintLevel, hintsRemaining: MAX_HINTS - hintLevel });
});

app.post('/api/training/skip', requireAuth, async (req, res) => {
  // Escape hatch: a broken AI-authored drill shouldn't be able to wall someone in.
  const user = req.user;
  user.training ??= { completed: [], hintsUsedOnCurrent: 0 };
  const language = pickLanguage(user, req.body?.language);
  forgetDrill(req.userKey, user.training.completed.length, language);
  user.training.hintsUsedOnCurrent = 0;
  save();
  res.json({ ok: true });
});

// ---------- daily challenge ----------

function requireGraduated(req, res, next) {
  if (!graduated(req.user)) {
    return res.status(403).json({
      error: 'Finish training to unlock the daily challenge',
      completed: req.user.training?.completed?.length || 0,
      total: DRILLS_TO_GRADUATE,
    });
  }
  next();
}

app.get('/api/problem/today', requireAuth, requireGraduated, (req, res) => {
  const problem = todaysProblem();
  const language = pickLanguage(req.user, req.query.language);
  const state = todayState(req.user);
  res.json({
    problem: {
      id: problem.id,
      number: dayNumber() % 100000,
      title: problem.title,
      difficulty: problem.difficulty,
      points: problem.points,
      statement: problem.statement,
      constraints: problem.constraints,
      functionName: problem.functionName,
      starterCode: starterFor(problem, language),
      examples: problem.examples,
    },
    language,
    today: state,
    msUntilNext: (dayNumber() + 1) * DAY_MS - Date.now(),
    maxHints: MAX_HINTS,
    hintCostPct: HINT_COST_PCT,
  });
});

app.post('/api/run', requireAuth, requireGraduated, async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'No code to run' });
  const language = pickLanguage(req.user, req.body?.language);
  const problem = todaysProblem();
  const result = await runTests(code, problem, problem.examples, language);
  if (!result.ok) return res.json({ ok: false, error: result.error, phase: result.phase });
  res.json({
    ok: true,
    results: result.results.map((r, i) => ({
      ...r,
      args: problem.examples[i].args,
      expected: JSON.stringify(problem.examples[i].expected),
    })),
    allPass: result.results.every((r) => r.pass),
    logs: result.logs,
  });
});

app.post('/api/submit', requireAuth, requireGraduated, async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'No code to submit' });
  const user = req.user;
  const state = todayState(user);
  if (state.solved) return res.status(400).json({ error: "Already solved today's challenge" });

  const language = pickLanguage(user, req.body?.language);
  const problem = todaysProblem();
  const tests = [...problem.examples, ...problem.hiddenTests];
  state.attempts += 1;

  const result = await runTests(code, problem, tests, language);
  if (!result.ok) {
    save();
    return res.json({ ok: false, error: result.error, phase: result.phase, attempts: state.attempts });
  }

  const passed = result.results.filter((r) => r.pass).length;
  if (passed !== tests.length) {
    save();
    const idx = result.results.findIndex((r) => !r.pass);
    const visible = idx < problem.examples.length;
    return res.json({
      ok: true,
      accepted: false,
      passed,
      total: tests.length,
      attempts: state.attempts,
      firstFailure: visible
        ? {
            args: tests[idx].args,
            expected: JSON.stringify(tests[idx].expected),
            actual: result.results[idx].actual ?? null,
            error: result.results[idx].error || null,
          }
        : { hidden: true, error: result.results[idx].error || null },
    });
  }

  const today = dayNumber();
  user.streak = user.lastSolvedDay === today - 1 ? user.streak + 1 : 1;
  user.lastSolvedDay = today;
  const base = problem.points;
  const afterHints = Math.max(
    Math.round(base * (1 - state.hintsUsed * HINT_COST_PCT)),
    Math.round(base * MIN_AWARD_PCT)
  );
  const award = afterHints + 10 * Math.min(user.streak, 5);
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
    attempts: state.attempts,
    hintsUsed: state.hintsUsed,
    streak: user.streak,
    points: user.points,
    shareText: buildShareText(problem, state, user),
  });
});

// Wordle-style shareable result — the daily ritual, not a résumé line.
function buildShareText(problem, state, user) {
  const squares =
    '🟩'.repeat(1) + '🟥'.repeat(Math.max(0, Math.min(state.attempts - 1, 5)));
  const hints = state.hintsUsed ? ` 🔮${state.hintsUsed}` : '';
  return `Ramp #${dayNumber() % 100000} · ${problem.difficulty}\n${squares}${hints} · ${state.attempts} ${state.attempts === 1 ? 'try' : 'tries'} · +${state.awarded}\n🔥 ${user.streak} day streak`;
}

app.post('/api/assistant/hint', requireAuth, requireGraduated, async (req, res) => {
  const user = req.user;
  if (!user.assistantEnabled) return res.status(403).json({ error: 'Sage is switched off' });
  const state = todayState(user);
  if (state.solved) return res.status(400).json({ error: "You've already solved today's challenge" });
  if (state.hintsUsed >= MAX_HINTS) return res.status(400).json({ error: 'No hints left today' });

  const language = pickLanguage(user, req.body?.language);
  const problem = todaysProblem();
  const { code, message } = req.body || {};
  const hintLevel = state.hintsUsed + 1;

  let runSummary = null;
  if (typeof code === 'string' && code.trim()) {
    const run = await runTests(code, problem, problem.examples, language);
    runSummary = run.ok
      ? run.results
          .map((r, i) => {
            const label = `Example ${i + 1} (${JSON.stringify(problem.examples[i].args)})`;
            if (r.pass) return `${label}: PASS`;
            if (r.error) return `${label}: ERROR ${r.error}`;
            return `${label}: FAIL expected ${JSON.stringify(problem.examples[i].expected)}, got ${r.actual}`;
          })
          .join('\n')
      : `Code failed to run: ${run.error}`;
  }

  let hint = null;
  let source = 'sage';
  if (aiAvailable()) {
    try {
      hint = await getChallengeHint({ problem, code, language, hintLevel, runSummary, userMessage: message });
    } catch (err) {
      console.warn('Sage hint failed, using curriculum hint:', err.message);
    }
  }
  if (!hint) {
    hint = problem.hints[hintLevel - 1];
    source = 'curriculum';
  }

  state.hintsUsed = hintLevel;
  save();
  res.json({ hint, source, hintLevel, hintsRemaining: MAX_HINTS - hintLevel, pointsPenaltyPct: Math.round(HINT_COST_PCT * 100) });
});

// ── live monitoring ──
// The client watches typing for stuck patterns and calls this. Sage decides
// whether it's worth speaking up. Deliberately FREE — this is Sage noticing on
// its own, not you spending a hint. Rate-limited so it can't nag.

const OBSERVE_COOLDOWN_MS = 25000;
const observeState = new Map(); // userKey -> { last: ts, remarks: string[] }

// Offline read: no model, so lean on the signal itself rather than inventing
// insight we don't have.
const OFFLINE_REMARKS = {
  repeated_failures: 'same result a few times now — want a hint instead of another guess?',
  same_error: "that's the same error again — the fix probably isn't where you're looking.",
  idle_untouched: 'not sure where to start? ask me and I\'ll get you going.',
  idle_mid_edit: 'stuck on this bit? I\'m right here.',
  churn: 'lots of edits, same place — might be worth a hint.',
  long_task: 'this one\'s taking a while. no shame in a nudge.',
};

app.post('/api/assistant/observe', requireAuth, async (req, res) => {
  const user = req.user;
  if (!user.assistantEnabled) return res.json({ stuck: false });

  const { code, signal, context, lastOutput } = req.body || {};
  if (!signal?.type || typeof code !== 'string') return res.status(400).json({ error: 'Bad observation' });

  const now = Date.now();
  const state = observeState.get(req.userKey) || { last: 0, remarks: [] };
  if (now - state.last < OBSERVE_COOLDOWN_MS) return res.json({ stuck: false, throttled: true });

  const language = pickLanguage(user, req.body?.language);
  const daily = context === 'daily';

  // Never monitor something that's already finished.
  if (daily && (!graduated(user) || todayState(user).solved)) return res.json({ stuck: false });
  if (!daily && graduated(user)) return res.json({ stuck: false });

  let target;
  try {
    if (daily) {
      const problem = todaysProblem();
      target = {
        title: problem.title,
        instructions: problem.statement,
        starterCode: starterFor(problem, language),
        expected: null,
      };
    } else {
      const index = user.training.completed.length;
      const drill = await getDrill({
        userKey: req.userKey,
        index,
        language,
        history: user.training.completed.map((c) => ({ title: c.title, concept: c.concept })),
        recentCode: user.training.completed[index - 1]?.code,
      });
      target = {
        title: drill.title,
        instructions: drill.instructions,
        starterCode: drill.starterCode,
        expected: drill.expectedOutput,
      };
    }
  } catch {
    return res.json({ stuck: false });
  }

  let verdict = null;
  if (aiAvailable()) {
    try {
      verdict = await observeCode({
        context: daily ? 'daily' : 'drill',
        ...target,
        code,
        language,
        signal,
        lastOutput,
        recentRemarks: state.remarks.slice(-4),
      });
    } catch (err) {
      console.warn('Sage observation failed:', err.message);
    }
  }

  if (!verdict) {
    // Offline: trust the client's signal, but only for the strong ones.
    const strong = ['repeated_failures', 'same_error', 'idle_untouched', 'long_task'];
    const message = OFFLINE_REMARKS[signal.type];
    verdict = strong.includes(signal.type) && message
      ? { stuck: true, confidence: 0.5, read: signal.type, message, offline: true }
      : { stuck: false };
  }

  if (verdict.stuck && verdict.message) {
    state.last = now;
    state.remarks.push(verdict.message);
    if (state.remarks.length > 8) state.remarks.shift();
    observeState.set(req.userKey, state);
  } else {
    // Back off a little even on a "stay quiet" so we don't re-ask instantly.
    observeState.set(req.userKey, { ...state, last: now - OBSERVE_COOLDOWN_MS / 2 });
  }

  res.json({
    stuck: Boolean(verdict.stuck && verdict.message),
    message: verdict.message || '',
    read: verdict.read || '',
    source: verdict.offline ? 'heuristic' : 'sage',
  });
});

// ── conversation ──
// Free and unlimited. Asking a question is not the same as spending a hint —
// the hint ladder is the thing that costs points.

const chatState = new Map(); // userKey -> { key: string, history: [{role, content}] }
const CHAT_TURN_LIMIT = 40;

app.post('/api/assistant/ask', requireAuth, async (req, res) => {
  const user = req.user;
  if (!user.assistantEnabled) return res.status(403).json({ error: 'Sage is switched off' });

  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Say something first' });
  if (message.length > 1500) return res.status(400).json({ error: 'That message is too long' });

  if (!aiAvailable()) {
    return res.json({
      reply:
        "I can't read messages without an API key set on the server — I'm running on the built-in hint ladder instead. Hit **Give me a hint** and I'll still get you moving.",
      source: 'offline',
    });
  }

  const language = pickLanguage(user, req.body?.language);
  const daily = req.body?.context === 'daily';
  const { code, lastOutput } = req.body || {};

  let target;
  try {
    if (daily) {
      if (!graduated(user)) return res.status(403).json({ error: 'Finish training first' });
      const problem = todaysProblem();
      target = { title: problem.title, instructions: problem.statement, expected: null, key: `daily:${problem.id}` };
    } else {
      const index = user.training.completed.length;
      const drill = await getDrill({
        userKey: req.userKey,
        index,
        language,
        history: user.training.completed.map((c) => ({ title: c.title, concept: c.concept })),
        recentCode: user.training.completed[index - 1]?.code,
      });
      target = {
        title: drill.title,
        instructions: drill.instructions,
        expected: drill.expectedOutput,
        key: `drill:${drill.id}`,
      };
    }
  } catch {
    return res.status(500).json({ error: "Couldn't load the task Sage is helping with" });
  }

  // Conversation resets when you move to a new drill or problem.
  let state = chatState.get(req.userKey);
  if (!state || state.key !== target.key) {
    state = { key: target.key, history: [] };
    chatState.set(req.userKey, state);
  }
  if (state.history.length >= CHAT_TURN_LIMIT * 2) {
    return res.status(429).json({ error: "That's a lot of questions for one task — try a hint instead." });
  }

  let reply;
  try {
    reply = await chatWithSage({
      context: daily ? 'daily' : 'drill',
      ...target,
      code,
      language,
      lastOutput,
      history: state.history,
      message,
    });
  } catch (err) {
    console.warn('Sage chat failed:', err.message);
    return res.status(502).json({ error: "Sage couldn't answer that one — try again." });
  }

  state.history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
  res.json({ reply, source: 'sage' });
});

app.post('/api/assistant/toggle', requireAuth, (req, res) => {
  req.user.assistantEnabled = Boolean(req.body?.enabled);
  save();
  res.json({ assistantEnabled: req.user.assistantEnabled });
});

// ---------- leaderboard ----------

app.get('/api/leaderboard', (req, res) => {
  const today = String(dayNumber());
  const rows = Object.values(db.users)
    .map((u) => ({
      username: u.username,
      points: u.points,
      streak: u.streak,
      language: u.language || DEFAULT_LANG,
      drills: u.training?.completed?.length || 0,
      graduated: graduated(u),
      solvedTotal: Object.values(u.days || {}).filter((d) => d.solved).length,
      solvedToday: Boolean(u.days?.[today]?.solved),
    }))
    .sort((a, b) => b.points - a.points || b.solvedTotal - a.solvedTotal)
    .slice(0, 50)
    .map((row, i) => ({ rank: i + 1, ...row }));

  const solversToday = Object.values(db.users).filter((u) => u.days?.[today]?.solved).length;
  res.json({ leaderboard: rows, solversToday, learners: Object.keys(db.users).length });
});

// ---------- boot ----------

const PORT = process.env.PORT || 3000;

// Probe toolchains and the API key together, then report both honestly. The
// credential check is a real one-token request — "the env var is set" is not
// the same as "the key works", and only one of those is worth printing.
Promise.all([detectLanguages(), checkCredentials()]).then(([langs, sage]) => {
  app.listen(PORT, () => {
    const ready = langs.filter((l) => l.available).map((l) => l.label);
    const missing = langs.filter((l) => !l.available).map((l) => l.label);

    console.log(`\n  ⬡ Ramp → http://localhost:${PORT}\n`);
    console.log(`  Languages   ${ready.join(', ') || 'NONE — install node, python3, javac or g++'}`);
    if (missing.length) console.log(`  Missing     ${missing.join(', ')}`);

    if (sage.live) {
      console.log(`  Sage        ✓ ${sage.reason} — ${SAGE_MODEL}`);
      console.log(`              drills are AI-authored, hints read your code\n`);
    } else {
      console.log(`  Sage        ✗ ${sage.reason} — running the built-in curriculum instead`);
      if (sage.detail) console.log(`              ${sage.detail}`);
      console.log('');
    }
  });
});
