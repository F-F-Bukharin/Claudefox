'use strict';
// Claude in Zen: chat runs and native messaging. A chat turn runs in the helper, one at a time; the helper link
// carries its stream. onNativeMessage is the switch for the helper's messages.

// ---------------------------------------------------------------- chat
// One Claude Code turn at a time, run by the helper. The panel shows the stream.

const chatRuns = new Map();   // chat id -> { startedAt, model, windowId }
// Messages sent while an answer runs wait here, in order, across all windows: { id, msg }. One answer runs at a time.
const chatQueue = [];
const CHAT_QUEUE_MAX = 10;
let chatReserved = false;      // a message is being started (between the busy check and chatRuns.set)
const winSessions = new Map(); // window id -> the Claude session of that window's chat
// Every panel hears which answers run and which messages wait (the hint under the input, the pending bubbles).
function chatBusyPush() { postToPanels({ type: 'chatBusy', ids: [...chatRuns.keys()], queued: chatQueue.map(q => q.id) }); }
function chatUnqueue(id) {
  const i = chatQueue.findIndex(q => q.id === id);
  if (i >= 0) { chatQueue.splice(i, 1); chatBusyPush(); }
}
// A window that closes takes its waiting messages and its saved chat with it.
function chatWindowGone(windowId) {
  winSessions.delete(windowId);
  for (let i = chatQueue.length - 1; i >= 0; i--) if (chatQueue[i].msg.windowId === windowId) chatQueue.splice(i, 1);
  try { browser.storage.session.remove('win:' + windowId); } catch {}
  chatBusyPush();
}
// When no answer runs, the next waiting message starts. The panel that sent it draws its answer from chatStarted on.
function drainChatQueue() {
  if (chatRuns.size || chatReserved || !chatQueue.length) return;
  const next = chatQueue.shift();
  postToPanels({ type: 'chatStarted', id: next.id });
  startChat(next.msg).then(drainChatQueue, drainChatQueue);
}
// The log's names for the army turns: the Max effort switch picks armymax.
const ARMY_LABEL = { army: 'army (Opus 5.5 at high effort, with Haiku workers)', armymax: 'army (Opus 5.5 at max effort, with Haiku workers)' };

// The chat turn that is running (one at a time), or '' between turns: the message id the site gate and the helper share.
function cizChatId() { return chatRuns.size ? [...chatRuns.keys()][0] : ''; }

// Whenever the chat's site list changes during a turn (a card answered), the helper hears the new list.
cizSiteGate.onChange = list => {
  const id = cizChatId();
  if (id) sendNative({ type: 'scope', id, sites: list, trusted: !!cizState.get().trusted });
};

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

// The army's Max effort switch (storage.local armyMax, written by the panel).
async function armyMaxOn() {
  try { return (await browser.storage.local.get('armyMax')).armyMax === true; } catch { return false; }
}

async function startChat(msg) {
  const id = String(msg.id || '').slice(0, 64);
  const text = String(msg.text || '');
  const improve = msg.improve === true;   // Improve Claude in Zen: no tab, no files, no attachments; Opus at max effort
  const attachments = improve ? [] : cleanAttachments(msg.attachments);
  const fail = error => {
    postToPanels({ type: 'chatDone', id, ok: false, error });
    if (msg.scheduled) cizMacros.skipped(msg.scheduled.macro, error);   // a scheduled run that could not start is a skipped run
  };
  if (!id || (!text.trim() && !attachments.length && !improve)) return;
  if (chatRuns.size || chatReserved) {
    if (chatQueue.length >= CHAT_QUEUE_MAX) return fail('Too many messages are waiting. Wait for Claude to catch up.');
    chatQueue.push({ id, msg });
    if (msg.scheduled) cizMacros.waitOrSkip(id, msg.scheduled.macro);   // a scheduled run waits up to 30 minutes
    postToPanels({ type: 'chatQueued', id });
    return chatBusyPush();
  }
  chatReserved = true;
  try { return await startChatNow(msg, id, text, improve, attachments, fail); } finally { chatReserved = false; }
}

async function startChatNow(msg, id, text, improve, attachments, fail) {
  const s = cizState.get();
  // A scheduled macro (E8) only reads: Speed, no tab, no files, no Unsafe, no Trusted, no army, and its own sites. A saved macro with
  // army tasks (E7) sends in Quality with the army on, whatever the switches say.
  const sched = msg.scheduled && typeof msg.scheduled === 'object' && msg.scheduled.macro ? { macro: String(msg.scheduled.macro).slice(0, 40), sites: (Array.isArray(msg.scheduled.sites) ? msg.scheduled.sites : []).map(String) } : null;
  const forceArmy = !improve && !sched && msg.army === true;
  const armyMax = !improve && !sched && (forceArmy || (s.chatModel === 'quality' && s.chatArmy)) ? await armyMaxOn() : false;
  if (s.agent !== 'active') return fail('Claude is stopped. Press Start first.');
  if (!s.signedIn) return fail('Not signed in. Open the Profile page and sign in first.');
  if (s.native !== 'connected') return fail('The helper is not connected. Run "Set up Claude in Zen.bat", then press retry in Settings.');
  if (s.claude && !s.claude.installed) return fail('Claude Code is not installed on this PC.');
  if (s.claude && !s.claude.loggedIn) return fail('Claude Code is not signed in. Double-click "Sign in Claude Code.bat" in the tools folder.');
  const files = !improve && !sched && s.filesEnabled ? s.filesMode : '';
  const model = improve ? 'selfimprove' : sched ? 'speed' : forceArmy ? (armyMax ? 'armymax' : 'army') : s.chatModel === 'quality' ? (s.chatArmy ? (armyMax ? 'armymax' : 'army') : 'quality') : s.chatPlus ? 'speedplus' : 'speed';
  const winId = typeof msg.windowId === 'number' ? msg.windowId : null;
  chatRuns.set(id, { startedAt: Date.now(), model, windowId: winId, scheduled: sched, text: '' });
  chatBusyPush();
  let tab = null, windowId = winId;
  if (!improve && !sched) {
    try {
      const [t] = await browser.tabs.query(winId != null ? { active: true, windowId: winId } : { active: true, lastFocusedWindow: true });
      if (t) { tab = { id: t.id, title: t.title || '', url: t.url || '' }; windowId = t.windowId; }
    } catch {}
  }
  // The sites Claude may use in this message: the open page's, the ones the text names, the chat's, and the ones the user marked allow.
  // Opening a chat from History sends its Claude session id, so the next message resumes that conversation.
  // A window's own chat resumes that window's session (a message that waited in the queue takes the one its predecessor made).
  const resume = improve || sched ? '' : typeof msg.resume === 'string' ? msg.resume.slice(0, 100) : winId != null ? (winSessions.get(winId) || '') : (s.chatSession || '');
  if (!improve && !sched && winId != null) winSessions.set(winId, resume);
  let sites = [];
  if (sched) sites = cizSiteGate.begin(id, { scheduled: sched.sites });
  else if (!improve) {
    let blocks = {};
    try { blocks = (await browser.storage.local.get('sites')).sites || {}; } catch {}
    const allow = Object.keys(blocks).filter(k => blocks[k] === 'allow');
    const extra = (Array.isArray(msg.tabSites) ? msg.tabSites : []).slice(0, 20).map(s => cizSiteOf('http://' + s)).filter(Boolean);   // the tabs the text mentions with @
    sites = cizSiteGate.begin(id, { tabUrl: tab && tab.url, windowId, text, newChat: !resume, allow, extra });
  }
  const sent = sendNative({ type: 'chat', id, text, model, tab, resume, files, folder: files ? s.filesFolder : '',
    unsafe: !improve && !sched && !!s.unsafe, caveman: !improve && !sched && !!s.caveman, attachments, improve,
    sites, trusted: !improve && !sched && !!s.trusted, scheduled: !!sched });
  if (!sent) { chatRuns.delete(id); chatBusyPush(); cizSiteGate.end(id); return fail('Could not reach the helper.'); }
  await cizState.addLog('action', improve ? 'improve → Claude Code, Opus 5.5 at max effort'
    : sched ? `scheduled macro ${sched.macro} → Claude Code, Speed, reading ${sched.sites.join(', ')}`
    : `chat → Claude Code, ${ARMY_LABEL[model] || model}${files ? `, file tools: ${files}` : ''}${attachments.length ? `, ${attachments.length} file${attachments.length === 1 ? '' : 's'} attached` : ''}${s.caveman ? ', caveman' : ''}`);
}

function cancelChat(id) {
  if (!chatRuns.has(id)) return;
  sendNative({ type: 'chat_cancel', id });
}

// Ends every open turn in the panel (Stop, or the helper went away).
function failChats(error) {
  cizSiteGate.cancel();   // a card that waits for an answer nobody can give now
  for (const [id, run] of chatRuns) { postToPanels({ type: 'chatDone', id, ok: false, error }); cizSiteGate.end(id); if (run.scheduled) cizMacros.finished(run, { ok: false, error }); }
  chatRuns.clear();
  for (const q of chatQueue.splice(0)) { postToPanels({ type: 'chatDone', id: q.id, ok: false, error }); if (q.msg.scheduled) cizMacros.skipped(q.msg.scheduled.macro, error); }   // Stop clears every waiting message
  chatBusyPush();
}

async function onChatDone(msg) {
  const id = String(msg.id || '');
  const run = chatRuns.get(id);
  chatRuns.delete(id);
  cizSiteGate.end(id);
  const err = String(msg.error || '');
  if (msg.limit) await browser.storage.local.set({ limitHitAt: Date.now() });   // scheduled macros stay away for 2 hours (lib/bg-macros.js)
  if (run && run.windowId != null) {
    if (msg.sessionId) winSessions.set(run.windowId, String(msg.sessionId));
    if (!msg.ok && /No conversation found/i.test(err)) winSessions.set(run.windowId, '');
  }
  const own = !(run && run.scheduled);   // a scheduled run never touches the chat's own session
  if (own && msg.sessionId) await cizState.set({ chatSession: String(msg.sessionId) });
  if (own && !msg.ok && /No conversation found/i.test(err)) await cizState.set({ chatSession: '' });
  if (!msg.ok) await cizState.addLog(msg.limit ? 'warn' : 'error', `Chat: ${err.split('\n')[0].slice(0, 200)}`);
  postToPanels({ type: 'chatDone', id, ok: !!msg.ok, error: err, limit: !!msg.limit, sessionId: String(msg.sessionId || '') });
  if (run && run.scheduled) await cizMacros.finished(run, msg);
  chatBusyPush();
  drainChatQueue();
}

// ---------------------------------------------------------------- helper (native host)
// The helper links the add-on to Claude Code on this PC. Zen starts it on connectNative and
// ends it when the port closes, so Stop (which disconnects) also ends everything it serves.

let nativeRetries = 0;
let nativeRetryTimer = null;
// A panel that connects with no helper port waits here; connectNative sends its watch_load after hello.
let watchLoadWanted = false;

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
    cizSiteGate.cancel();                  // nor a site question
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
  if (watchLoadWanted) { watchLoadWanted = false; sendNative({ type: 'watch_load' }); }   // a panel opened before the helper was connected
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

// The picture card (download_image). A site the user blocked (Sites: block, for the site or a parent domain) is refused at
// once, with no card. Anything else sets the card the panel shows; the helper's hideCard sends no id, which clears it.
async function pictureSiteBlocked(host) {
  let blocks = {};
  try { blocks = (await browser.storage.local.get('sites')).sites || {}; } catch {}
  const parts = String(host).toLowerCase().split('.');
  return parts.some((_, i) => blocks[parts.slice(i).join('.')] === 'block');
}
async function downloadAskFromHelper(msg) {
  const id = msg.id ? String(msg.id).slice(0, 40) : '';
  const host = String(msg.host || '').slice(0, 253);
  if (id && await pictureSiteBlocked(host)) return sendNative({ type: 'download_answer', id, allow: false });
  return cizState.set({ downloadAsk: id ? { id, host, name: String(msg.name || '').slice(0, 200), folder: String(msg.folder || '').slice(0, 500) } : null });
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
      // With file tools on, the new folder is asked in the helper's confirm window; a no keeps the old folder (setFiles logs it).
      const r = await setFiles(!!cizState.get().filesEnabled, cizState.get().filesMode, msg.path, { keepOldOnNo: true });
      if (r && r.kept) return;
      return cizState.addLog('info', `Folder chosen: ${msg.path}`);
    }

    // What the helper holds as allowed (sent after hello and after every change). The switches follow it: a helper that
    // restarted has forgotten what was allowed, and the add-on must not keep showing it on. Off keeps the remembered mode and
    // folder: they are the user's choice, only the permission is gone.
    case 'confirmed_state': {
      const s = cizState.get();
      const f = msg.files;
      const patch = { unsafe: msg.unsafe === true, trusted: msg.trusted === true };
      if (f && typeof f === 'object' && (f.mode === 'read' || f.mode === 'write') && typeof f.folder === 'string' && f.folder) {
        Object.assign(patch, { filesEnabled: true, filesMode: f.mode, filesFolder: f.folder.slice(0, 1000) });
      } else {
        patch.filesEnabled = false;
      }
      await cizState.set(patch);
      if (s.trusted && !patch.trusted) {   // the helper forgot it: the turn that runs hears it too
        const running = cizChatId();
        if (running) sendNative({ type: 'scope', id: running, sites: cizSiteGate.list(), trusted: false });
        await cizState.addLog('warn', 'Trusted mode is off: the helper restarted and did not keep it.');
      }
      if (s.unsafe && !patch.unsafe) await cizState.addLog('warn', 'Unsafe mode is off: the helper restarted and did not keep it. Turn it on again to be asked.');
      if (s.filesEnabled && !patch.filesEnabled) await cizState.addLog('warn', 'File tools are off: the helper restarted and did not keep them. Turn them on again to be asked.');
      return;
    }
    case 'page_read': return cizSiteGate.markRead();   // the helper's own tools (documents, attachments) showed Claude page content
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
      const turn = chatRuns.get(cizChatId());
      const out = await dispatch(String(msg.tool), msg.args || {}, String(msg.source || 'Claude'), army, !army && !!(turn && turn.scheduled));
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
    case 'download_ask':  return downloadAskFromHelper(msg);   // the helper's picture card (download_image)
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
      const model = chatRuns.get(id).model;   // the entry is there: checked above
      if (event.kind === 'text' && chatRuns.get(id).scheduled) chatRuns.get(id).text += String(event.text || '');   // a scheduled run's answer goes to History
      if (event.kind === 'stats' && (model === 'army' || model === 'armymax')) await countArmyTokens((Number(event.tokensIn) || 0) + (Number(event.tokensOut) || 0));
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
    case 'error':   // a reply that was too large to send, or another problem the helper reports
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
