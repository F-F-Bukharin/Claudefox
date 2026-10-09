'use strict';
// Claude in Zen: background page (MV2, persistent).
// Session sign-in, Stop/Start, the helper link to Claude Code, debug-port warning,
// action log, and the tool router every call goes through.

let nativePort = null;
const pendingActions = new Map();   // id -> { cmd, controller, startedAt }
let nextActionId = 1;

// ---------------------------------------------------------------- startup

(async function init() {
  await cizState.load();
  cizState.onChange(pushToPanels);
  cizState.onChange(updateBadge);
  await cizState.set({ pending: 0 });
  await cizState.addLog('info', 'Add-on started');
  probeDebugPort();
  setInterval(probeDebugPort, 20000);
  if (cizState.get().agent === 'active') connectNative();
  updateBadge(cizState.get());
})();

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle().catch(() => browser.sidebarAction.open().catch(() => {}));
});

// ---------------------------------------------------------------- panel link

const panelPorts = new Set();

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener(msg => handlePanel(msg, port).catch(err => {
    cizState.addLog('error', `${msg && msg.type}: ${err.message || err}`);
  }));
  port.postMessage({ type: 'state', state: cizState.get(), log: cizState.log() });
});

function pushToPanels(state, log) {
  for (const p of panelPorts) {
    try { p.postMessage({ type: 'state', state, log }); } catch {}
  }
}

async function handlePanel(msg, port) {
  switch (msg.type) {
    case 'signIn':     return signIn();
    case 'signOut':    return signOut();
    case 'stop':       return stopAll('Stop button');
    case 'start':      return startAgent();
    case 'setFiles':   return setFiles(!!msg.value);
    case 'retryNative': nativeRetries = 0; return connectNative();
    case 'checkClaude': return requestClaudeStatus(true);
    case 'clearLog':   return cizState.clearLog();
    case 'openClaude': return browser.tabs.create({ url: CIZ.CLAUDE_ORIGIN + '/' });
    case 'devCall':    return devCall(msg.tool);
    case 'call':       return panelCall(msg, port);
  }
}

// Chat test commands from the panel. Only the test tools are allowed here;
// real tool calls arrive from Claude over the native channel.
async function panelCall(msg, port) {
  const allowed = ['ping', 'tabs_list'];
  const out = allowed.includes(msg.tool)
    ? await dispatch(msg.tool, msg.args || {}, 'panel')
    : { ok: false, error: `Not available from the panel: ${msg.tool}` };
  try { port.postMessage(Object.assign({ type: 'callResult', id: msg.id }, out)); } catch {}
}

// Panel "Try it" buttons: real router calls, result summarised in the log.
async function devCall(tool) {
  if (!['ping', 'tabs_list'].includes(tool)) return;
  const out = await dispatch(tool, {}, 'panel');
  if (!out.ok) return cizState.addLog('error', `${tool}: ${out.error}`);
  if (tool === 'ping') return cizState.addLog('info', `ping → pong (v${out.result.version})`);
  const n = out.result.length;
  const active = out.result.find(t => t.active);
  return cizState.addLog('info', `tabs_list → ${n} tab${n === 1 ? '' : 's'}${active ? `; active: "${(active.title || active.url || '').slice(0, 60)}"` : ''}`);
}

// ---------------------------------------------------------------- sign-in
// Reuses the claude.ai session already open in Zen. The browser attaches the
// session itself; the add-on never reads cookies. Only email/name/uuid are
// kept, and only in storage.session.

const ACCOUNT_ENDPOINTS = ['/api/account', '/api/bootstrap', '/api/organizations'];

function pickAccount(path, j) {
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j)) {               // /api/organizations: no email, org only
    const org = j[0];
    return org && org.uuid ? { email: '', name: org.name || 'Claude organization', uuid: org.uuid, via: path } : null;
  }
  const a = j.account && typeof j.account === 'object' ? j.account : j;
  const email = a.email_address || a.email || '';
  const uuid = a.uuid || a.id || '';
  if (!email && !uuid) return null;
  return { email, name: a.full_name || a.display_name || a.name || '', uuid, via: path };
}

async function fetchAccountFromBackground() {
  const notes = [];
  for (const path of ACCOUNT_ENDPOINTS) {
    try {
      const r = await fetch(CIZ.CLAUDE_ORIGIN + path, {
        credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' },
      });
      notes.push(`${path} ${r.status}`);
      if (r.status === 401) return { account: null, notes, signedOut: true };
      if (!r.ok) continue;
      const acct = pickAccount(path, await r.json().catch(() => null));
      if (acct) return { account: acct, notes };
    } catch (e) {
      notes.push(`${path} ${e.message}`);
    }
  }
  return { account: null, notes };
}

// Fallback: run the same request from inside an open claude.ai tab, where it
// is a normal same-origin call. Returns only the minimal fields.
async function fetchAccountViaTab() {
  const tabs = await browser.tabs.query({ url: CIZ.CLAUDE_ORIGIN + '/*' });
  if (!tabs.length) return { account: null, notes: ['no claude.ai tab open'] };
  const code = `(async () => {
    const paths = ${JSON.stringify(ACCOUNT_ENDPOINTS)};
    const notes = [];
    for (const p of paths) {
      try {
        const r = await fetch(p, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
        notes.push(p + ' ' + r.status);
        if (r.status === 401) return { signedOut: true, notes };
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j)) { const o = j[0]; if (o && o.uuid) return { path: p, acct: { email: '', name: o.name || '', uuid: o.uuid, array: true }, notes }; continue; }
        const a = (j && j.account && typeof j.account === 'object') ? j.account : j;
        const email = a.email_address || a.email || '', uuid = a.uuid || a.id || '';
        if (email || uuid) return { path: p, acct: { email, name: a.full_name || a.display_name || a.name || '', uuid }, notes };
      } catch (e) { notes.push(p + ' ' + e.message); }
    }
    return { notes };
  })()`;
  const [res] = await browser.tabs.executeScript(tabs[0].id, { code });
  if (!res) return { account: null, notes: ['tab check returned nothing'] };
  if (res.acct) return { account: Object.assign(res.acct, { via: res.path + ' (tab)' }), notes: res.notes };
  return { account: null, notes: res.notes || [], signedOut: !!res.signedOut };
}

async function signIn() {
  await cizState.addLog('info', 'Checking claude.ai session…');
  let res = await fetchAccountFromBackground();
  if (!res.account && !res.signedOut) {
    await cizState.addLog('info', `Direct check failed (${res.notes.join(', ')}); trying an open claude.ai tab`);
    try { res = await fetchAccountViaTab(); } catch (e) { res = { account: null, notes: [e.message] }; }
  }
  if (!res.account) {
    await cizState.set({ signedIn: false, account: null, signedInAt: null });
    const why = res.signedOut ? 'not signed in to claude.ai' : res.notes.join(', ');
    await cizState.addLog('error', `Sign-in failed: ${why}. Open claude.ai, sign in there, then try again.`);
    return;
  }
  await cizState.set({ signedIn: true, account: res.account, signedInAt: Date.now() });
  await cizState.addLog('info', `Signed in as ${res.account.email || res.account.name || res.account.uuid} (via ${res.account.via})`);
}

async function signOut() {
  await stopAll('Sign-out');
  await cizState.set({ signedIn: false, account: null, signedInAt: null });
  await cizState.addLog('info', 'Signed out of the add-on (claude.ai itself is untouched)');
}

// ---------------------------------------------------------------- Stop
// Rule 1: Stop cancels pending actions, disconnects the native host and
// disables file tools. Nothing else.

async function stopAll(source) {
  for (const [id, a] of pendingActions) {
    try { a.controller.abort(new Error('Stopped')); } catch {}
    pendingActions.delete(id);
  }
  disconnectNative('stopped');
  await cizState.set({ agent: 'stopped', filesEnabled: false, pending: 0 });
  await cizState.addLog('stop', `Stopped (${source}). Pending actions cancelled, helper disconnected, file tools off.`);
}

async function startAgent() {
  await cizState.set({ agent: 'active' });
  await cizState.addLog('info', 'Agent resumed');
  connectNative();
}

async function setFiles(value) {
  // File tools arrive in a later step (served through Claude Code, not the add-on).
  if (value) {
    await cizState.addLog('info', 'File tools are not built yet. Toggle left off.');
    await cizState.set({ filesEnabled: false });
    return;
  }
  await cizState.set({ filesEnabled: false });
}

// ---------------------------------------------------------------- helper (native host)
// The helper links the add-on to Claude Code on this PC. Zen starts it on connectNative and
// ends it when the port closes, so Stop (which disconnects) also ends everything it serves.

let nativeRetries = 0;
let nativeRetryTimer = null;

function connectNative() {
  if (nativePort) return;
  if (cizState.get().agent !== 'active') return;
  clearTimeout(nativeRetryTimer);
  let port;
  try {
    port = browser.runtime.connectNative(CIZ.NATIVE_HOST);
  } catch (e) {
    cizState.set({ native: 'error', nativeDetail: e.message });
    return;
  }
  nativePort = port;
  cizState.set({ native: 'unknown', nativeDetail: 'connecting…' });

  port.onMessage.addListener(msg => {
    onNativeMessage(msg).catch(e => cizState.addLog('error', `Helper message failed: ${e.message}`));
  });
  port.onDisconnect.addListener(p => {
    const err = (p && p.error) || browser.runtime.lastError;
    nativePort = null;
    if (err && /No such native application/i.test(err.message)) {
      cizState.set({ native: 'missing', nativeDetail: 'helper not installed', clients: [] });
      return;
    }
    cizState.set({ native: 'error', nativeDetail: err ? err.message : 'helper stopped', clients: [] });
    // The helper dropped on its own (not via Stop): try again a few times.
    if (cizState.get().agent === 'active' && nativeRetries < 3) {
      nativeRetries++;
      nativeRetryTimer = setTimeout(connectNative, 1500 * nativeRetries);
    }
  });
  sendNative({ type: 'hello', version: browser.runtime.getManifest().version });
}

function disconnectNative(reason) {
  clearTimeout(nativeRetryTimer);
  if (nativePort) {
    try { nativePort.disconnect(); } catch {}
    nativePort = null;
  }
  cizState.set({ native: 'unknown', nativeDetail: reason || 'disconnected', clients: [] });
}

function sendNative(msg) {
  if (!nativePort) return false;
  try { nativePort.postMessage(msg); return true; } catch (e) {
    cizState.addLog('error', `Could not reach the helper: ${e.message}`);
    return false;
  }
}

let claudeCheckAsked = false;   // log the next status answer (set by the panel's "check" link)

function requestClaudeStatus(fromPanel) {
  if (fromPanel) {
    claudeCheckAsked = true;
    cizState.addLog('info', 'Checking Claude Code sign-in…');
  }
  if (!sendNative({ type: 'claude_status' }) && fromPanel) {
    claudeCheckAsked = false;
    cizState.addLog('error', 'Claude Code check failed: the helper is not connected.');
  }
}

async function onNativeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      nativeRetries = 0;
      await cizState.set({
        native: 'connected', nativeDetail: `helper ${msg.version}`, hostVersion: String(msg.version || ''),
        clients: Array.isArray(msg.clients) ? msg.clients.slice(0, 10) : [],
      });
      await cizState.addLog('info', `Helper ${msg.version} connected`);
      requestClaudeStatus();
      return;

    case 'clients':
      await cizState.set({ clients: Array.isArray(msg.clients) ? msg.clients.slice(0, 10) : [] });
      return;

    case 'claude_status':
      await cizState.set({
        claude: {
          installed: !!msg.installed,
          loggedIn: !!msg.loggedIn,
          email: String(msg.email || msg.emailAddress || ''),
          plan: String(msg.subscriptionType || ''),
          checkedAt: Date.now(),
        },
      });
      if (claudeCheckAsked) {
        claudeCheckAsked = false;
        const who = msg.email || msg.emailAddress;
        const dir = msg.configDirectory ? ` (profile: ${msg.configDirectory})` : '';
        await cizState.addLog('info', !msg.installed ? 'Claude Code: not installed on this PC.'
          : !msg.loggedIn ? `Claude Code: not signed in${dir}.`
          : `Claude Code: signed in as ${who || 'unknown account'}${dir}.`);
      }
      return;

    case 'call': {
      const out = await dispatch(String(msg.tool), msg.args || {}, String(msg.source || 'Claude'));
      sendNative({ type: 'result', id: msg.id, ...out });
      return;
    }

    case 'host_error':
      await cizState.addLog('error', `Helper: ${msg.error}`);
      return;
  }
}

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

const TOOLS = {
  async ping() { return { pong: true, version: browser.runtime.getManifest().version }; },

  async tabs_list() {
    const tabs = await browser.tabs.query({});
    return tabs.map(t => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url }));
  },
};

async function dispatch(tool, args, source) {
  const s = cizState.get();
  if (s.agent !== 'active') return { ok: false, error: 'Agent is stopped. Press Start in the Claude in Zen panel.' };
  if (!s.signedIn) return { ok: false, error: 'Not signed in. Press "Sign in with Claude" in the panel.' };
  const fn = TOOLS[tool];
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
