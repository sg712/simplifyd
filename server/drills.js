// The training ladder: Sage hands you one drill at a time, you make it print
// the right thing, and it hands you the next. Finish the ladder and the daily
// challenge unlocks.
//
// Two sources of drills:
//   - AI-authored (when credentials exist): adaptive, reacts to your code
//   - The static curriculum in data/drills.json: the offline fallback
//
// Either way the expected output is derived by *running* the reference
// solution, never by trusting a written-down answer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram, normalizeOutput } from './judge.js';
import { aiAvailable, generateDrill } from './ai.js';
import { starterFor } from './languages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DRILLS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'drills.json'), 'utf8')
);

export const DRILLS_TO_GRADUATE = 10;

// Verified drills are cached so we don't re-run the reference solution (or
// re-bill an API call) every time the page is refreshed.
const cache = new Map();
const cacheKey = (userKey, index, language) => `${userKey}:${index}:${language}`;

async function verifyDrill(drill, language) {
  const reference = drill.referenceSolution;
  const run = await runProgram(reference, language);
  if (!run.ok || !normalizeOutput(run.stdout)) {
    return { ok: false, error: run.error || 'Reference solution produced no output' };
  }
  return { ok: true, expectedOutput: normalizeOutput(run.stdout) };
}

function staticDrill(index, language) {
  const raw = STATIC_DRILLS[index % STATIC_DRILLS.length];
  return {
    id: raw.id,
    title: raw.title,
    concept: raw.concept,
    instructions: raw.instructions,
    why: raw.why,
    starterCode: raw.starters[language],
    referenceSolution: raw.solutions[language],
    hints: raw.hints,
    feedbackOnPrevious: '',
    source: 'curriculum',
  };
}

export async function getDrill({ userKey, index, language, history, recentCode, forceStatic }) {
  const key = cacheKey(userKey, index, language);
  if (cache.has(key)) return cache.get(key);

  let drill = null;

  if (aiAvailable() && !forceStatic) {
    try {
      const authored = await generateDrill({
        language,
        history,
        recentCode,
        targetCount: DRILLS_TO_GRADUATE,
      });
      const check = await verifyDrill(authored, language);
      if (check.ok) {
        drill = {
          id: `ai-${index}`,
          ...authored,
          expectedOutput: check.expectedOutput,
          source: 'sage',
        };
      } else {
        console.warn(`Sage drill ${index} failed verification (${check.error}); using curriculum.`);
      }
    } catch (err) {
      console.warn(`Sage drill generation failed: ${err.message}; using curriculum.`);
    }
  }

  if (!drill) {
    const fallback = staticDrill(index, language);
    const check = await verifyDrill(fallback, language);
    drill = {
      ...fallback,
      // If even the curriculum's reference won't run, the language toolchain is
      // broken — surface that rather than silently accepting anything.
      expectedOutput: check.ok ? check.expectedOutput : null,
      brokenReference: check.ok ? undefined : check.error,
    };
  }

  cache.set(key, drill);
  return drill;
}

export function forgetDrill(userKey, index, language) {
  cache.delete(cacheKey(userKey, index, language));
}

// What the client is allowed to see — never the reference solution.
export function publicDrill(drill, index) {
  return {
    id: drill.id,
    index,
    number: index + 1,
    total: DRILLS_TO_GRADUATE,
    title: drill.title,
    concept: drill.concept,
    instructions: drill.instructions,
    why: drill.why,
    starterCode: drill.starterCode,
    expectedOutput: drill.expectedOutput,
    feedbackOnPrevious: drill.feedbackOnPrevious || '',
    source: drill.source,
    brokenReference: drill.brokenReference || null,
  };
}

export async function checkDrill(drill, userCode, language) {
  const run = await runProgram(userCode, language);
  if (!run.ok) {
    return { pass: false, phase: run.phase || 'run', error: run.error, output: run.stdout ?? '' };
  }
  const got = normalizeOutput(run.stdout);
  const want = normalizeOutput(drill.expectedOutput);
  if (got === want) return { pass: true, output: got };

  return { pass: false, output: got, expected: want, diff: firstDiff(got, want) };
}

// Point at the first line that differs — much friendlier than "output mismatch".
function firstDiff(got, want) {
  const g = got.split('\n');
  const w = want.split('\n');
  for (let i = 0; i < Math.max(g.length, w.length); i++) {
    if (g[i] !== w[i]) {
      return {
        line: i + 1,
        got: g[i] === undefined ? null : g[i],
        want: w[i] === undefined ? null : w[i],
      };
    }
  }
  return null;
}

export { starterFor };
