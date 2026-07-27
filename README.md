# ⚡ DailyCode

A LeetCode-style site with a twist: **you don't browse a catalog of problems — you get exactly one problem per day.** Solve it, earn points, keep your streak alive, and climb the leaderboard. And when you're stuck, **Sage** — an AI coach — shows up right inside the code window (if you enable it).

## How it works

- **One problem a day.** Everyone gets the same problem, rotated daily from the pool in `data/problems.json`. A countdown shows when the next one drops.
- **Points & streaks.** Easy = 100, Medium = 200, Hard = 300 base points. Solving on consecutive days builds a streak (+10 pts/day bonus, capped at +50).
- **Sage, the AI coach.** Opt-in per account. Sage watches for stuck signals — repeated failed runs, long idle pauses — and pops up in the editor offering help. Hints escalate through 3 levels (intuition → technique → walkthrough) and each one trims 15% off the day's points (floor of 40%), so there's a real trade-off.
- **Leaderboard.** Ranked by total points, with streaks and daily solve status.

Sage uses the **Claude API** (`claude-opus-5`) when credentials are available, sending your actual code and real test results so hints are specific to *your* bug. Without an API key, it falls back to a hand-written 3-tier hint ladder per problem — the site works fully offline.

## Running it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional — enables live AI hints
npm start                              # http://localhost:3000
```

Requires Node.js ≥ 20. No database needed — state persists to `data/db.json`.

## Architecture

| Piece | What it does |
|---|---|
| `server/index.js` | Express app: auth (scrypt + session cookies), daily problem selection, run/submit, leaderboard, Sage endpoints |
| `server/judge.js` | Executes user JS in a separate node process with a 4s timeout and memory cap; deep-equal output comparison |
| `server/ai.js` | Claude API integration for Sage — level-calibrated Socratic hints with the user's code and live run results as context |
| `server/store.js` | Debounced JSON-file persistence |
| `data/problems.json` | Problem pool: statement, examples, hidden tests, starter code, 3-tier static hints |
| `public/` | Vanilla JS SPA: CodeMirror editor, Sage orb/panel, leaderboard |

## Notes & limitations

- **The judge is process isolation, not a security sandbox.** User code runs in a separate node process with a timeout and memory limit, which is fine for a demo or a trusted group. For hostile traffic, run the judge inside a container/jail (gVisor, Firecracker, isolated-vm) with no network and a read-only filesystem.
- Hidden test failures only reveal pass/fail (plus crash messages), never inputs — Sage is also instructed never to leak them.
- The daily problem rotates by UTC day (`floor(now / 86400s) % poolSize`). Add problems to `data/problems.json` to grow the rotation.
