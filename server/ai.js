// Sage — the AI coach that pops into the code window when you're stuck.
// Uses the Claude API when credentials are available; the caller falls back to
// the problem's canned hint ladder otherwise.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

let client = null;
export function aiAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient() {
  client ??= new Anthropic();
  return client;
}

const SYSTEM_PROMPT = `You are Sage, the in-editor coach on DailyCode, a daily coding-challenge site. A user is solving today's problem and has signaled (or been detected as) stuck. Your job is to get them unstuck while preserving the joy of solving it themselves.

Rules:
- Be warm, brief, and concrete. 2-5 sentences, at most one short code fragment (never a full solution).
- Calibrate to the hint level you are given:
  - Level 1: nudge intuition. Point at the shape of the approach or a question to ask themselves. No data structures or algorithm names yet if avoidable.
  - Level 2: name the technique or data structure and connect it to their current code.
  - Level 3: walk through the algorithm concretely, referencing their code's specific gap. Still stop short of pasting a complete working solution.
- If their code has a bug (see the run results), prefer pointing at the actual bug over generic advice.
- If their code is empty or just the starter, help them get started instead of critiquing.
- Never mock the user. Never reveal hidden test cases beyond what the run results already show.
- Respond in plain prose (light markdown ok: backticks for code, no headers).`;

export async function getAiHint({ problem, code, hintLevel, runSummary, userMessage }) {
  const parts = [
    `## Problem: ${problem.title} (${problem.difficulty})`,
    problem.statement,
    `Expected function: \`${problem.functionName}\``,
    `Visible examples: ${JSON.stringify(problem.examples)}`,
    `## Hint level requested: ${hintLevel} of 3`,
    `## User's current code:\n\`\`\`js\n${(code || '').slice(0, 6000)}\n\`\`\``,
  ];
  if (runSummary) parts.push(`## Latest run results:\n${runSummary.slice(0, 2000)}`);
  if (userMessage) parts.push(`## The user says:\n${userMessage.slice(0, 1000)}`);

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('assistant-refused');
  }
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('assistant-empty');
  return text;
}
