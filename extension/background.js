'use strict';
// Claude in Zen: background page (MV2, persistent).
// Session sign-in, Stop/Start, the helper link to Claude Code, debug-port warning,
// action log, and the tool router every call goes through.

let nativePort = null;
const pendingActions = new Map();   // id -> { cmd, controller, startedAt }
let nextActionId = 1;

// ---------------------------------------------------------------- startup

const booted = (async function init() {
  await cizState.load();
  cizState.onChange(pushToPanels);
  cizState.onChange(updateBadge);
  await cizState.set({ pending: 0 });
  try { const pref = await browser.storage.local.get('caveman'); await cizState.set({ caveman: !!pref.caveman }); } catch {}
  cizNetStart();
  await cizState.addLog('info', 'Add-on started');
  resumeSignIn('startup');
  closeInstallerTabs();
  probeDebugPort();
  setInterval(probeDebugPort, 20000);
  if (cizState.get().agent === 'active') connectNative();
  updateBadge(cizState.get());
})();

// Opening Zen turns the agent on. A window counts as "Zen opened" when it is the only normal window, so
// a Stop lasts while Zen stays open, and a second window does not undo it or reconnect the helper.
browser.windows.onCreated.addListener(win => {
  if (!win || win.type !== 'normal') return;
  booted.then(async () => {
    const normal = await browser.windows.getAll({ windowTypes: ['normal'] });
    if (normal.length !== 1) return;
    if (cizState.get().agent === 'active') return connectNative();
    await cizState.set({ agent: 'active' });
    await cizState.addLog('info', 'Zen opened: the agent is on.');
    connectNative();
  }).catch(e => cizState.addLog('error', `Auto-start failed: ${e.message || e}`));
});

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
  port.postMessage({ type: 'chatRuns', ids: [...chatRuns.keys()] });
});

function postToPanels(msg) {
  for (const p of panelPorts) {
    try { p.postMessage(msg); } catch {}
  }
}

function pushToPanels(state, log) {
  for (const p of panelPorts) {
    try { p.postMessage({ type: 'state', state, log }); } catch {}
  }
}

async function handlePanel(msg, port) {
  switch (msg.type) {
    case 'signIn':     return signIn();   // a click: never "auto"
    case 'signOut':    return signOut();
    case 'stop':       return stopAll('Stop button');
    case 'start':      return startAgent();
    case 'setFiles':   return setFiles(!!msg.value, msg.mode, msg.folder);
    case 'pickFolder': return pickFolder();
    case 'retryNative': nativeRetries = 0; return connectNative();
    case 'checkClaude': return requestClaudeStatus(true);
    case 'accounts':      return sendNative({ type: 'accounts' });
    case 'accountUse':    return accountAction('account_use', msg.id, msg.retry);
    case 'switchAccount':                                   // 0.4 panels: "Log out and add another account"
    case 'accountAdd':    return accountAction('account_add');
    case 'accountSignIn': return accountAction('account_signin', msg.id);
    case 'accountRemove': return accountAction('account_remove', msg.id);
    case 'accountCancel': return sendNative({ type: 'account_cancel' });
    case 'updateAddon':
      if (cizState.get().linked) {
        // Linked to the project folder: a reload picks up every change, and reconnecting restarts the helper too.
        await cizState.addLog('info', 'Reloading from your project folder…');
        setTimeout(() => browser.runtime.reload(), 300);
        return;
      }
      if (!sendNative({ type: 'update_addon' })) return cizState.addLog('error', 'Update failed: the helper is not connected.');
      await cizState.set({ updating: true });
      return cizState.addLog('info', 'Building the add-on from your project folder…');
    case 'clearLog':   return cizState.clearLog();
    case 'openLink':   return openLink(String(msg.url || ''));
    case 'openTab':    return openTab(Number(msg.id));
    case 'openFile':   return openFile(String(msg.id || ''));
    case 'downloadFile': return downloadFile(String(msg.id || ''), !!msg.saveAs, String(msg.format || ''));
    case 'snapTab':    return snapTab(port, String(msg.req || ''));
    case 'setCaveman':
      try { await browser.storage.local.set({ caveman: !!msg.value }); } catch {}
      await cizState.set({ caveman: !!msg.value });
      return cizState.addLog('info', msg.value ? 'Caveman mode on: short replies' : 'Caveman mode off');
    // Settings > Tools and plugins: the helper does the work (host/lib/toolbox.js)
    case 'tools':       return sendNative({ type: 'tools' });
    case 'toolsCheck':  return toolsSend({ type: 'tools_check' }, 'Checking every tool server…');
    case 'toolSet':     return toolsSend({ type: 'tool_set', kind: msg.kind === 'plugin' ? 'plugin' : 'server', id: String(msg.id || ''), value: !!msg.value },
      `${msg.value ? 'Turned on' : 'Turned off'} ${String(msg.label || msg.id || 'a tool').slice(0, 60)}`);
    case 'toolSignIn':  return toolsSend({ type: 'tool_signin', name: String(msg.name || '') });
    case 'toolCancel':  return sendNative({ type: 'tool_cancel' });
    case 'toolAdd':     return toolsSend({ type: 'tool_add', name: String(msg.name || '').slice(0, 60), target: String(msg.target || '').slice(0, 2000),
      header: String(msg.header || '').slice(0, 4100), on: !!msg.on }, `Adding ${String(msg.name || '').slice(0, 40)}…`);
    case 'toolRemove':  return toolsSend({ type: 'tool_remove', name: String(msg.name || '') }, `Removing ${String(msg.name || '').slice(0, 40)}…`);
    case 'pluginInstall': return toolsSend({ type: 'plugin_install', spec: String(msg.spec || '').slice(0, 200), source: String(msg.source || '').slice(0, 600) },
      `Installing ${String(msg.spec || '').slice(0, 60)}…`);
    case 'pluginUninstall': return toolsSend({ type: 'plugin_uninstall', id: String(msg.id || '') });
    case 'openClaude': return browser.tabs.create({ url: CIZ.CLAUDE_ORIGIN + '/' });
    case 'devCall':    return devCall(msg.tool);
    case 'call':       return panelCall(msg, port);
    case 'chat':       return startChat(msg);
    case 'chatCancel': return cancelChat(String(msg.id || ''));
    case 'selfApply':   return sendNative({ type: 'self_apply', id: String(msg.id || '') });
    case 'selfDiscard': return sendNative({ type: 'self_discard', id: String(msg.id || '') });
    case 'newChat':    return cizState.set({ chatSession: '' });
    case 'setModel':   return cizState.set({ chatModel: msg.value === 'quality' ? 'quality' : 'speed' });
    case 'setPlus':    return cizState.set({ chatPlus: !!msg.value });
    case 'setUnsafe': return setUnsafe(!!msg.value);
    case 'modUpdate': return sendNative({ type: 'mod_update', id: String(msg.id || ''), enabled: msg.enabled, broken: msg.broken });
    case 'modsAllOff': return sendNative({ type: 'mods_all_off' });
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

// ---------------------------------------------------------------- links and files from the chat
// Replies can link to web pages, to open tabs (zen://tab/<id>) and to files Claude made (zen://file/<id>).

async function openLink(url) {
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return;
  await browser.tabs.create({ url, active: true });
}

async function openTab(id) {
  try {
    const t = await browser.tabs.get(id);
    await browser.tabs.update(id, { active: true });
    try { await browser.windows.update(t.windowId, { focused: true }); } catch {}
  } catch { await cizState.addLog('error', `Tab ${id} is not open any more.`); }
}

async function openFile(id, pdf) {
  if (!/^f[0-9a-z]+$/.test(id)) return;
  await browser.tabs.create({ url: browser.runtime.getURL(`viewer.html${pdf ? '?pdf=1' : ''}#${id}`), active: true });
}

// format: '' (the file's own format), or docx, xlsx, html, md, txt, csv, pdf. Word and Excel files are built here
// from what Claude wrote (lib/docx.js); a PDF opens the file viewer, which saves the page as PDF.
async function downloadFile(id, saveAs, format) {
  const f = await cizFiles.get(id);
  if (!f) return cizState.addLog('error', 'That file is gone (deleted, or pushed out by newer files).');
  const ext = ((/\.([a-z0-9]{1,8})$/i.exec(f.name) || [])[1] || '').toLowerCase();
  const want = String(format || ext).toLowerCase();
  if (want === 'pdf') return openFile(id, true);
  let out;
  try { out = cizExport(f, want); } catch (e) {
    return cizState.addLog('error', `Could not make ${f.name}${want !== ext ? ` as .${want}` : ''}: ${e.message}`);
  }
  const blob = typeof out.data === 'string' ? new Blob([out.data], { type: `${out.mime};charset=utf-8` }) : new Blob([out.data], { type: out.mime });
  const url = URL.createObjectURL(blob);
  try {
    const dl = await browser.downloads.download({ url, filename: `Claude in Zen/${cizSafeFileName(out.name)}`, conflictAction: 'uniquify', saveAs });
    await cizState.addLog('info', `Saved ${out.name} to Downloads\\Claude in Zen`);
    postToPanels({ type: 'downloaded', id, downloadId: dl });
  } catch (e) {
    if (!/cancel/i.test(e.message)) await cizState.addLog('error', `Download failed: ${e.message}`);
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}

// The + menu's "Screenshot of this tab": a PNG of the current tab, attached to the next message.
async function snapTab(port, req) {
  const reply = m => { try { port.postMessage(Object.assign({ type: 'snap', req }, m)); } catch {} };
  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return reply({ error: 'No tab to capture.' });
    const gate = cizUrlBlocked(tab.url || '', { unsafe: !!cizState.get().unsafe });
    if (gate.blocked) return reply({ error: `This tab can't be captured: ${gate.reason}.` });
    const data = await browser.tabs.captureTab(tab.id, { format: 'png' });
    let host = 'tab';
    try { host = new URL(tab.url).hostname.replace(/^www\./, '') || 'tab'; } catch {}
    reply({ data: String(data).replace(/^data:image\/png;base64,/, ''), name: `screenshot ${host}.png`, mime: 'image/png' });
  } catch (e) { reply({ error: `Screenshot failed: ${e.message}` }); }
}

function toolsSend(msg, note) {
  if (!sendNative(msg)) return cizState.addLog('error', 'Tools: the helper is not connected.');
  if (note) return cizState.addLog('info', note);
}

// create_file (lib/tools.js) asks which chat turn a new file belongs to, then tells the panels about it.
function cizFileContext() { const [id] = chatRuns.keys(); return { msg: id || '' }; }
function cizOnFileCreated(file) {
  cizState.addLog('action', `Claude made ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`);
  postToPanels({ type: 'fileCreated', file });
}

// The file viewer page asks for downloads this way.
browser.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'downloadFile') return downloadFile(String(msg.id || ''), !!msg.saveAs, String(msg.format || ''));
});

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

// Opening the .xpi to install it leaves a tab on the file behind. Close those when the add-on starts.
async function closeInstallerTabs() {
  try {
    const tabs = await browser.tabs.query({});
    const ids = tabs.filter(t => /^file:\/\/.*\/(signed\/)?claude[-_]in[-_]zen[^/]*\.xpi$/i.test(t.url || '')).map(t => t.id);
    if (ids.length) await browser.tabs.remove(ids);
  } catch {}
}

// Remembered sign-in: after a manual sign-in the add-on keeps a marker (email, name, account id; never
// cookies) in storage.local. When Zen starts, it checks the claude.ai session again on its own, so you stay
// signed in until you sign out here or on claude.ai. Signing out here forgets the marker.
const REMEMBER_KEY = 'rememberedAccount';

async function remembered() {
  try { return (await browser.storage.local.get(REMEMBER_KEY))[REMEMBER_KEY] || null; } catch { return null; }
}

let resumeBusy = false;
async function resumeSignIn(why) {
  if (resumeBusy || cizState.get().signedIn) return;
  const r = await remembered();
  if (!r) return;
  resumeBusy = true;
  try { await signIn({ auto: why }); } finally { resumeBusy = false; }
}

// The add-on's account is the claude.ai session Zen has open. Once the add-on is signed in, it follows that
// session: when claude.ai is on another account (for example after you sign in there as the account you picked
// with Use), the add-on switches over the next time a claude.ai page loads. It never signs out by itself and
// never reads cookies.
let followBusy = false;
async function followClaudeAccount() {
  if (followBusy || !cizState.get().signedIn) return;
  followBusy = true;
  try {
    const { account } = await fetchAccountFromBackground();
    if (!account || !account.email) return;   // signed out, or claude.ai unreadable right now: keep the add-on as it is
    const now = cizState.get().account || {};
    if (String(now.email || '').toLowerCase() === account.email.toLowerCase()) return;
    await cizState.set({ account, signedInAt: Date.now() });
    await browser.storage.local.set({ [REMEMBER_KEY]: { email: account.email, name: account.name || '', uuid: account.uuid || '', at: Date.now() } });
    await cizState.addLog('info', `The add-on follows claude.ai: now signed in as ${account.email}`);
  } catch {
    // claude.ai could not be read; the add-on stays as it was
  } finally {
    followBusy = false;
  }
}

// A claude.ai tab finishing its load is a good moment to retry (e.g. Zen started offline), or to follow a
// claude.ai account that changed while the add-on was signed in.
browser.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status !== 'complete' || !tab || !String(tab.url || '').startsWith(CIZ.CLAUDE_ORIGIN + '/')) return;
  if (cizState.get().signedIn) followClaudeAccount();
  else resumeSignIn('claude.ai tab');
});

async function signIn(opts) {
  const auto = opts && opts.auto;
  await cizState.addLog('info', auto ? 'Signing back in from the claude.ai session…' : 'Checking claude.ai session…');
  let res = await fetchAccountFromBackground();
  if (!res.account && !res.signedOut) {
    await cizState.addLog('info', `Direct check failed (${res.notes.join(', ')}); trying an open claude.ai tab`);
    try { res = await fetchAccountViaTab(); } catch (e) { res = { account: null, notes: [e.message] }; }
  }
  if (!res.account) {
    await cizState.set({ signedIn: false, account: null, signedInAt: null });
    const why = res.signedOut ? 'not signed in to claude.ai' : res.notes.join(', ');
    if (auto && res.signedOut) {
      // claude.ai itself was signed out: the remembered sign-in no longer holds.
      try { await browser.storage.local.remove(REMEMBER_KEY); } catch {}
      await cizState.addLog('warn', 'claude.ai is signed out, so the add-on is too. Sign in to claude.ai, then press Sign in.');
      return;
    }
    await cizState.addLog(auto ? 'warn' : 'error', auto
      ? `Could not sign back in yet (${why}). It retries when a claude.ai tab loads, or press Sign in.`
      : `Sign-in failed: ${why}. Open claude.ai, sign in there, then try again.`);
    return;
  }
  const before = await remembered();
  await cizState.set({ signedIn: true, account: res.account, signedInAt: Date.now() });
  try {
    const a = res.account;
    await browser.storage.local.set({ [REMEMBER_KEY]: { email: a.email || '', name: a.name || '', uuid: a.uuid || '', at: Date.now() } });
  } catch {}
  const who = res.account.email || res.account.name || res.account.uuid;
  await cizState.addLog('info', `Signed in as ${who} (via ${res.account.via})${auto ? ', remembered from last time' : ''}`);
  if (before && before.uuid && res.account.uuid && before.uuid !== res.account.uuid) {
    await cizState.addLog('warn', `claude.ai is now a different account than last time (${before.email || before.uuid}).`);
  }
}

async function signOut() {
  try { await browser.storage.local.remove(REMEMBER_KEY); } catch {}
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
  failChats('Stopped.');
  cizNetReset();                 // forget recorded requests, stop watching consoles
  disconnectNative('stopped');   // the helper exits, which kills any running Claude Code turn and its tool server
  await cizState.set({ agent: 'stopped', filesEnabled: false, unsafe: false, pending: 0 });
  await cizState.addLog('stop', `Stopped (${source}). Pending actions and chat cancelled, helper disconnected, file tools off, Unsafe mode off, network log cleared.`);
}

async function startAgent() {
  await cizState.set({ agent: 'active' });
  await cizState.addLog('info', 'Agent resumed');
  connectNative();
}

// "Choose folder…": the helper opens a folder window and answers with pick_folder_result.
async function pickFolder() {
  if (cizState.get().folderPicking) return;
  if (!sendNative({ type: 'pick_folder' })) return cizState.addLog('error', 'Choosing a folder needs the helper. Type the path instead.');
  await cizState.set({ folderPicking: true });
}

async function setFiles(value, mode, folder) {
  const m = mode === 'write' ? 'write' : 'read';
  const f = String(folder == null ? cizState.get().filesFolder : folder).trim().slice(0, 1000);
  if (!value) {
    const was = cizState.get().filesEnabled;
    await cizState.set({ filesEnabled: false, filesMode: m, filesFolder: f });
    if (was) await cizState.addLog('info', 'File tools off');
    return;
  }
  if (cizState.get().agent !== 'active') return;
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(f)) {
    await cizState.set({ filesEnabled: false, filesMode: m, filesFolder: f });
    return cizState.addLog('error', 'File tools need a full folder path, like C:\\Users\\you\\Documents\\notes. Left off.');
  }
  await cizState.set({ filesEnabled: true, filesMode: m, filesFolder: f });
  await cizState.addLog('info', `File tools on (${m === 'write' ? 'read and write' : 'read only'}) for ${f}`);
}

// Unsafe mode lets Claude act on Google sign-in pages, to debug the sign-in bug. It lasts for this
// session only: Stop, an add-on restart or a Zen restart turns it off. Passwords, 2FA codes and
// payment details are refused in every mode.
async function setUnsafe(value) {
  if (!value) {
    if (cizState.get().unsafe) {
      await cizState.set({ unsafe: false });
      await cizState.addLog('info', 'Unsafe mode off');
    }
    return;
  }
  if (cizState.get().agent !== 'active') return cizState.addLog('error', 'Press Start first, then turn on Unsafe mode.');
  await cizState.set({ unsafe: true });
  await cizState.addLog('warn', 'Unsafe mode on: Claude may act on Google sign-in pages. It still never types passwords, 2FA codes or payment details.');
}

// ---------------------------------------------------------------- chat
// One Claude Code turn at a time, run by the helper. The panel shows the stream.

const chatRuns = new Map();   // chat id -> { startedAt }

const CHAT_ATTACH_MAX = 12;
const CHAT_ATTACH_BYTES = 80 * 1024 * 1024;

// Attachments from the panel: [{ name, type, data (base64) }], checked before they go to the helper.
function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  let total = 0;
  const out = [];
  for (const a of list.slice(0, CHAT_ATTACH_MAX)) {
    if (!a || typeof a.data !== 'string' || !a.data || /[^A-Za-z0-9+/=]/.test(a.data.slice(0, 200))) continue;
    total += a.data.length * 0.75;
    if (total > CHAT_ATTACH_BYTES) break;
    out.push({ name: cizSafeFileName(a.name, 'file.bin').slice(0, 120), type: String(a.type || '').slice(0, 100), data: a.data });
  }
  return out;
}

async function startChat(msg) {
  const id = String(msg.id || '').slice(0, 64);
  const text = String(msg.text || '');
  const improve = msg.improve === true;   // Improve Claude in Zen: no tab, no files, no attachments; Opus at max effort
  const attachments = improve ? [] : cleanAttachments(msg.attachments);
  const fail = error => postToPanels({ type: 'chatDone', id, ok: false, error });
  if (!id || (!text.trim() && !attachments.length && !improve)) return;
  const s = cizState.get();
  if (chatRuns.size) return fail('Claude is still answering. Wait, or press Cancel.');
  if (s.agent !== 'active') return fail('Claude is stopped. Press Start first.');
  if (!s.signedIn) return fail('Not signed in. Open the Profile page and sign in first.');
  if (s.native !== 'connected') return fail('The helper is not connected. Run "Set up Claude in Zen.bat", then press retry in Settings.');
  if (s.claude && !s.claude.installed) return fail('Claude Code is not installed on this PC.');
  if (s.claude && !s.claude.loggedIn) return fail('Claude Code is not signed in. Double-click "Sign in Claude Code.bat" in the tools folder.');
  const files = !improve && s.filesEnabled ? s.filesMode : '';
  chatRuns.set(id, { startedAt: Date.now() });
  const model = improve ? 'selfimprove' : s.chatModel === 'quality' ? 'quality' : s.chatPlus ? 'speedplus' : 'speed';
  let tab = null;
  if (!improve) {
    try {
      const [t] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (t) tab = { id: t.id, title: t.title || '', url: t.url || '' };
    } catch {}
  }
  const sent = sendNative({ type: 'chat', id, text, model, tab, resume: improve ? '' : (s.chatSession || ''), files, folder: files ? s.filesFolder : '',
    unsafe: !improve && !!s.unsafe, caveman: !improve && !!s.caveman, attachments, improve });
  if (!sent) { chatRuns.delete(id); return fail('Could not reach the helper.'); }
  await cizState.addLog('action', improve ? 'improve → Claude Code, Opus 5.5 at max effort'
    : `chat → Claude Code, ${model}${files ? `, file tools: ${files}` : ''}${attachments.length ? `, ${attachments.length} file${attachments.length === 1 ? '' : 's'} attached` : ''}${s.caveman ? ', caveman' : ''}`);
}

function cancelChat(id) {
  if (!chatRuns.has(id)) return;
  sendNative({ type: 'chat_cancel', id });
}

// Ends every open turn in the panel (Stop, or the helper went away).
function failChats(error) {
  for (const id of chatRuns.keys()) postToPanels({ type: 'chatDone', id, ok: false, error });
  chatRuns.clear();
}

async function onChatDone(msg) {
  const id = String(msg.id || '');
  chatRuns.delete(id);
  const err = String(msg.error || '');
  if (msg.sessionId) await cizState.set({ chatSession: String(msg.sessionId) });
  if (!msg.ok && /No conversation found/i.test(err)) await cizState.set({ chatSession: '' });
  if (!msg.ok) await cizState.addLog(msg.limit ? 'warn' : 'error', `Chat: ${err.split('\n')[0].slice(0, 200)}`);
  postToPanels({ type: 'chatDone', id, ok: !!msg.ok, error: err, limit: !!msg.limit });
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
    if (cizState.get().accountLogin) cizState.set({ accountLogin: null });
    if (cizState.get().accountBusy) cizState.set({ accountBusy: '' });
    if (cizState.get().folderPicking) cizState.set({ folderPicking: false });
    failChats('The helper stopped, so the answer was cut off.');
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

// ---------------------------------------------------------------- accounts
// The helper keeps one Claude Code profile per account (Google-style switching). The add-on relays the
// panel's requests, keeps the list in state, and can retry a message after a switch (usage limit).

let pendingRetry = null;   // { id, text }: send this again once the switch to account id is done

// Profile shows how a switch went (accountNote) and that one is waiting (accountBusy), not only the action log.
async function accountNote(ok, text) {
  await cizState.set({ accountNote: { ok: !!ok, text: String(text || '').slice(0, 300) } });
}

async function accountAction(type, id, retry) {
  if (cizState.get().agent !== 'active') return cizState.addLog('error', 'Press Start first.');
  if (chatRuns.size && type !== 'account_signin') {
    if (type === 'account_use') await accountNote(false, 'Claude is still answering. Switch accounts after it finishes.');
    return cizState.addLog('error', 'Claude is still answering. Try again after it finishes.');
  }
  const accountId = String(id || '');
  if (!sendNative({ type, id: accountId })) {
    if (type === 'account_use') await accountNote(false, 'The helper is not connected, so the chat did not switch.');
    return cizState.addLog('error', 'Accounts: the helper is not connected.');
  }
  if (type === 'account_use') await cizState.set({ accountBusy: accountId, accountNote: null });
  if (type === 'account_use' && retry && typeof retry === 'string') pendingRetry = { id: accountId, text: retry.slice(0, 50000) };
  if (type === 'account_add') await cizState.addLog('info', 'Opening a sign-in window for another Claude account…');
}

function accountLabel(id) {
  const a = (cizState.get().accounts || []).find(x => x.id === id);
  return (a && a.email) || 'the account';
}

async function onAccountResult(msg) {
  const id = String(msg.id || '');
  switch (msg.action) {
    case 'use': {
      await cizState.set({ accountBusy: '' });
      if (!msg.ok) {
        pendingRetry = null;
        await accountNote(false, msg.error || 'The chat did not switch.');
        return cizState.addLog('error', `Switch failed: ${msg.error}`);
      }
      await cizState.set({ chatSession: '' });   // conversations belong to the account that had them
      await followClaudeAccount();   // if claude.ai is already on the chosen account, the add-on follows it now
      const who = msg.email || accountLabel(id);
      await accountNote(true, `The chat now uses ${who}. Your next message runs on it.`);
      await cizState.addLog('info', `Chat now uses ${who}`);
      if (pendingRetry && pendingRetry.id === id) postToPanels({ type: 'retry', text: pendingRetry.text });
      pendingRetry = null;
      return;
    }
    case 'login_started':
      await cizState.set({ accountLogin: { id, isNew: !!msg.isNew, at: Date.now() } });
      return cizState.addLog('info', 'A sign-in window is open: pick the Claude account in the browser and click Authorize. The panel notices when you are done.');
    case 'login':
      await cizState.set({ accountLogin: null });
      if (!msg.ok) return cizState.addLog(/Cancelled/.test(msg.error) ? 'info' : 'error', `Sign-in: ${msg.error}`);
      await cizState.set({ chatSession: '' });
      return cizState.addLog('info', msg.already
        ? `${msg.email} was already on the list. Switched to it.`
        : `Signed in as ${msg.email || 'the new account'}. The chat uses it now.`);
    case 'add':
    case 'signin':
      if (!msg.ok) return cizState.addLog('error', `Sign-in: ${msg.error}`);
      return;
    case 'remove':
      return cizState.addLog(msg.ok ? 'info' : 'error', msg.ok ? 'Account removed from Claude in Zen.' : `Remove failed: ${msg.error}`);
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
    case 'mods': return cizState.set({ mods: Array.isArray(msg.mods) ? msg.mods : [] });
    case 'hello':
      nativeRetries = 0;
      await cizState.set({
        native: 'connected', nativeDetail: `helper ${msg.version}`, hostVersion: String(msg.version || ''),
        sourceVersion: String(msg.sourceVersion || ''), canUpdate: !!msg.canUpdate, linked: !!msg.linked,
        clients: Array.isArray(msg.clients) ? msg.clients.slice(0, 10) : [],
      });
      await cizState.addLog('info', `Helper ${msg.version} connected`);
      requestClaudeStatus();
      sendNative({ type: 'accounts' });
      return;

    case 'clients':
      await cizState.set({ clients: Array.isArray(msg.clients) ? msg.clients.slice(0, 10) : [] });
      return;

    case 'pick_folder_result': {
      await cizState.set({ folderPicking: false });
      if (!msg.ok) return cizState.addLog('error', msg.error || 'The folder window did not finish. Type the path instead.');
      if (msg.cancelled || !msg.path) return;
      await setFiles(!!cizState.get().filesEnabled, cizState.get().filesMode, msg.path);
      return cizState.addLog('info', `Folder chosen: ${msg.path}`);
    }
    case 'claude_status':
      await cizState.set({
        claude: {
          installed: !!msg.installed,
          loggedIn: !!msg.loggedIn,
          email: String(msg.email || msg.emailAddress || ''),
          plan: String(msg.subscriptionType || ''),
          accountId: String(msg.accountId || ''),
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

    case 'update_result':
      await cizState.set({ updating: false, updateNote: msg.ok
        ? `v${msg.version} sent to Zen. If no install prompt shows up, run "Install in Zen.bat" (tools folder) yourself, or link Zen once for one-click updates.`
        : `Update: ${msg.error}` });
      await cizState.addLog(msg.ok ? 'info' : 'error', msg.ok
        ? `v${msg.version} handed to Zen${msg.note ? ` (${msg.note.replace(/\.$/, '')})` : ''}. Click Add, then Okay, in Zen's prompt. The panel reloads after.`
        : `Update: ${msg.error}`);
      return;

    case 'accounts':
      await cizState.set({
        accounts: (Array.isArray(msg.accounts) ? msg.accounts : []).slice(0, 20).map(a => ({
          id: String(a.id || ''), email: String(a.email || ''), plan: String(a.plan || ''), org: String(a.org || ''),
          loggedIn: !!a.loggedIn, active: !!a.active, lastUsed: Number(a.lastUsed) || 0,
        })),
        accountLogin: msg.login ? { id: String(msg.login.id || ''), isNew: !!msg.login.isNew } : null,
      });
      return;

    case 'account_result':
      return onAccountResult(msg);

    case 'chat_event':
      if (chatRuns.has(String(msg.id))) postToPanels({ type: 'chatEvent', id: String(msg.id), event: msg.event || {} });
      return;

    case 'tools':
      await cizState.set({ tools: cleanTools(msg), toolLogin: msg.login ? { name: String(msg.login.name || ''), label: String(msg.login.label || '') } : null });
      return;

    case 'tool_result':
      return onToolResult(msg);

    case 'self_result':
      postToPanels({ type: 'selfResult', id: String(msg.id || ''), ok: !!msg.ok, text: String(msg.text || '').slice(0, 2000),
        files: Array.isArray(msg.files) ? msg.files.slice(0, 60).map(f => String(f).slice(0, 200)) : [] });
      return;
    case 'chat_done':
      return onChatDone(msg);

    case 'host_error':
      await cizState.addLog('error', `Helper: ${msg.error}`);
      return;
  }
}

// ---------------------------------------------------------------- tools and plugins

function cleanTools(m) {
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 200);
  const server = s => ({ name: str(s.name, 120), label: str(s.label, 80), status: str(s.status, 20), detail: str(s.detail, 160), transport: str(s.transport, 10),
    local: !!s.local, target: str(s.target, 200), on: !!s.on });
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max || 300) : []);
  return {
    busy: m.busy ? str(m.busy, 20) : null, scanned: Number(m.scanned) || 0, checked: Number(m.checked) || 0,
    plugins: list(m.plugins).map(p => ({ id: str(p.id, 120), label: str(p.label, 60), version: str(p.version, 20), scope: str(p.scope, 20),
      description: str(p.description, 220), skills: !!p.skills, local: !!p.local, recommended: !!p.recommended, on: !!p.on, status: str(p.status, 20),
      servers: list(p.servers, 20).map(server) })),
    connectors: list(m.connectors).map(server),
    added: list(m.added).map(server),
  };
}

async function onToolResult(msg) {
  const name = String(msg.label || msg.name || msg.id || '').slice(0, 80);
  const ok = !!msg.ok;
  const err = String(msg.error || '').slice(0, 300);
  postToPanels({ type: 'toolResult', action: String(msg.action || ''), ok, error: err, name: String(msg.name || ''), label: name });
  switch (msg.action) {
    case 'signin_started': return cizState.addLog('info', `A sign-in window is open for ${name}. Sign in there; the panel notices when you are done.`);
    case 'signin': return cizState.addLog(ok ? 'info' : /Cancelled/.test(err) ? 'info' : 'error', ok ? `${name} is signed in. Claude can use it now.` : `${name}: ${err}`);
    case 'add': return cizState.addLog(ok ? 'info' : 'error', ok ? `Added ${name}.` : `Add: ${err}`);
    case 'remove': return cizState.addLog(ok ? 'info' : 'error', ok ? `Removed ${name}.` : `Remove: ${err}`);
    case 'install': return cizState.addLog(ok ? 'info' : 'error', ok ? `Installed ${name}. Switch it on below to use it in the chat.` : `Install: ${err}`);
    case 'uninstall': return cizState.addLog(ok ? 'info' : 'error', ok ? `Removed plugin ${name}.` : `Remove plugin: ${err}`);
    default: if (!ok && err) return cizState.addLog('error', `Tools: ${err}`);
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

// The tools themselves are in lib/tools.js (CIZ_TOOLS).

async function dispatch(tool, args, source) {
  const s = cizState.get();
  if (s.agent !== 'active') return { ok: false, error: 'Agent is stopped. Press Start in the Claude in Zen panel.' };
  if (!s.signedIn) return { ok: false, error: 'Not signed in. Press "Sign in with Claude" in the panel.' };
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
