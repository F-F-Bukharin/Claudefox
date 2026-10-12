'use strict';
// Claude in Zen: the tool router every call goes through (panel, console and helper), the debug-port warning,
// the toolbar badge, and the console hook for manual testing.

// ---------------------------------------------------------------- debug port
// Rule 7: warn when the debug port is on. The add-on never opens it.

async function probeDebugPort() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  let on = false;
  try {
    await fetch(CIZ.DEBUG_PORT_URL, { signal: ctl.signal, cache: 'no-store' });
    on = true;
  } catch { on = false; }
  clearTimeout(timer);
  const next = on ? 'on' : 'off';
  if (cizState.get().debugPort !== next) {
    await cizState.set({ debugPort: next });
    if (on) await cizState.addLog('warn', 'Debug port 9222 is open: any local program can drive this browser while it is.');
  }
}

// ---------------------------------------------------------------- router
// Every tool call, from any channel (panel, console, helper), goes through here.

// The tools themselves are in lib/tools.js (CIZ_TOOLS).

// army: { run, worker } for an army worker's call (lib/army.js), else null.
async function dispatch(tool, args, source, army) {
  const s = cizState.get();
  if (s.agent !== 'active') return { ok: false, error: 'Agent is stopped. Press Start in the Claude in Zen panel.' };
  if (!s.signedIn) return { ok: false, error: 'Not signed in. Press "Sign in with Claude" in the panel.' };
  // Only the helper's army field says a worker is calling: a caller's own __army in the arguments is dropped.
  if (!army && args && Object.prototype.hasOwnProperty.call(args, '__army')) { args = Object.assign({}, args); delete args.__army; }
  if (army) {
    try { cizArmy.check(tool, args, army); } catch (e) { return { ok: false, error: e.message }; }
    // The tools see which worker calls; a worker's new tab always opens in the background.
    args = Object.assign({}, args, { __army: army }, tool === 'tab_open' ? { active: false } : {});
    cizArmy.touch(args.tab_id);
  }
  const fn = CIZ_TOOLS[tool];
  if (!fn) return { ok: false, error: `Unknown tool: ${tool}` };

  const id = nextActionId++;
  const controller = new AbortController();
  pendingActions.set(id, { cmd: tool, controller, startedAt: Date.now() });
  await cizState.set({ pending: pendingActions.size });
  await cizState.addLog('action', `${source}: ${tool}`);

  const aborted = new Promise((_, reject) =>
    controller.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  try {
    const result = await Promise.race([fn(args, controller.signal), aborted]);
    if (result && (result.clicked || result.filled || result.typed)) {
      const what = result.clicked || `${result.filled || result.typed} into the field`;
      await cizState.addLog('action', `${tool}: ${String(what).slice(0, 140)}${result.navigated ? ` → ${String(result.url || '').slice(0, 80)}` : ''}`);
    }
    if (army) {   // tab_open registered its tab itself (lib/tools.js), before the page loaded
      if (tool === 'tab_close') cizArmy.unregister(args.tab_id);
      else if (tool !== 'tab_open') cizArmy.touch(args.tab_id);
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    pendingActions.delete(id);
    if (cizState.get().agent === 'active') await cizState.set({ pending: pendingActions.size });
  }
}

// ---------------------------------------------------------------- badge

function updateBadge(s) {
  let text = '', color = '#666';
  if (s.agent === 'stopped') { text = 'OFF'; color = '#b3261e'; }
  else if (s.debugPort === 'on') { text = '!'; color = '#c77700'; }
  else if (s.signedIn) { text = ''; }
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
}

// Exposed for manual testing from about:debugging → Inspect → console:
//   await cizDebug.call('tabs_list')
window.cizDebug = {
  call: (tool, args) => dispatch(tool, args || {}, 'console'),
  state: () => cizState.get(),
};
