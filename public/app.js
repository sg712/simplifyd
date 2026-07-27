/* DailyCode frontend */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    user: null,
    problem: null,
    editor: null,
    failedAttempts: 0,     // consecutive failed runs/submits since last edit success
    lastActivity: Date.now(),
    sageNudged: false,     // only auto-nudge once per session
    solvedToday: false,
    hintsUsed: 0,
    maxHints: 3,
  };

  // ---------- tiny helpers ----------

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data;
  }

  function toast(msg, kind = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast ${kind}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // minimal markdown: `code`, **bold**, paragraphs
  function md(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .split(/\n\n+/)
      .map((p) => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
      .join('');
  }

  // ---------- auth ----------

  let authMode = 'login';
  $('tab-login').onclick = () => setAuthMode('login');
  $('tab-register').onclick = () => setAuthMode('register');
  function setAuthMode(mode) {
    authMode = mode;
    $('tab-login').classList.toggle('active', mode === 'login');
    $('tab-register').classList.toggle('active', mode === 'register');
    $('auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
    $('auth-error').textContent = '';
  }

  $('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await api(`/api/${authMode}`, {
        method: 'POST',
        body: { username: $('auth-username').value.trim(), password: $('auth-password').value },
      });
      state.user = data.user;
      enterApp(authMode === 'register');
    } catch (err) {
      $('auth-error').textContent = err.message;
    }
  };

  $('btn-logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    location.reload();
  };

  // ---------- navigation ----------

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
      $('panel-solve').classList.toggle('hidden', btn.dataset.nav !== 'solve');
      $('panel-board').classList.toggle('hidden', btn.dataset.nav !== 'board');
      if (btn.dataset.nav === 'board') loadLeaderboard();
      if (state.editor) state.editor.refresh();
    };
  });

  // ---------- app boot ----------

  async function boot() {
    try {
      const data = await api('/api/me');
      state.user = data.user;
      enterApp(false);
    } catch {
      $('view-auth').classList.remove('hidden');
    }
  }

  function enterApp(isNewUser) {
    $('view-auth').classList.add('hidden');
    $('view-app').classList.remove('hidden');
    refreshChips();
    $('sage-enabled').checked = state.user.assistantEnabled;
    loadProblem();

    // First-time Sage opt-in prompt
    if (!state.user.assistantEnabled && (isNewUser || !localStorage.getItem('sagePrompted'))) {
      $('sage-optin').classList.remove('hidden');
    }
  }

  function refreshChips() {
    $('chip-user').textContent = state.user.username;
    $('chip-points').textContent = `⭐ ${state.user.points}`;
    $('chip-streak').textContent = `🔥 ${state.user.streak}`;
  }

  // ---------- problem ----------

  async function loadProblem() {
    const data = await api('/api/problem/today');
    const p = data.problem;
    state.problem = p;
    state.solvedToday = data.today.solved;
    state.hintsUsed = data.today.hintsUsed;
    state.maxHints = data.maxHints;

    $('p-title').textContent = p.title;
    $('p-difficulty').textContent = p.difficulty;
    $('p-difficulty').className = `badge badge-${p.difficulty.toLowerCase()}`;
    $('p-points').textContent = `${p.points} pts`;
    $('p-statement').innerHTML = md(p.statement);
    $('p-examples').innerHTML = p.examples
      .map(
        (ex) => `<div class="example-block">
          <div><span class="lbl">input:</span> ${esc(ex.args.map((a) => JSON.stringify(a)).join(', '))}</div>
          <div><span class="lbl">output:</span> ${esc(JSON.stringify(ex.expected))}</div>
        </div>`
      )
      .join('');
    $('p-constraints').innerHTML = (p.constraints || []).map((c) => `<li>${esc(c)}</li>`).join('');

    startCountdown(data.msUntilNext);
    initEditor(p);
    updateSageCost();

    if (state.solvedToday) {
      logConsole(`<div class="t-accepted">✔ Solved today (+${data.today.awarded} pts). New problem in ${fmtMs(data.msUntilNext)} — feel free to keep tinkering.</div>`, true);
    }
  }

  function fmtMs(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }

  function startCountdown(msLeft) {
    const target = Date.now() + msLeft;
    const tick = () => {
      const left = target - Date.now();
      if (left <= 0) return location.reload();
      const h = String(Math.floor(left / 3600000)).padStart(2, '0');
      const m = String(Math.floor((left % 3600000) / 60000)).padStart(2, '0');
      const s = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
      $('p-countdown').textContent = `⏳ Next problem in ${h}:${m}:${s}`;
    };
    tick();
    clearInterval(state._cd);
    state._cd = setInterval(tick, 1000);
  }

  // ---------- editor ----------

  function initEditor(p) {
    const saved = localStorage.getItem(`code:${p.id}`);
    if (!state.editor) {
      state.editor = CodeMirror($('editor-host'), {
        value: saved || p.starterCode,
        mode: 'javascript',
        theme: 'material-darker',
        lineNumbers: true,
        autoCloseBrackets: true,
        matchBrackets: true,
        indentUnit: 2,
        tabSize: 2,
      });
      state.editor.on('change', () => {
        state.lastActivity = Date.now();
        localStorage.setItem(`code:${state.problem.id}`, state.editor.getValue());
      });
    } else {
      state.editor.setValue(saved || p.starterCode);
    }
  }

  $('btn-reset').onclick = () => {
    if (confirm('Reset to starter code?')) {
      state.editor.setValue(state.problem.starterCode);
    }
  };

  // ---------- console ----------

  function logConsole(html, clear = false) {
    const c = $('console');
    if (clear) c.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    while (wrap.firstChild) c.appendChild(wrap.firstChild);
    c.scrollTop = c.scrollHeight;
  }

  function renderResults(results) {
    return results
      .map((r, i) => {
        const argStr = esc(r.args.map((a) => JSON.stringify(a)).join(', '));
        if (r.pass) return `<div class="t-pass">✔ Test ${i + 1} — ${argStr}</div>`;
        if (r.error) return `<div class="t-fail">✘ Test ${i + 1} — ${argStr}\n   ${esc(r.error)}</div>`;
        return `<div class="t-fail">✘ Test ${i + 1} — ${argStr}\n   expected ${esc(JSON.stringify(r.expected))}, got ${esc(JSON.stringify(r.actual))}</div>`;
      })
      .join('');
  }

  // ---------- run & submit ----------

  $('btn-run').onclick = async () => {
    setBusy(true);
    logConsole('<div class="t-info">Running examples…</div>', true);
    try {
      const data = await api('/api/run', { method: 'POST', body: { code: state.editor.getValue() } });
      if (!data.ok) {
        logConsole(`<div class="t-fail">${esc(data.error)}</div>`, true);
        recordFailure();
      } else {
        logConsole(renderResults(data.results), true);
        if (data.allPass) {
          logConsole('<div class="t-pass">All examples pass — hit Submit to run the hidden tests!</div>');
          state.failedAttempts = 0;
        } else {
          recordFailure();
        }
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  $('btn-submit').onclick = async () => {
    if (state.solvedToday) return toast('Already solved today — come back tomorrow!', '');
    setBusy(true);
    logConsole('<div class="t-info">Submitting… running all tests…</div>', true);
    try {
      const data = await api('/api/submit', { method: 'POST', body: { code: state.editor.getValue() } });
      if (!data.ok) {
        logConsole(`<div class="t-fail">${esc(data.error)}</div>`, true);
        recordFailure();
      } else if (data.accepted) {
        state.solvedToday = true;
        state.user.points = data.points;
        state.user.streak = data.streak;
        refreshChips();
        hideSage();
        logConsole(
          `<div class="t-accepted">🎉 Accepted! ${data.passed}/${data.total} tests passed</div>` +
          `<div class="t-pass">+${data.award} points${data.hintsUsed ? ` (after ${data.hintsUsed} hint${data.hintsUsed > 1 ? 's' : ''})` : ''} · streak ${data.streak} 🔥</div>` +
          `<div class="t-info">See where you landed on the leaderboard →</div>`,
          true
        );
        toast(`+${data.award} points!`, 'success');
      } else {
        const f = data.firstFailure;
        let detail;
        if (f.hidden) {
          detail = f.error
            ? `A hidden test crashed:\n${esc(f.error)}`
            : 'Failed on a hidden test. Think about edge cases…';
        } else {
          detail = f.error
            ? `Test (${esc(f.args.map((a) => JSON.stringify(a)).join(', '))}) crashed:\n${esc(f.error)}`
            : `Test (${esc(f.args.map((a) => JSON.stringify(a)).join(', '))}): expected ${esc(JSON.stringify(f.expected))}, got ${esc(JSON.stringify(f.actual))}`;
        }
        logConsole(
          `<div class="t-fail">✘ ${data.passed}/${data.total} tests passed</div><div class="t-fail">${detail}</div>`,
          true
        );
        recordFailure();
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  function setBusy(busy) {
    $('btn-run').disabled = busy;
    $('btn-submit').disabled = busy || state.solvedToday;
  }

  // ---------- Sage: the AI coach ----------

  const sageState = { open: false, lastRunSummary: null };

  function sageEnabled() {
    return $('sage-enabled').checked;
  }

  $('sage-enabled').onchange = async (e) => {
    try {
      const data = await api('/api/assistant/toggle', { method: 'POST', body: { enabled: e.target.checked } });
      state.user.assistantEnabled = data.assistantEnabled;
      if (!data.assistantEnabled) hideSage();
      toast(data.assistantEnabled ? '🔮 Sage is watching your back' : 'Sage disabled — solo mode', '');
    } catch (err) {
      toast(err.message, 'error');
      e.target.checked = !e.target.checked;
    }
  };

  $('sage-optin-yes').onclick = async () => {
    $('sage-optin').classList.add('hidden');
    localStorage.setItem('sagePrompted', '1');
    $('sage-enabled').checked = true;
    $('sage-enabled').dispatchEvent(new Event('change'));
  };
  $('sage-optin-no').onclick = () => {
    $('sage-optin').classList.add('hidden');
    localStorage.setItem('sagePrompted', '1');
  };

  function recordFailure() {
    state.failedAttempts += 1;
    maybeSummonSage('failures');
  }

  // Sage "shows up sometimes": after repeated failures, or after a long stuck pause.
  function maybeSummonSage(reason) {
    if (!sageEnabled() || state.solvedToday || sageState.open) return;
    if (state.hintsUsed >= state.maxHints) return;

    const shouldAppear =
      (reason === 'failures' && state.failedAttempts >= 2) ||
      (reason === 'idle' && !state.sageNudged);
    if (!shouldAppear) return;

    const messages = {
      failures: [
        'Hmm, that one’s putting up a fight. Want a nudge?',
        'I’ve been watching — I think I see where it’s going sideways.',
        'Two strikes! Want to talk it through?',
      ],
      idle: [
        'Staring contest with the cursor? I can help.',
        'Still thinking? Sometimes a small hint saves twenty minutes.',
      ],
    };
    const pool = messages[reason];
    showOrb(pool[Math.floor(Math.random() * pool.length)]);
    if (reason === 'idle') state.sageNudged = true;
  }

  // idle watcher: nudge after 90s of no edits (only if code differs from starter)
  setInterval(() => {
    if (!state.problem || state.solvedToday || !sageEnabled()) return;
    const idleFor = Date.now() - state.lastActivity;
    const touched = state.editor && state.editor.getValue() !== state.problem.starterCode;
    if (idleFor > 90000 && touched) maybeSummonSage('idle');
  }, 5000);

  function showOrb(bubbleText) {
    const orb = $('sage-orb');
    orb.classList.remove('hidden');
    orb.classList.remove('wiggle');
    void orb.offsetWidth; // restart animation
    orb.classList.add('wiggle');
    if (bubbleText) {
      const b = $('sage-bubble');
      b.textContent = bubbleText;
      b.classList.remove('hidden');
      clearTimeout(b._t);
      b._t = setTimeout(() => b.classList.add('hidden'), 8000);
    }
  }

  function hideSage() {
    $('sage-orb').classList.add('hidden');
    $('sage-panel').classList.add('hidden');
    sageState.open = false;
  }

  $('sage-orb').onclick = () => {
    $('sage-bubble').classList.add('hidden');
    $('sage-panel').classList.remove('hidden');
    $('sage-orb').classList.add('hidden');
    sageState.open = true;
    if (!$('sage-messages').childElementCount) {
      addSageMsg(null, 'Hey, I’m Sage 🔮 — I watch quietly and only step in when you want. Each hint trims a bit off today’s points. Ready when you are.');
    }
    updateSageCost();
  };

  $('sage-close').onclick = () => {
    $('sage-panel').classList.add('hidden');
    sageState.open = false;
    if (sageEnabled() && !state.solvedToday) $('sage-orb').classList.remove('hidden');
  };

  function addSageMsg(level, text, thinking = false) {
    const div = document.createElement('div');
    div.className = 'sage-msg' + (thinking ? ' thinking' : '');
    div.innerHTML = (level ? `<span class="lvl">Hint ${level}</span>` : '') + md(text);
    $('sage-messages').appendChild(div);
    $('sage-messages').scrollTop = $('sage-messages').scrollHeight;
    return div;
  }

  function updateSageCost() {
    const left = state.maxHints - state.hintsUsed;
    $('sage-cost').textContent = left > 0 ? `(−15% pts · ${left} left)` : '(none left)';
    $('sage-hint-btn').disabled = left <= 0;
    $('sage-status').textContent = state.hintsUsed ? `${state.hintsUsed}/${state.maxHints} hints used` : '';
  }

  $('sage-hint-btn').onclick = async () => {
    const btn = $('sage-hint-btn');
    btn.disabled = true;
    const q = $('sage-question').value.trim();
    $('sage-question').value = '';
    if (q) addSageMsg(null, `**You:** ${q}`);
    const pending = addSageMsg(null, 'Sage is reading your code…', true);
    try {
      const data = await api('/api/assistant/hint', {
        method: 'POST',
        body: { code: state.editor.getValue(), message: q || undefined },
      });
      pending.remove();
      state.hintsUsed = data.hintLevel;
      addSageMsg(data.hintLevel, data.hint);
      if (data.source === 'static') {
        $('sage-status').textContent = 'offline mode';
      }
    } catch (err) {
      pending.remove();
      addSageMsg(null, `⚠️ ${err.message}`);
    } finally {
      updateSageCost();
    }
  };

  // ---------- leaderboard ----------

  async function loadLeaderboard() {
    const data = await api('/api/leaderboard');
    $('board-body').innerHTML = data.leaderboard
      .map((row) => {
        const me = state.user && row.username === state.user.username;
        const rc = row.rank <= 3 ? `rank-${row.rank}` : '';
        return `<tr class="${me ? 'me' : ''}">
          <td class="${rc}">${row.rank}</td>
          <td>${esc(row.username)}${me ? ' <span class="t-info">(you)</span>' : ''}</td>
          <td>${row.points}</td>
          <td>${row.streak ? `🔥 ${row.streak}` : '—'}</td>
          <td>${row.solvedTotal}</td>
          <td>${row.solvedToday ? '✅' : '·'}</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="6" class="t-info">Nobody yet. Be the first!</td></tr>';
  }

  boot();
})();
