'use strict';
// Claudefox: the tool router every call goes through (panel, console and helper), the debug-port warning,
// the toolbar badge, and the console hook for manual testing.

// ---------------------------------------------------------------- debug port
// Rule 7: warn when the debug port is on. The add-on never opens it.

async function probeDebugPort() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  let on = false;
  try {
    await fetch(CFX.DEBUG_PORT_URL, { signal: ctl.signal, cache: 'no-store' });
    on = true;
  } catch { on = false; }
  clearTimeout(timer);
  const next = on ? 'on' : 'off';
  if (cfxState.get().debugPort !== next) {
    await cfxState.set({ debugPort: next });
    if (on) await cfxState.addLog('warn', 'Debug port 9222 is open: any local program can drive this browser while it is.');
  }
}

// ---------------------------------------------------------------- router
// Every tool call, from any channel (panel, console, helper), goes through here.

// The tools themselves are in lib/pageTools.js (CFX_TOOLS).

// Tools whose answer shows Claude page content (or the tab list): after one succeeds, the message has read a page, and a click
// that would post a form or leave the site asks first (lib/siteGate.js).
const CFX_READING_TOOLS = new Set(['tabs_list', 'read_page', 'get_page_text', 'find', 'analyze_page', 'get_selection', 'network_log', 'console_log']);

// army: { run, worker } for an army worker's call (lib/army.js), else null.
// What a scheduled macro's turn may call (E8). The rest is refused: no clicks, typing, forms, files, army.
const CFX_SCHEDULED_TOOLS = new Set(['tabs_list', 'tab_open', 'navigate', 'get_page_text', 'read_page', 'find', 'analyze_page', 'get_selection', 'screenshot', 'scroll']);

// scheduled: true for a call the helper makes during a scheduled macro's turn.
async function dispatch(tool, args, source, army, scheduled) {
  const s = cfxState.get();
  if (s.agent !== 'active') return { ok: false, error: 'Agent is stopped. Press Start in the Claudefox panel.' };
  if (!s.signedIn) return { ok: false, error: 'Not signed in. Press "Sign in with Claude" in the panel.' };
  // Only the helper's army field says a worker is calling: a caller's own __army in the arguments is dropped.
  if (!army && args && Object.prototype.hasOwnProperty.call(args, '__army')) { args = Object.assign({}, args); delete args.__army; }
  if (army) {
    try { cfxArmy.check(tool, args, army); } catch (e) { return { ok: false, error: e.message }; }
    // The tools see which worker calls; a worker's new tab always opens in the background.
    args = Object.assign({}, args, { __army: army }, tool === 'tab_open' ? { active: false } : {});
    cfxArmy.touch(args.tab_id);
  }
  if (scheduled && !CFX_SCHEDULED_TOOLS.has(tool)) return { ok: false, error: 'Scheduled macros only read pages.' };
  const fn = CFX_TOOLS[tool];
  if (!fn) return { ok: false, error: `Unknown tool: ${tool}` };

  const id = nextActionId++;
  const controller = new AbortController();
  pendingActions.set(id, { cmd: tool, controller, startedAt: Date.now() });
  await cfxState.set({ pending: pendingActions.size });
  await cfxState.addLog('action', `${source}: ${tool}`);

  const aborted = new Promise((_, reject) =>
    controller.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  try {
    const result = await Promise.race([fn(args, controller.signal), aborted]);
    if (result && (result.clicked || result.filled || result.typed)) {
      const what = result.clicked || `${result.filled || result.typed} into the field`;
      await cfxState.addLog('action', `${tool}: ${String(what).slice(0, 140)}${result.navigated ? ` → ${String(result.url || '').slice(0, 80)}` : ''}`);
    }
    if (army) {   // tab_open registered its tab itself (lib/pageTools.js), before the page loaded
      if (tool === 'tab_close') cfxArmy.unregister(args.tab_id);
      else if (tool !== 'tab_open') cfxArmy.touch(args.tab_id);
    }
    if (CFX_READING_TOOLS.has(tool)) cfxSiteGate.markRead();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    pendingActions.delete(id);
    if (cfxState.get().agent === 'active') await cfxState.set({ pending: pendingActions.size });
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
//   await cfxDebug.call('tabs_list')
window.cfxDebug = {
  call: (tool, args) => dispatch(tool, args || {}, 'console'),
  state: () => cfxState.get(),
};
