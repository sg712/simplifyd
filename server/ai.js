// Sage — the AI coach. Two jobs:
//   1. Author the next training drill for a learner, tuned to what they've done.
//   2. Give escalating, Socratic hints on drills and on the daily challenge.
//
// Every entry point degrades gracefully: callers fall back to the hand-written
// curriculum and hint ladders when no API credentials are present.
import Anthropic from '@anthropic-ai/sdk';

// Sage's model. Opus is the default because it writes the best drills and
// gives the sharpest reads on stuck code — but this is your API bill, so it's
// yours to choose. Set RAMP_MODEL in .env to trade quality for cost:
//   claude-opus-5    $5 / $25 per MTok  (default)
//   claude-sonnet-5  $3 / $15
//   claude-haiku-4-5 $1 / $5            (~5x cheaper than Opus)
export const MODEL = process.env.RAMP_MODEL || 'claude-opus-5';

let client = null;

// Live status, decided by an actual API call at boot rather than by guessing
// from the presence of an env var. A key that exists but is rejected is a very
// different problem from no key at all, and the UI should be able to say which.
export const status = {
  configured: false,
  live: false,
  checked: false,
  reason: 'No API key set',
  detail: null,
};

export function aiAvailable() {
  return status.live;
}

function getClient() {
  client ??= new Anthropic();
  return client;
}

// Every model call goes through here so a key that gets revoked or rate-limited
// mid-session updates the status the UI shows, instead of silently degrading
// into the offline fallbacks with no explanation.
async function createMessage(params) {
  try {
    return await getClient().messages.create(params);
  } catch (err) {
    const code = err?.status;
    if (code === 401 || code === 403) {
      status.live = false;
      status.reason = code === 401 ? 'API key rejected' : 'API key lacks access';
      status.detail = `The API returned ${code} during a request.`;
    }
    throw err;
  }
}

export async function checkCredentials() {
  status.configured = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  status.checked = true;

  if (!status.configured) {
    status.live = false;
    status.reason = 'No API key set';
    status.detail =
      'Put ANTHROPIC_API_KEY in a .env file next to package.json (see .env.example), or export it before starting.';
    return status;
  }

  try {
    // Smallest possible real request — proves the key is accepted and the
    // model id is reachable, for a rounding error of a cent.
    await createMessage({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    });
    status.live = true;
    status.reason = 'live';
    status.detail = null;
  } catch (err) {
    status.live = false;
    const code = err?.status;
    if (code === 401) {
      status.reason = 'API key rejected';
      status.detail = 'The key was sent but the API returned 401. Check for a typo or a revoked key.';
    } else if (code === 403) {
      status.reason = 'API key lacks access';
      status.detail = `403 from the API — the key may not have access to ${MODEL}.`;
    } else if (code === 404) {
      status.reason = 'Model not found';
      status.detail = `The API doesn't recognise "${MODEL}" for this key.`;
    } else if (code === 429) {
      // Rate-limited on a 1-token probe still means the key is valid.
      status.live = true;
      status.reason = 'live (rate-limited at startup)';
      status.detail = null;
    } else {
      status.reason = 'Could not reach the API';
      status.detail = `${err?.name || 'Error'}: ${String(err?.message || err).slice(0, 200)}`;
    }
  }
  return status;
}

function textOf(response) {
  if (response.stop_reason === 'refusal') throw new Error('assistant-refused');
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('assistant-empty');
  return text;
}

const LANG_LABEL = {
  javascript: 'JavaScript (run with node)',
  python: 'Python 3',
  java: 'Java (single file, must contain `public class Main` with a `main` method)',
  cpp: 'C++17 (single file with `int main()`)',
};

// ---------- 1. drill authoring ----------

const DRILL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short, punchy drill name (2-4 words)' },
    concept: { type: 'string', description: 'The one concept being taught, e.g. "Nested loops"' },
    instructions: {
      type: 'string',
      description:
        'Markdown. State the task and show the exact expected output in a fenced code block. Be unambiguous about formatting.',
    },
    why: {
      type: 'string',
      description: 'One or two sentences on why this concept matters for real coding. Motivating, not preachy.',
    },
    starterCode: {
      type: 'string',
      description:
        'A complete, runnable program with the interesting part left as a comment for the learner. Must compile/run as-is even before they edit it.',
    },
    referenceSolution: {
      type: 'string',
      description:
        'A complete, correct program that produces the expected output. This is run to derive the expected output — it must be exactly right.',
    },
    // No minItems/maxItems here: array-length constraints aren't part of the
    // supported structured-output schema subset. The count is stated in the
    // description and normalised below.
    hints: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Exactly three escalating hints: (1) nudge the intuition, (2) name the technique, (3) near-explicit walkthrough that still leaves the typing to them.',
    },
    feedbackOnPrevious: {
      type: 'string',
      description:
        "One warm sentence reacting to the learner's previous submission. Empty string if there was no previous drill.",
    },
  },
  required: ['title', 'concept', 'instructions', 'why', 'starterCode', 'referenceSolution', 'hints', 'feedbackOnPrevious'],
  additionalProperties: false,
};

const DRILL_SYSTEM = `You are Sage, the coach on Ramp — a site that teaches programming through very short, hands-on drills, then graduates learners to daily algorithm challenges.

You author ONE drill at a time. A drill is a tiny program the learner writes in a few minutes, and it is graded by comparing exactly what the program PRINTS to the expected output.

Hard requirements:
- The drill must be checkable purely from stdout. Never ask for a value to be "returned" without also printing it.
- \`starterCode\` must be a complete program that runs successfully as-is (before the learner edits it), with the interesting logic replaced by a comment. Provide any input data (arrays, strings) pre-declared in the starter so the learner only writes the logic.
- \`referenceSolution\` must be a complete, correct program. It will be executed and its output becomes the expected output. Getting this wrong breaks the drill — be meticulous.
- \`instructions\` must show the exact expected output in a fenced code block so there is zero formatting ambiguity.
- Keep it to ONE new concept. Small. A learner should finish in 2-5 minutes.
- Teach in a sensible order and build on what they already did. Do not repeat a concept they've already passed.
- Never include the answer in the instructions or starter code.

Tone: warm, direct, a little playful. You are a good tutor, not a textbook.`;

export async function generateDrill({ language, history, recentCode, targetCount }) {
  const done = history.map((h, i) => `${i + 1}. ${h.title} — ${h.concept}`).join('\n') || '(none yet — this is their very first drill)';
  const prompt = [
    `Language: ${LANG_LABEL[language] || language}`,
    `Drills completed so far (${history.length} of ~${targetCount} before they unlock the daily challenge):\n${done}`,
    recentCode
      ? `Their code on the previous drill:\n\`\`\`\n${recentCode.slice(0, 2000)}\n\`\`\`\nReact to it briefly in feedbackOnPrevious — praise something specific or point out a cleaner idiom.`
      : 'There is no previous submission; set feedbackOnPrevious to an empty string.',
    history.length >= targetCount - 1
      ? 'This is their FINAL drill before the daily challenge. Make it a satisfying capstone that combines a couple of earlier concepts — ideally hash maps or a lookup, since the daily problems lean on those.'
      : 'Pick the natural next concept in the progression.',
    'Author the next drill.',
  ].join('\n\n');

  const response = await createMessage({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: DRILL_SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: DRILL_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  });

  const drill = JSON.parse(textOf(response));

  // Normalise rather than trust: a schema-valid response can still be shaped
  // awkwardly, and the UI indexes hints[0..2] directly.
  const required = ['title', 'concept', 'instructions', 'starterCode', 'referenceSolution'];
  for (const field of required) {
    if (typeof drill[field] !== 'string' || !drill[field].trim()) {
      throw new Error(`drill missing "${field}"`);
    }
  }
  const hints = Array.isArray(drill.hints) ? drill.hints.filter((h) => typeof h === 'string' && h.trim()) : [];
  while (hints.length < 3) {
    hints.push('Re-read the expected output carefully — the format has to match exactly, character for character.');
  }
  drill.hints = hints.slice(0, 3);
  drill.why = typeof drill.why === 'string' ? drill.why : '';
  drill.feedbackOnPrevious = typeof drill.feedbackOnPrevious === 'string' ? drill.feedbackOnPrevious : '';

  return drill;
}

// ---------- 2. hints ----------

const HINT_SYSTEM = `You are Sage, the in-editor coach on Ramp. A learner is stuck and asked for help. Get them unstuck without stealing the moment of solving it.

Rules:
- Warm, brief, concrete. 2-5 sentences. At most one short code fragment — never a complete solution.
- Calibrate to the hint level you're given:
  - Level 1: nudge the intuition. Ask the question they should be asking themselves.
  - Level 2: name the technique or data structure and tie it to their actual code.
  - Level 3: walk through the approach concretely against their code's specific gap — still stop short of a full working answer.
- If their code has a real bug, point at the actual bug rather than giving generic advice.
- If their code is empty or untouched, help them take the first step instead of critiquing.
- Never mock the learner. Never reveal hidden test inputs.
- Plain prose; light markdown (backticks for code) is fine. No headers.`;

export async function getDrillHint({ drill, code, language, hintLevel, output, expected }) {
  const parts = [
    `## Drill: ${drill.title} (${drill.concept})`,
    drill.instructions,
    `Language: ${LANG_LABEL[language] || language}`,
    `## Hint level requested: ${hintLevel} of 3`,
    `## Their code:\n\`\`\`\n${(code || '').slice(0, 4000)}\n\`\`\``,
  ];
  if (expected !== undefined) parts.push(`## Expected output:\n${String(expected).slice(0, 1000)}`);
  if (output !== undefined && output !== null) {
    parts.push(`## What their code actually printed:\n${String(output).slice(0, 1000) || '(nothing)'}`);
  }

  const response = await createMessage({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: HINT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });
  return textOf(response);
}

export async function getChallengeHint({ problem, code, language, hintLevel, runSummary, userMessage }) {
  const parts = [
    `## Daily challenge: ${problem.title} (${problem.difficulty})`,
    problem.statement,
    `Language: ${LANG_LABEL[language] || language}`,
    `Required function: \`${problem.functionName}\``,
    `Visible examples: ${JSON.stringify(problem.examples)}`,
    `## Hint level requested: ${hintLevel} of 3`,
    `## Their code:\n\`\`\`\n${(code || '').slice(0, 6000)}\n\`\`\``,
  ];
  if (runSummary) parts.push(`## Latest run results:\n${runSummary.slice(0, 2000)}`);
  if (userMessage) parts.push(`## They say:\n${userMessage.slice(0, 1000)}`);

  const response = await createMessage({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: HINT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });
  return textOf(response);
}

// ---------- 2b. conversation ----------
// Free-form back-and-forth. Distinct from the hint ladder: questions are free
// and unlimited, because a learner asking "what does % even do" shouldn't have
// to spend a hint. The guardrail is the same — Sage won't write the answer.

const CHAT_SYSTEM = `You are Sage, an in-editor coding tutor on Ramp, talking with a learner while they work on a task.

You can see the task, their current code, and what it printed. Answer whatever they ask.

Rules:
- Conversational and brief — 1-4 sentences typically. This is a small side panel, not an essay.
- Answer the question they actually asked. If they ask what an operator does, just explain it. If they ask why their code misbehaves, explain the cause.
- NEVER write their solution for them, and never paste code that would complete the task. Short illustrative fragments on *unrelated* examples are fine — e.g. explain \`%\` with \`7 % 2\`, not with their loop.
- If they're asking you to just do it, say no warmly and give them the next concrete step instead.
- If their question is vague, answer the most likely reading rather than interrogating them.
- Assume they're a beginner unless their code says otherwise. Skip jargon or define it in passing.
- Plain prose, light markdown (backticks) only. No headers, no bullet-point walls.`;

export async function chatWithSage({ context, title, instructions, code, language, expected, lastOutput, history, message }) {
  const brief = [
    `## What they're working on: ${context === 'daily' ? 'daily challenge' : 'training drill'} — ${title}`,
    (instructions || '').slice(0, 1200),
    expected ? `Expected output:\n${String(expected).slice(0, 400)}` : '',
    `Language: ${LANG_LABEL[language] || language}`,
    `## Their code right now:\n\`\`\`\n${(code || '').slice(0, 4000)}\n\`\`\``,
    lastOutput ? `## What it last printed:\n${String(lastOutput).slice(0, 600)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  // The task brief is a stable prefix; the conversation grows after it.
  const messages = [
    { role: 'user', content: brief },
    { role: 'assistant', content: 'Got it — I can see the task and their code. Ready for their question.' },
    ...(history || []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: message },
  ];

  const response = await createMessage({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: CHAT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
  });
  return textOf(response);
}

// ---------- 3. live monitoring ----------
// Called while the learner is typing, when client-side heuristics suspect
// they're stuck. Sage decides whether to actually speak up — most of the time
// the right answer is to stay quiet.

const OBSERVE_SCHEMA = {
  type: 'object',
  properties: {
    stuck: {
      type: 'boolean',
      description: 'True only if they genuinely appear blocked AND a short remark would help right now.',
    },
    confidence: { type: 'number', description: '0 to 1.' },
    read: {
      type: 'string',
      description:
        'Under 12 words, what you think is happening. e.g. "printing inside the loop instead of after". Empty if not stuck.',
    },
    message: {
      type: 'string',
      description:
        'What Sage says, unprompted, in the corner of the screen. Max 20 words, one sentence, conversational. Point at the specific thing you noticed in THEIR code — never generic encouragement. Do not give the answer. Empty string if not stuck.',
    },
  },
  required: ['stuck', 'confidence', 'read', 'message'],
  additionalProperties: false,
};

const OBSERVE_SYSTEM = `You are Sage, watching a learner's code editor in real time on Ramp, a learn-to-code site. You see their code as they type, plus a signal describing why the client thinks they might be stuck.

Your job is to decide whether to interrupt. You are a presence in the corner of their screen, not a chat partner.

Stay quiet (stuck: false) when:
- The code is progressing sensibly, even if unfinished.
- They just started, or the pause is short.
- The mistake is trivial and they'll obviously catch it themselves.
- You already said something similar recently (you'll be shown your recent remarks).

Speak up (stuck: true) when you can point at something SPECIFIC and real:
- A concrete bug you can see: an off-by-one, a print inside the loop that belongs after it, a variable initialized in the wrong place, a comparison that's assigning.
- They're clearly flailing: repeated near-identical attempts, or the same error again and again.
- They've written nothing meaningful for a long time — they don't know where to start.

Rules for the message:
- One sentence, max 20 words, lowercase-casual is fine. It appears as a small speech bubble.
- Reference what you actually see in their code. "your total resets each loop" beats "check your logic".
- NEVER give the solution. Nudge toward the realization.
- No greetings, no "I noticed that", no exclamation marks stacked up. Just the observation.
- If you're not confident, stay quiet. A wrong interruption is worse than silence.`;

export async function observeCode({ context, title, instructions, code, starterCode, language, signal, expected, lastOutput, recentRemarks }) {
  const parts = [
    `## What they're working on: ${context === 'daily' ? 'daily challenge' : 'training drill'} — ${title}`,
    instructions?.slice(0, 900) || '',
    expected ? `Expected output:\n${String(expected).slice(0, 400)}` : '',
    `Language: ${LANG_LABEL[language] || language}`,
    `## Why I'm being asked to look: ${signal.label}`,
    signal.detail ? `Details: ${signal.detail}` : '',
    `## Their code right now:\n\`\`\`\n${(code || '').slice(0, 3500)}\n\`\`\``,
    starterCode && code === starterCode ? '(This is still the untouched starter code.)' : '',
    lastOutput ? `## Last thing their code produced:\n${String(lastOutput).slice(0, 600)}` : '',
    recentRemarks?.length
      ? `## Things you already said to them recently (do NOT repeat these):\n${recentRemarks.map((r) => `- ${r}`).join('\n')}`
      : '',
    'Decide: speak up, or stay quiet?',
  ].filter(Boolean);

  const response = await createMessage({
    model: MODEL,
    max_tokens: 800,
    output_config: { format: { type: 'json_schema', schema: OBSERVE_SCHEMA }, effort: 'low' },
    system: [{ type: 'text', text: OBSERVE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });

  return JSON.parse(textOf(response));
}

// ---------- 4. review note after a passed drill ----------

export async function getDrillReview({ drill, code, language }) {
  const response = await createMessage({
    model: MODEL,
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: 'You are Sage, a warm coding tutor. The learner just passed a drill. In 1-2 sentences, say something specific and genuine about HOW they solved it — praise a good choice, or mention a cleaner idiom worth knowing. No preamble, no headers, no bullet lists. Never be generic ("Great job!").',
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Drill: ${drill.title} (${drill.concept})\nLanguage: ${LANG_LABEL[language] || language}\n\nTheir passing solution:\n\`\`\`\n${(code || '').slice(0, 2000)}\n\`\`\``,
      },
    ],
  });
  return textOf(response);
}
