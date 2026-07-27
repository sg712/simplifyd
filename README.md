# ⬡ Ramp

**Learn to code by writing code — then keep a daily streak.**

Ramp isn't a problem catalog. It's two phases:

### 1. The training ladder
Sage, an AI coach, hands you **one small drill at a time**. Print an array. Filter it to evens. Add them up. Write a function. Count letters with a hash map. You write a tiny program, hit **Run & check**, and Ramp compares what your program actually printed against what it should print — with a side-by-side diff pointing at the first line that differs.

Clear a rung, Sage reacts to *how you solved it* and writes the next one. Ten rungs and you graduate.

### 2. The daily challenge
One real algorithm problem a day — the same one for everybody, LeetCode-style, with hidden tests. Solve it, earn points scaled by difficulty and your streak, and copy a Wordle-style share card:

```
Ramp #20661 · Medium
🟩🟥 🔮1 · 2 tries · +180
🔥 4 day streak
```

Everything is ranked on one board: points, streak, language, and how far up the ladder you are.

---

## Running it

```bash
npm install
npm start          # → http://localhost:3000
```

Node.js 20+. No database — state lands in `data/db.json`.

### Turning Sage on

Sage needs an Anthropic API key. Get one at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys), then:

```bash
cp .env.example .env
# open .env and paste your key after ANTHROPIC_API_KEY=
npm start
```

`.env` is gitignored, and it beats `export` because it survives closing the terminal. A real environment variable still wins if you'd rather set one.

**Ramp verifies the key at startup with an actual one-token request** — "the variable is set" and "the key works" are different things, and only one of them is worth printing:

```
  Languages   JavaScript, Python 3, Java, C++
  Sage        ✓ live — drills are AI-authored, hints read your code
```

If something's off it tells you exactly what, rather than quietly degrading:

```
  Sage        ✗ API key rejected — running the built-in curriculum instead
              The key was sent but the API returned 401. Check for a typo or a revoked key.
```

It distinguishes no key, a rejected key (401), a key without access to the model (403), an unknown model (404), and an unreachable API. A key that gets revoked mid-session flips the status too, so the app never silently pretends. The same reason is shown inside the Sage panel, so you can tell from the UI whether you're getting real answers or fallbacks.

**Without a key everything still runs.** Sage falls back to a hand-written 10-drill curriculum and static hint ladders, the stuck-detector still catches the unambiguous patterns, and it says so plainly instead of pretending.

| | No key | With key |
|---|---|---|
| Drills | Fixed 10-rung curriculum | Written for you, adapting to your history and your code |
| Stuck detection | Obvious patterns only | Reads your code and names the specific thing you're circling |
| Chat | Unavailable, and says so | Answers questions about your actual code |
| Hints | Fixed 3-tier ladder per task | Written against your specific bug |
| Daily challenge | Fully working | Fully working |

## Languages

JavaScript, Python 3, Java, and C++ — switchable at any time from the header. Starter code and test harnesses are generated per language from each problem's type signature, so switching mid-problem regenerates the scaffold correctly.

Ramp probes for each toolchain at boot and greys out what isn't installed:

```
Languages ready:  JavaScript, Python 3, Java, C++
```

On a stock Mac you'll get JavaScript and Python out of the box; Java needs a JDK and C++ needs Xcode Command Line Tools.

## How grading works

| Phase | What's checked |
|---|---|
| **Drills** | Your program's **stdout**, compared to the output of a reference solution that Ramp actually executes. Nothing is trusted from a written-down answer — including drills the AI wrote, which are verified before you ever see them. |
| **Daily** | A generated harness calls your function against visible examples plus hidden tests, comparing typed return values. Hidden failures report pass/fail only, never their inputs. |

Both run in a scratch directory in a child process with a timeout. Compiled languages get a compile pass first, with the compiler error cleaned up before it reaches you. Results stream out one line at a time, so a segfault or timeout still shows you the tests that passed before it.

## Sage watches you type

Sage isn't a hint button you go looking for. It reads your editor continuously and speaks up on its own when it thinks you're stuck.

The client tracks your keystrokes locally and looks for stuck-patterns rather than pestering the model on every change:

| Pattern | What it means |
|---|---|
| `repeated_failures` | Two failed runs with >93% identical code — you're re-submitting the same thing hoping for a different result |
| `same_error` | The identical error message twice running |
| `idle_untouched` | Over a minute on the starter code without writing anything — you don't know where to begin |
| `idle_mid_edit` | 45 seconds of stillness partway through an attempt |
| `churn` | 25+ edits in a minute with no net change — typing and deleting the same line |
| `long_task` | Several minutes in, still failing |

Only when one of these trips does the client send your code to the server, where Sage looks at it and makes its own call about whether interrupting is actually useful. Most of the time the right answer is silence, and it's prompted to prefer that — a wrong interruption is worse than none. When it does speak, it points at the specific thing it sees ("your total resets each loop"), never generic encouragement, and never the answer.

### Talking to it

The panel is a real conversation — type a question, hit Enter. Sage sees the task, your current code, and what it last printed, so "why is my loop only running once?" gets an answer about *your* loop. **Questions are free and unlimited**, because a beginner asking what `%` does shouldn't have to spend anything. It won't write your solution — ask it to and it'll warmly refuse and give you the next concrete step instead.

Three things cost nothing: Sage noticing you're stuck, asking it questions, and its note on how you solved a drill. The one thing that costs is the **hint ladder** — three escalating levels (intuition → technique → concrete walkthrough), each trimming 15% off that item's points.

`⌘/Ctrl+K` opens the panel; the orb is clickable any time.

Rate-limited to one remark per 25 seconds, with recent remarks fed back into the prompt so it doesn't repeat itself. Without an API key the watcher still runs, but it can only act on the unambiguous signals and says so plainly rather than faking insight.

## Layout

| Path | Role |
|---|---|
| `server/index.js` | Routes, auth, phase gating, points and streaks |
| `server/languages.js` | Per-language starter + harness codegen, toolchain probing |
| `server/judge.js` | Sandboxed execution: `runTests` (daily) and `runProgram` (drills) |
| `server/drills.js` | Drill sourcing, reference verification, output diffing |
| `server/ai.js` | Claude API: drill authoring, live stuck-detection, hints, post-solve review — all structured output |
| `data/drills.json` | The offline 10-rung curriculum, all four languages |
| `data/problems.json` | Daily problems: statement, signature, examples, hidden tests, hints |
| `public/` | Single-page client; CodeMirror vendored into `public/vendor` |

## Notes

- **The judge is process isolation, not a hardened sandbox.** Fine for yourself or a trusted group. For public traffic, run it in a locked-down container with no network and a read-only filesystem.
- The daily problem rotates by UTC day. Add entries to `data/problems.json` to extend the rotation — supply a `signature` and the starters for all four languages are generated for you.
- CodeMirror is vendored rather than pulled from a CDN so the editor works offline; if it somehow fails to load, the editor degrades to a plain textarea instead of a blank pane.
