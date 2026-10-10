'use strict';
// Army mode: the lead Claude of a chat turn (Quality with the octopus on) sends up to five Haiku workers, each a
// separate "claude -p" run in its own background tabs. This file keeps the runs: army_start and army_wait, the worker
// processes, the trail the panel shows, the budgets and time limits, and Stop. The helper wires it in
// (claude-in-zen-host.js); the tab and budget rules for each worker call are in lib/armyguard.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const P = require('./paths');
const log = require('./log');
const guard = require('./guard');
const { LIMITS, hostOf } = require('./armyguard');
const { workerArgs } = require('./chatargs');

const MAX_TASKS = 5;
const MAX_RUNS_PER_TURN = 2;
const TRAIL_MS = 700;   // action updates go to the panel at most this often per run
const SETTINGS_FILE = path.join(P.ARMY_DIR, 'settings.json');

// Kills a process and everything it started. sync: for shutdown, so it is done before the helper exits.
function killTree(child, sync) {
  if (!child || !child.pid) return;
  const running = child.exitCode === null && child.signalCode === null;
  if (process.platform === 'win32') {
    if (!running) return;   // a finished pid may already belong to another process
    const args = ['/PID', String(child.pid), '/T', '/F'];
    try {
      if (sync) execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      else execFile('taskkill', args, { windowsHide: true }, () => {});
    } catch {}
    return;
  }
  // Workers start in their own process group: killing the group takes their tool server and anything else along.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { if (running) { try { child.kill('SIGKILL'); } catch {} } }
}

function cleanUrl(u) {
  try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
}

// deps: { callAddon(tool, args, extra, ms) -> Promise<{ ok, result, error }>, sendAddon(msg), emit(chatRun, event),
// currentChat() -> the running chat turn, findClaude(), envFor(accountKey), mcpServer: path of zen-mcp.js, limitRe }
function createArmy(deps) {
  const runs = new Map();     // run id -> run
  const tokens = new Map();   // worker token -> worker
  let runSeq = 0;

  // Leftovers of a helper that did not stop cleanly: their tokens are dead anyway.
  try {
    fs.mkdirSync(P.ARMY_DIR, { recursive: true });
    for (const f of fs.readdirSync(P.ARMY_DIR)) if (/^r\d+-w\d+\.json$/.test(f)) fs.unlinkSync(path.join(P.ARMY_DIR, f));
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ permissions: { deny: guard.denyRules() } }, null, 1));
  } catch (e) { log.error('army folder', e.message); }

  // ---------------------------------------------------------------- trail

  function snapshot(w) {
    return {
      id: w.id, goal: w.goal.slice(0, 120), state: w.state, tab_id: w.mainTab, host: w.host || '', action: w.action || '',
      steps: w.steps, ms: w.ended ? w.ms : Date.now() - w.started, error: String(w.error || '').slice(0, 200), sources: w.sources.slice(0, 5),
    };
  }

  function trail(run, finished) {
    if (run.finishedSent) return;
    clearTimeout(run.trailTimer);
    run.trailTimer = null;
    run.lastTrail = Date.now();
    const started = run.round === 1 && !run.trailSent;
    run.trailSent = true;
    if (finished) run.finishedSent = true;
    deps.emit(run.chat, { kind: 'army', run: run.id, round: run.round, started, finished: !!finished, workers: run.workers.map(snapshot) });
  }

  // A worker did something: tell the panel now, or at the next 700 ms mark.
  function trailSoon(run) {
    if (run.finishedSent || run.trailTimer) return;
    const wait = TRAIL_MS - (Date.now() - run.lastTrail);
    if (wait <= 0) return trail(run);
    run.trailTimer = setTimeout(() => trail(run), wait);
  }

  // ---------------------------------------------------------------- workers

  function cfgFile(w) { return path.join(P.ARMY_DIR, `${w.run.id}-${w.id}.json`); }

  // quiet: Stop ends the whole run at once with one army_end and one trail event.
  function endWorker(w, state, error, opts) {
    if (w.ended) return;
    const o = opts || {};
    w.ended = true;
    w.state = state;
    w.error = String(error || '').slice(0, 200);
    w.ms = Date.now() - w.started;
    clearTimeout(w.hardTimer);
    tokens.delete(w.token);
    killTree(w.child, o.sync);
    try { fs.unlinkSync(cfgFile(w)); } catch {}
    log.info(`army ${w.run.id} ${w.id} ${state}${w.error ? `: ${w.error}` : ''} (${w.steps} steps, ${w.ms} ms)`);
    if (o.quiet) return;
    deps.sendAddon({ type: 'army_end', run: w.run.id, worker: w.id });
    const run = w.run;
    if (run.workers.every(x => x.ended)) endRun(run);
    else { trail(run); wake(run); }
  }

  function endRun(run) {
    if (run.over) return;
    run.over = true;
    clearTimeout(run.runTimer);
    trail(run, true);
    wake(run);
  }

  function wake(run) {
    const ws = run.waiters.splice(0);
    for (const f of ws) f();
  }

  function spawnWorker(w, exe) {
    const run = w.run;
    const cfg = {
      mcpServers: {
        'claude-in-zen': {
          type: 'stdio', command: process.execPath, args: [deps.mcpServer],
          env: { CLAUDE_IN_ZEN_CLIENT: `Army worker ${w.id}`, CLAUDE_IN_ZEN_ARMY_TOKEN: w.token },
          alwaysLoad: true,
        },
      },
    };
    let child;
    try {
      fs.writeFileSync(cfgFile(w), JSON.stringify(cfg, null, 2));
      child = spawn(exe, workerArgs(cfgFile(w), SETTINGS_FILE, LIMITS), {
        cwd: P.WORKSPACE,
        env: { ...deps.envFor(run.chat.key), ENABLE_TOOL_SEARCH: 'false' },
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',   // its own process group, so Stop can kill all of it
      });
    } catch (e) {
      return endWorker(w, 'failed', `Could not start Claude Code: ${e.message}`);
    }
    w.child = child;
    w.state = 'working';
    w.hardTimer = setTimeout(() => endWorker(w, 'failed', 'timed out'), LIMITS.hardMs);
    child.stdin.on('error', () => {});
    let prompt = `Your task: ${w.goal}\n\nStart in tab ${w.mainTab} (${w.url}).`;
    if (w.report) prompt += `\nReport: ${w.report}`;
    child.stdin.end(prompt, 'utf8');

    let buf = '', stderr = '', result = null;
    const onLine = line => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev && ev.type === 'result') result = ev;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.on('error', e => endWorker(w, 'failed', `Could not run Claude Code: ${e.message}`));
    child.on('close', code => {
      if (buf) onLine(buf);
      const text = result ? String(result.result || (Array.isArray(result.errors) && result.errors.join(' ')) || '') : '';
      const last = stderr.trim().split('\n').pop() || '';
      if (result && !result.is_error && result.subtype === 'success') {
        w.report = text.slice(0, 4000);
        return endWorker(w, 'done');
      }
      // Only an error is read as a usage limit: a good report may well mention a page's rate limit.
      if (deps.limitRe.test(result ? text : last)) return endWorker(w, 'failed', 'This account hit its usage limit.');
      if (result) return endWorker(w, 'failed', text || result.subtype || 'Claude Code reported an error.');
      endWorker(w, 'failed', last || `Claude Code exited with code ${code}.`);
    });
  }

  // ---------------------------------------------------------------- the lead's tools

  function validTasks(tasks) {
    if (!Array.isArray(tasks) || !tasks.length) throw new Error('Give 1 to 5 tasks.');
    if (tasks.length > MAX_TASKS) throw new Error('Give at most 5 tasks.');
    return tasks.map((t, i) => {
      const n = i + 1;
      const o = t && typeof t === 'object' ? t : {};
      const goal = String(o.goal || '').trim().slice(0, 600);
      if (!goal) throw new Error(`Task ${n} needs a goal.`);
      const query = String(o.query || '').trim().slice(0, 200);
      let url = '';
      if (o.start_url) {
        url = cleanUrl(o.start_url);
        if (!url) throw new Error(`Task ${n}: start_url must be an http(s) address.`);
      } else if (query) url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      else throw new Error(`Task ${n} needs a start_url or a query.`);
      return { goal, url, report: String(o.report || '').trim().slice(0, 300) };
    });
  }

  async function start(args) {
    const chat = deps.currentChat();
    if (!chat || chat.finished || !chat.army) throw new Error('Army mode is off. The user turns it on with the octopus next to Quality.');
    const tasks = validTasks(args && args.tasks);
    chat.armyRuns = chat.armyRuns || [];
    const going = chat.armyRuns.find(r => !r.over);
    if (going) throw new Error(`Run ${going.id} is still going: call army_wait first.`);
    if (chat.armyRuns.length >= MAX_RUNS_PER_TURN) throw new Error(`This message already used ${MAX_RUNS_PER_TURN} army runs. Answer with what you have.`);
    const exe = deps.findClaude();
    if (!exe) throw new Error('Claude Code is not installed on this PC.');

    const run = { id: `r${++runSeq}`, chat, chatId: chat.id, round: chat.armyRuns.length + 1, workers: [], over: false, started: Date.now(),
      waiters: [], reported: new Set(), lastTrail: 0, trailTimer: null, trailSent: false, finishedSent: false, runTimer: null };
    chat.armyRuns.push(run);
    runs.set(run.id, run);
    run.workers = tasks.map((t, i) => {
      const w = { id: `w${i + 1}`, run, token: crypto.randomBytes(16).toString('hex'), goal: t.goal, url: t.url, report: t.report,
        tabs: new Set(), mainTab: null, calls: 0, navs: 0, extra: 0, state: 'starting', steps: 0, sources: [], action: '', host: '',
        error: '', started: Date.now(), child: null, ended: false, urls: {} };
      tokens.set(w.token, w);
      return w;
    });
    log.info(`army ${run.id} for chat ${chat.id}: ${run.workers.length} worker(s), round ${run.round}`);
    run.runTimer = setTimeout(() => {
      for (const w of run.workers) endWorker(w, 'failed', 'The whole run took too long and was stopped.');
    }, LIMITS.runMs);
    trail(run);

    // Each worker's first tab, all at once, in the background.
    await Promise.all(run.workers.map(async w => {
      const res = await deps.callAddon('tab_open', { url: w.url, active: false }, { source: `Army worker ${w.id}`, army: { run: run.id, worker: w.id } }, 45000);
      if (w.ended) return;
      if (!res || !res.ok || !res.result || !Number.isFinite(Number(res.result.tab_id))) {
        return endWorker(w, 'failed', (res && res.error) || 'The tab did not open.');
      }
      w.mainTab = Number(res.result.tab_id);
      w.tabs.add(w.mainTab);
      w.url = res.result.url || w.url;
      w.urls[w.mainTab] = w.url;
      w.host = hostOf(w.url);
    }));
    // Stopped while the tabs opened: close whatever opened since.
    if (run.stopped) {
      if (run.workers.some(w => w.mainTab != null)) deps.sendAddon({ type: 'army_end', run: run.id });
      throw new Error('The run was stopped.');
    }
    for (const w of run.workers) if (!w.ended) spawnWorker(w, exe);
    trail(run);
    return {
      run_id: run.id,
      workers: run.workers.map(w => ({ id: w.id, goal: w.goal, tab_id: w.mainTab, url: w.url, state: w.state, ...(w.error ? { error: w.error } : {}) })),
      note: 'Workers are running in background tabs. Call army_wait with this run_id.',
    };
  }

  async function wait(args) {
    const id = String((args && args.run_id) || '');
    const run = runs.get(id);
    if (!run) throw new Error(`There is no army run ${id || '(none given)'}. Use the run_id army_start returned.`);
    const s = Number(args.seconds);
    const secs = Math.min(Math.max(Number.isFinite(s) && s > 0 ? s : 60, 5), 110);
    if (!run.workers.every(w => w.ended)) {
      await new Promise(resolve => {
        const t = setTimeout(() => { run.waiters = run.waiters.filter(f => f !== go); resolve(); }, secs * 1000);
        const go = () => {
          if (!run.workers.every(w => w.ended)) return run.waiters.push(go);   // one worker ended: keep waiting for the rest
          clearTimeout(t); resolve();
        };
        run.waiters.push(go);
      });
    }
    const done = run.workers.filter(w => w.ended).length, total = run.workers.length;
    const lines = [done === total ? `Run ${run.id}: All workers finished.` : `Run ${run.id}: ${done} of ${total} workers finished.`];
    const fresh = run.workers.filter(w => w.ended && !run.reported.has(w.id));
    for (const w of fresh) {
      run.reported.add(w.id);
      lines.push('', `## ${w.id} · ${w.state} · ${w.goal}`, w.state === 'done' ? (w.report || '(No report.)') : (w.error || 'No report.'));
      if (w.sources.length) lines.push(`Sources: ${w.sources.join(', ')}`);
    }
    const rest = run.workers.filter(w => !fresh.includes(w));
    if (rest.length) lines.push('');
    for (const w of rest) {
      lines.push(w.ended ? `- ${w.id} · ${w.state} · reported earlier` : `- ${w.id} · ${w.state} · ${w.action || 'starting'}`);
    }
    return { title: `Army run ${run.id}`, text: lines.join('\n'), finished: done === total, done, total };
  }

  // ---------------------------------------------------------------- the helper's hooks

  // Stop, Cancel, shutdown, or the lead answered without waiting: every worker of that chat turn stops now.
  function stopChat(chat, sync) {
    for (const run of (chat && chat.armyRuns) || []) {
      if (run.over) continue;
      run.stopped = true;
      for (const w of run.workers) endWorker(w, 'stopped', '', { quiet: true, sync });
      deps.sendAddon({ type: 'army_end', run: run.id });
      endRun(run);
    }
  }

  // The worker a tool server's hello names, while it still runs.
  function workerFor(token) {
    const w = tokens.get(String(token || ''));
    return w && !w.ended ? w : null;
  }

  return { start, wait, stopChat, workerFor, trailSoon, runs };
}

module.exports = { createArmy, killTree, MAX_TASKS, MAX_RUNS_PER_TURN };
