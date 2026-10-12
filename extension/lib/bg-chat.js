'use strict';
// Claude in Zen: chat runs and native messaging. A chat turn runs in the helper, one at a time; the helper link
// carries its stream. onNativeMessage is the switch for the helper's messages.

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
  const model = improve ? 'selfimprove' : s.chatModel === 'quality' ? (s.chatArmy ? 'army' : 'quality') : s.chatPlus ? 'speedplus' : 'speed';
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
    : `chat → Claude Code, ${model === 'army' ? 'army (Opus 5.5 at max effort, with Haiku workers)' : model}${files ? `, file tools: ${files}` : ''}${attachments.length ? `, ${attachments.length} file${attachments.length === 1 ? '' : 's'} attached` : ''}${s.caveman ? ', caveman' : ''}`);
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
    for (const done of [...outputWaiters.values()]) done({ ok: false, error: 'the helper stopped' });
    failChats('The helper stopped, so the answer was cut off.');
    cizArmy.closeAll().catch(() => {});   // its workers are gone, so their tabs go too
    cizLocal.cancelAll().catch(() => {});  // and nobody can answer a folder question now
    endConfirms('The helper stopped.');
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

async function onNativeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'output_saved': {
      const done = outputWaiters.get(msg.req);
      if (done) done(msg.ok ? { ok: true, name: String(msg.name || ''), path: String(msg.path || '') } : { ok: false, error: String(msg.error || 'unknown error') });
      return;
    }
    case 'mods': return cizState.set({ mods: Array.isArray(msg.mods) ? msg.mods : [], modsKnown: true });
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
      // An army worker's call names its run and worker; lib/army.js holds it to that worker's own tabs.
      // An army field that is there but not a run and a worker is refused, never read as a normal call.
      const a = msg.army;
      if (a != null && !(a && typeof a === 'object' && typeof a.run === 'string' && a.run && typeof a.worker === 'string' && a.worker)) {
        sendNative({ type: 'result', id: msg.id, ok: false, error: 'Bad army call.' });
        return;
      }
      const army = a != null ? { run: a.run.slice(0, 40), worker: a.worker.slice(0, 40) } : null;
      const out = await dispatch(String(msg.tool), msg.args || {}, String(msg.source || 'Claude'), army);
      sendNative({ type: 'result', id: msg.id, ...out });
      return;
    }

    // Local pages (lib/local.js): the helper keeps the allowed folders and asks about new ones in its confirm window.
    case 'local_grants':     return cizLocal.setGrants(msg.folders);
    case 'local_question':   return cizLocal.setQuestion(String(msg.folder || ''));
    case 'local_ask_result': return cizLocal.answer(String(msg.id || ''), msg);
    case 'watch_state':   // the helper's switch and saved option: after a panel load, a confirm answer or a card's Yes
      return cizState.set({ watch: msg.watch === true, watchOnLoad: msg.watchOnLoad === true ? true : msg.watchOnLoad === false ? false : null });
    case 'watch_ask':     return cizState.set({ watchAsk: { id: String(msg.id || '').slice(0, 40), source: String(msg.source || '').slice(0, 500) } });
    case 'watch_ask_done': {
      const cur = cizState.get().watchAsk;
      return cur && cur.id === String(msg.id || '').slice(0, 40) ? cizState.set({ watchAsk: null }) : undefined;
    }
    case 'confirm_result': { // the user's answer in the helper's confirm window (askConfirm)
      const done = confirmWaiters.get(String(msg.id || ''));
      if (done) done({ ok: msg.ok === true, error: String(msg.error || '').slice(0, 300) });
      return;
    }
    case 'local_tab': {     // the helper opened a file in Zen: which tab shows it
      const r = await cizLocal.findTab(String(msg.url || ''));
      sendNative({ type: 'local_tab_result', id: msg.id, ok: !!r.ok, tab_id: r.tab_id == null ? null : r.tab_id, title: r.title || '', error: r.error || '' });
      return;
    }

    case 'army_end':   // a worker finished (or, without worker, the whole run): close its tabs
      if (msg.run) await cizArmy.closeRun(String(msg.run), msg.worker ? String(msg.worker) : null);
      return;

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

    case 'chat_event': {
      const id = String(msg.id);
      if (!chatRuns.has(id)) return;
      let event = msg.event || {};
      if (event.kind === 'army' && event.started) event = Object.assign({}, event, { today: await countArmyRun() });
      postToPanels({ type: 'chatEvent', id, event });
      return;
    }

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
    local: !!s.local, target: str(s.target, 200), on: !!s.on, blocked: str(s.blocked, 200) });
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max || 300) : []);
  return {
    busy: m.busy ? str(m.busy, 20) : null, scanned: Number(m.scanned) || 0, checked: Number(m.checked) || 0,
    plugins: list(m.plugins).map(p => ({ id: str(p.id, 120), label: str(p.label, 60), version: str(p.version, 20), scope: str(p.scope, 20),
      description: str(p.description, 220), skills: !!p.skills, local: !!p.local, recommended: !!p.recommended, on: !!p.on, blocked: str(p.blocked, 200),
      status: str(p.status, 20), servers: list(p.servers, 20).map(server) })),
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
    case 'set': return ok ? undefined : cizState.addLog('error', err);
    default: if (!ok && err) return cizState.addLog('error', `Tools: ${err}`);
  }
}
