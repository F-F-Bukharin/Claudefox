#!/usr/bin/env node
'use strict';
// Claude in Zen: native messaging host.
//
// Zen starts this process when the add-on calls runtime.connectNative('claude_in_zen') and ends it
// when the add-on disconnects (the Stop button, or Zen quitting). stdin/stdout carry the native
// messaging protocol, so nothing else may ever write to stdout.
//
// Local clients (the Zen tool server that Claude Code starts) connect over a named pipe and must
// present the per-session token stored in %LOCALAPPDATA%\claude-in-zen\pipe-token.

const VERSION = '0.11.0';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const P = require('./lib/paths');
const log = require('./lib/log');
const { NativeChannel } = require('./lib/nm');
const { onLines, sendLine } = require('./lib/lines');
const { createToolbox, norm } = require('./lib/plugins');
const guard = require('./lib/guard');
const uploads = require('./lib/uploads');
const OUTPUT = require('./lib/output');
const { extractText, kindOf: docKind } = require('./lib/doctext');
const armyguard = require('./lib/armyguard');
const { killTree } = require('./lib/army');
const { createConfirm } = require('./lib/confirm');
const { createLocalPages, createGrants } = require('./lib/localpages');
const watchvideo = require('./lib/watchvideo');
const { createAccounts } = require('./lib/accounts');
const { createClaudeCode, writeMcpConfig } = require('./lib/claudecode');
const { createChatTurns } = require('./lib/chatturns');
const { createSignIn } = require('./lib/signin');
const { createWatchWiring } = require('./lib/watchwiring');
const { createDownloadGate, pictureFolder } = require('./lib/downloadgate');
const { createDownloader } = require('./lib/download');
const { createConfirmFlow } = require('./lib/confirmflow');
const { createUpdates } = require('./lib/updates');

// The confirm window (lib/confirm.js): what the user allowed there, for this helper's life (Stop or a Zen restart ends
// it). The add-on asks before Unsafe mode or file tools go on, and a chat turn gets only what was allowed here.
const confirm = createConfirm({ killTree });
const confirmed = { unsafe: false, trusted: false, files: null, watch: false };   // files: { mode, folder }; watch: video watching (lib/watchgate.js)
// What was allowed, told to the add-on after hello and after every change, so its switches never show more than the helper
// holds (a restarted helper has forgotten everything). trusted is Trusted mode, which lib/confirmflow.js turns on.
function sendConfirmedState() {
  sendAddon({ type: 'confirmed_state', unsafe: confirmed.unsafe === true, trusted: confirmed.trusted === true,
    files: confirmed.files ? { mode: confirmed.files.mode, folder: confirmed.files.folder } : null });
}
const sameDir = (a, b) => guard.within(a, b) && guard.within(b, a);
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
// The project folder this helper runs from (host\..).
const ROOT = path.join(__dirname, '..');

log.open('host.log');
// Stray console output must never reach stdout (the native messaging channel).
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = (...a) => log.info('console', ...a);

const nm = new NativeChannel(process.stdin, process.stdout);
const token = crypto.randomBytes(32).toString('hex');
const clients = new Map();   // id -> { id, sock, name, authed }
const pending = new Map();   // host call id -> { clientId, callId, timer, tool, started, note?, internal? }
let nextId = 1;
let addonVersion = null;
let shuttingDown = false;

fs.mkdirSync(P.BASE, { recursive: true });
fs.mkdirSync(P.WORKSPACE, { recursive: true });
fs.writeFileSync(P.TOKEN_FILE, token);
writeMcpConfig();
uploads.cleanup();
log.info(`host ${VERSION} started, pid ${process.pid}, node ${process.version}`);

// ------------------------------------------------------------------ the helper's parts
// Each part is built here, in the order they depend on each other (host/lib), and gets what it needs as arguments:
// none of them requires this file.
const accounts = createAccounts();
const { accountDir, activeId } = accounts;
const { findClaude, claudeEnv, statusOf, sendStatus } = createClaudeCode({ accountDir, activeId, sendAddon });



// Settings > Tools and plugins: per account (each account is its own Claude Code profile).
const toolbox = createToolbox({ findClaude, claudeEnv, dirOf: id => accountDir(id), emit: m => sendAddon(m), confirm: q => confirm.ask(q) });

const grants = createGrants(P.LOCAL_GRANTS);
if (grants.note) log.info(grants.note);
function sendGrants() { sendAddon({ type: 'local_grants', folders: grants.list() }); }
const local = createLocalPages({ askAddon, confirm: q => confirm.ask(q), grants, changed: sendGrants,
  asking: folder => sendAddon({ type: 'local_question', folder }) });

const chatTurns = createChatTurns({ sendAddon, callAddon, findClaude, claudeEnv, accountDir, activeId, toolbox, confirmed, sameDir, isDir, ROOT,
  shuttingDown: () => shuttingDown });
const { army, startChat, cancelChat, selfApply, selfDiscard } = chatTurns;
const watchWiring = createWatchWiring({ confirm, confirmed, sendAddon, grants });
const { watchWindow, saveWatchOnLoad, sendWatchState, watchLoad, gate, watchRuns, watchDeps } = watchWiring;
// download_image (lib/downloadgate.js): the picture card, and the download in progress (download_off stops it).
const downloadGate = createDownloadGate({
  showCard: (id, info) => sendAddon({ type: 'download_ask', id, host: info.host, name: info.name, folder: info.folder }),
  hideCard: () => sendAddon({ type: 'download_ask', id: null }),
});
const downloader = createDownloader({});
let downloadAbort = null;   // the AbortController of the download in progress, if any
const { answerConfirm } = createConfirmFlow({ confirm, confirmed, sendAddon, sendConfirmedState, isDir, sameDir, watchWindow, saveWatchOnLoad, sendWatchState });
const { sourceInfo, updateAddon } = createUpdates({ ROOT, sendAddon });
const { sendAccounts, useAccount, addAccount, signInAccount, removeAccount, cancelSignIn, forgetLogin } = createSignIn({
  ...accounts, findClaude, claudeEnv, statusOf, sendStatus, sendAddon, chatBusy: () => chatTurns.busy() });


// ------------------------------------------------------------------ add-on side

nm.on('message', msg => {
  try { onAddon(msg); } catch (e) { log.error('add-on message', e.stack || e.message); }
});
nm.on('bad', e => log.warn('unreadable message from the add-on', e.message));
nm.on('end', () => shutdown('add-on disconnected'));

// Mods (extension/mods/<id>/): listed here, switched here, loaded by the panel. See host/lib/mods.js.
const MODS = require('./lib/mods');
const MODS_DIR = path.join(__dirname, '..', 'extension', 'mods');
const OUTPUT_DIR = P.OUTPUT_DIR;   // Settings > Saving files: in the data folder, not in the project
const OLD_OUTPUT_DIR = path.join(ROOT, 'extension', 'output');   // where it used to be
const MODS_STATE = path.join(P.BASE, 'mods.json');
function sendMods() { sendAddon({ type: 'mods', mods: MODS.scanMods(MODS_DIR, MODS_STATE) }); }
// First start after the output folder moved: its files come over from the project folder (README.txt stays).
{
  const r = OUTPUT.moveOld(OLD_OUTPUT_DIR, OUTPUT_DIR);
  if (r.moved.length) log.info(`output folder: ${r.moved.length} saved file${r.moved.length === 1 ? '' : 's'} moved to ${OUTPUT_DIR}`);
  for (const f of r.failed) log.warn(`output folder: ${f.name} could not be moved and was left where it is (${f.error})`);
}
// Settings > Saving files: the add-on sends a made file (base64) and the helper writes it into the output folder.
function saveOutput(msg) {
  try {
    const p = OUTPUT.save(OUTPUT_DIR, msg.name, msg.data);
    sendAddon({ type: 'output_saved', req: msg.req, ok: true, name: path.basename(p), path: p });
  } catch (e) {
    sendAddon({ type: 'output_saved', req: msg.req, ok: false, error: e.message });
  }
}
function modUpdate(msg) {
  const patch = {};
  if (typeof msg.enabled === 'boolean') patch.enabled = msg.enabled;
  if (typeof msg.broken === 'string') patch.broken = msg.broken;
  MODS.setModState(MODS_DIR, MODS_STATE, String(msg.id || ''), patch);
  return sendMods();
}

function sendAddon(msg) {
  // false also when the message was too large and only a short error went in its place (lib/nm.js).
  try { return nm.send(msg); } catch (e) { log.error('send to add-on failed', e.message); return false; }
}

// "Choose folder…": a Windows folder window (pick-folder.ps1, run in an STA thread, which the dialog needs).
// CLAUDE_IN_ZEN_PICK is a test stub (read only with CLAUDE_IN_ZEN_TEST=1): the path to return, or "cancel". The stub and the
// real window end in the same finishPick. Picking a folder only tells the add-on which one; it never changes what was
// allowed. The add-on asks the confirm window for the new folder (answerConfirm) before file tools move to it.
let folderWindowOpen = false;
function finishPick(picked) {
  sendAddon({ type: 'pick_folder_result', ok: true, path: picked, cancelled: !picked });
}
function pickFolder() {
  const stub = P.testHook('CLAUDE_IN_ZEN_PICK');
  if (stub !== undefined) return finishPick(stub === 'cancel' ? '' : stub);
  if (folderWindowOpen) return sendAddon({ type: 'pick_folder_result', ok: false, error: 'A folder window is already open.' });
  if (process.platform !== 'win32') return sendAddon({ type: 'pick_folder_result', ok: false, error: 'The folder window works on Windows. Type the path instead.' });
  folderWindowOpen = true;
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', path.join(__dirname, 'pick-folder.ps1')],
    { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, stdout) => {
      folderWindowOpen = false;
      if (err) return sendAddon({ type: 'pick_folder_result', ok: false, error: 'The folder window did not finish. Type the path instead.' });
      finishPick(String(stdout || '').replace(/^\uFEFF/, '').trim());
    });
}

function onAddon(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      addonVersion = String(msg.version || '?');
      log.info(`add-on ${addonVersion} connected`);
      sendAddon({ type: 'hello', version: VERSION, server: `host ${VERSION}`, clients: clientNames(), ...sourceInfo() });
      sendConfirmedState();
      sendMods();
      sendGrants();
      toolbox.push(activeId());
      toolbox.ensureFresh(activeId()).then(() => toolbox.push(activeId())).catch(e => log.warn('tools scan', e.message));
      return;

    case 'result': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      log.info(`result ${p.tool} ${msg.ok ? 'ok' : 'error'} ${Date.now() - p.started} ms`);
      if (msg.ok && msg.result && typeof msg.result.pdf_base64 === 'string') msg.result = savePdf(msg.result);
      if (p.internal) return p.internal({ ok: !!msg.ok, result: msg.result, error: msg.error });   // the helper's own call
      if (p.note) { try { p.note(msg); } catch (e) { log.error('army note', e.message); } }
      const c = clients.get(p.clientId);
      if (c) sendLine(c.sock, { type: 'result', id: p.callId, ok: !!msg.ok, result: msg.result, error: msg.error });
      return;
    }

    case 'local_tab_result': {   // the tab that shows a local page (lib/localpages.js)
      const done = addonAsks.get(String(msg.id));
      if (done) done(msg);
      return;
    }

    case 'confirm':       return answerConfirm(msg);   // Unsafe mode or file tools are about to go on
    case 'unsafe_off':    confirmed.unsafe = false; return sendConfirmedState();
    case 'trusted_off':   confirmed.trusted = false; return sendConfirmedState();
    case 'files_off':     confirmed.files = null; return sendConfirmedState();
    case 'watch_load':        watchLoad().catch(e => log.error('watch_load', e.message)); return;   // the panel loaded
    case 'watch_set_on_load': if (msg.value === false) saveWatchOnLoad(false); return sendWatchState();   // on is asked in a window
    case 'watch_off':         confirmed.watch = false; gate.cancel(); watchRuns.stopAll(false); return;   // Stop
    case 'watch_answer':      gate.answer(msg.id, !!msg.allow); return;
    case 'watch_shown':       gate.shown(msg.id); return;
    case 'download_shown':    downloadGate.shown(msg.id); return;
    case 'download_answer':   downloadGate.answer(msg.id, !!msg.allow); return;
    case 'download_off':      downloadGate.cancel(); if (downloadAbort) downloadAbort.abort(); return;   // Stop
    case 'local_ask':     // a file: tab outside the allowed folders: the user answers in the confirm window
      local.allowFolder(String(msg.folder || ''), String(msg.reading || '').slice(0, 253))
        .then(folder => sendAddon({ type: 'local_ask_result', id: msg.id, ok: true, folder }),
          e => sendAddon({ type: 'local_ask_result', id: msg.id, ok: false, error: e.message || String(e) }));
      return;
    case 'local_grant_remove':
      if (grants.remove(String(msg.folder || ''))) { log.info('local pages: a folder was removed'); sendGrants(); }
      return;

    case 'claude_status':
      sendStatus();
      return;

    case 'update_addon':
      updateAddon();
      return;

    case 'mods':          return sendMods();
    case 'save_output':   return saveOutput(msg);
    case 'mod_update':    return modUpdate(msg);
    case 'mods_all_off':  MODS.allModsOff(MODS_DIR, MODS_STATE); return sendMods();
    case 'pick_folder':  return pickFolder();
    case 'accounts':
      sendAccounts();
      return;

    case 'account_use':
      useAccount(String(msg.id || ''));
      return;

    case 'account_add':
    case 'claude_switch':   // the 0.4 "Log out and add another account" message: now it adds instead
      addAccount();
      return;

    case 'account_signin':
      signInAccount(String(msg.id || ''));
      return;

    case 'account_remove':
      removeAccount(String(msg.id || ''));
      return;

    case 'account_cancel':
      cancelSignIn();
      return;

    case 'ping':
      sendAddon({ type: 'pong', t: msg.t });
      return;

    case 'chat':
      startChat(msg);
      return;
    case 'scope':
      chatTurns.setScope(msg);
      return;
    case 'local_read':
      chatTurns.setLocalRead(msg.id);
      return;

    case 'self_apply':   return selfApply(msg);
    case 'self_discard': return selfDiscard(msg);
    case 'chat_cancel':
      cancelChat(String(msg.id || '*'), 'Cancelled.');
      return;

    // Settings > Tools and plugins (lib/plugins.js)
    case 'tools':
      toolbox.scan(activeId()).then(() => toolbox.push(activeId())).catch(e => log.warn('tools scan', e.message));
      toolbox.push(activeId());
      return;
    case 'tools_check':
      toolbox.check(activeId()).catch(e => log.error('tools check', e.message));
      return;
    case 'tool_set':
      toolbox.set(activeId(), msg.kind === 'plugin' ? 'plugin' : 'server', String(msg.id || ''), !!msg.value).catch(e => log.error('tools set', e.message));
      return;
    case 'tool_signin':
      toolbox.signIn(activeId(), String(msg.name || ''));
      return;
    case 'tool_cancel':
      toolbox.cancelSignIn();
      return;
    case 'tool_add':
      toolbox.add(activeId(), { name: msg.name, target: msg.target, header: msg.header, on: !!msg.on }).catch(e => log.error('tools add', e.message));
      return;
    case 'tool_remove':
      toolbox.remove(activeId(), String(msg.name || '')).catch(e => log.error('tools remove', e.message));
      return;
    case 'plugin_install':
      toolbox.installPlugin(activeId(), msg.spec, msg.source).catch(e => log.error('plugin install', e.message));
      return;
    case 'plugin_uninstall':
      toolbox.uninstallPlugin(activeId(), String(msg.id || '')).catch(e => log.error('plugin uninstall', e.message));
      return;
  }
}

// A PDF tab (the add-on fetched the file): save it in the workspace, where Claude's Read tool can open it.
function savePdf(r) {
  try {
    const dir = path.join(P.WORKSPACE, 'attachments', 'pdf');
    fs.mkdirSync(dir, { recursive: true });
    const base = String(r.title || 'page').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'page';
    const file = path.join(dir, `${base}-${crypto.createHash('sha1').update(String(r.url)).digest('hex').slice(0, 8)}.pdf`);
    fs.writeFileSync(file, Buffer.from(r.pdf_base64, 'base64'));
    return { title: r.title, url: r.url, truncated: false, saved_to: file,
      text: `This tab shows a PDF (${Math.round(r.bytes / 1024)} KB). It was saved to ${file}. Read it with the Read tool (pass pages for long PDFs).` };
  } catch (e) {
    return { title: r.title, url: r.url, text: `This tab shows a PDF, but saving it failed: ${e.message}` };
  }
}

// ------------------------------------------------------------------ local pipe

const server = net.createServer(sock => {
  const c = { id: nextId++, sock, name: 'client', authed: false };
  clients.set(c.id, c);
  const authTimer = setTimeout(() => { if (!c.authed) sock.destroy(); }, 5000);
  onLines(sock, m => {
    try { onClient(c, m); } catch (e) { log.error('client message', e.stack || e.message); }
  }, () => sock.destroy());
  sock.on('error', () => {});
  sock.on('close', () => {
    clearTimeout(authTimer);
    clients.delete(c.id);
    for (const [hid, p] of pending) {
      if (p.clientId === c.id) { clearTimeout(p.timer); pending.delete(hid); }
    }
    if (c.authed) { log.info(`client "${c.name}" left`); announceClients(); }
  });
});

server.on('error', err => {
  log.error('pipe server', err.code || '', err.message);
  sendAddon({
    type: 'host_error',
    error: err.code === 'EADDRINUSE'
      ? 'Another Claude in Zen helper is already running. Restart Zen.'
      : `The local link failed to start: ${err.message}`,
  });
});
server.listen(P.PIPE, () => log.info(`listening on ${P.PIPE}`));

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function onClient(c, m) {
  if (!m || typeof m !== 'object') return;

  if (!c.authed) {
    // An army worker's tool server also names its worker; a token of an unknown or finished worker is refused.
    const worker = m.type === 'hello' && m.army !== undefined ? army.workerFor(m.army) : null;
    if (m.type === 'hello' && safeEqual(m.token, token) && (m.army === undefined || worker)) {
      c.authed = true;
      c.worker = worker;
      c.name = String(m.client || 'client').replace(/[^\w .()-]/g, '').slice(0, 40) || 'client';
      sendLine(c.sock, { type: 'hello_ok', version: VERSION, addon: addonVersion });
      log.info(`client "${c.name}" connected`);
      if (!worker) announceClients();   // workers show in the army trail, not in the clients list
    } else {
      sendLine(c.sock, { type: 'error', error: 'unauthorized' });
      c.sock.end();
    }
    return;
  }

  // A worker's call: only its own tabs and its budget (lib/armyguard.js). A refused call never reaches Zen.
  let armyCtx = null, note = null;
  if (m.type === 'call' && c.worker) {
    const w = c.worker, tool = String(m.tool);
    const chk = armyguard.checkCall(w, tool, m.args, Date.now());
    if (!chk.ok) {
      log.info(`call ${tool} from "${c.name}" refused: ${chk.error}`);
      sendLine(c.sock, { type: 'result', id: m.id, ok: false, error: chk.error });
      return;
    }
    m.args = chk.args;
    armyCtx = { run: w.run.id, worker: w.id };
    note = res => { armyguard.noteResult(w, tool, chk.args, res); army.trailSoon(w.run); };
  }

  if (m.type === 'call' && HELPER_TOOLS[m.tool]) {
    log.info(`call ${m.tool} from "${c.name}" (answered by the helper)`);
    Promise.resolve().then(() => HELPER_TOOLS[m.tool](m.args || {}, c))
      .then(result => {
        // A page or file a running turn read: the add-on gets page_read with that turn's chat id.
        const run = chatTurns.current();
        if (PAGE_READ_TOOLS.has(m.tool) && run && result && result.ok !== false) sendAddon({ type: 'page_read', id: run.id });
        sendLine(c.sock, { type: 'result', id: m.id, ok: true, result });
      },
        e => sendLine(c.sock, { type: 'result', id: m.id, ok: false, error: e.message || String(e) }));
    return;
  }

  if (m.type === 'call') {
    const hid = `h${nextId++}`;
    const ms = Math.min(Math.max(Number(m.timeout_ms) || 60000, 1000), 300000);
    const timer = setTimeout(() => {
      pending.delete(hid);
      sendLine(c.sock, { type: 'result', id: m.id, ok: false, error: `Zen did not answer within ${ms / 1000} s.` });
    }, ms);
    pending.set(hid, { clientId: c.id, callId: m.id, timer, tool: String(m.tool), started: Date.now(), note });
    log.info(`call ${m.tool} from "${c.name}"`);
    if (!sendAddon(Object.assign({ type: 'call', id: hid, tool: String(m.tool), args: m.args || {}, source: c.name }, armyCtx ? { army: armyCtx } : {}))) {
      clearTimeout(timer);
      pending.delete(hid);
      sendLine(c.sock, { type: 'result', id: m.id, ok: false, error: 'Could not reach the add-on.' });
    }
    return;
  }

  // The WebFetch hook (webfetch-hook.js) asks before each fetch; the reply is the decision for this session's turn.
  if (m.type === 'webfetch_check') {
    sendLine(c.sock, { type: 'webfetch_result', ...chatTurns.webfetchCheck(m.session, m.url) });
    return;
  }
  if (m.type === 'status') {
    sendLine(c.sock, { type: 'status', id: m.id, version: VERSION, addon: addonVersion, clients: clientNames() });
  }
}

// A call the helper itself makes to the add-on (an army worker's first tab). Resolves with the add-on's answer.
function callAddon(tool, args, extra, ms) {
  return new Promise(resolve => {
    const hid = `h${nextId++}`;
    const timer = setTimeout(() => { pending.delete(hid); resolve({ ok: false, error: `Zen did not answer within ${ms / 1000} s.` }); }, ms);
    pending.set(hid, { internal: resolve, timer, tool, started: Date.now() });
    log.info(`call ${tool} from the helper`);
    if (!sendAddon(Object.assign({ type: 'call', id: hid, tool, args }, extra || {}))) {
      clearTimeout(timer);
      pending.delete(hid);
      resolve({ ok: false, error: 'Could not reach the add-on.' });
    }
  });
}

// A question the helper asks the add-on (local_grant, local_tab), answered by a message of type <type>_result with the
// same id. Resolves with that message, or { ok: false, error } when there is no answer in time.
const addonAsks = new Map();   // id -> done(msg)
function askAddon(type, payload, ms) {
  return new Promise(resolve => {
    const id = `q${nextId++}`;
    const timer = setTimeout(() => { addonAsks.delete(id); resolve({ ok: false, error: `Zen did not answer within ${Math.round(ms / 1000)} s.` }); }, ms);
    addonAsks.set(id, msg => { clearTimeout(timer); addonAsks.delete(id); resolve(msg); });
    if (!sendAddon(Object.assign({}, payload, { type, id }))) {
      clearTimeout(timer);
      addonAsks.delete(id);
      resolve({ ok: false, error: 'Could not reach the add-on.' });
    }
  });
}

function clientNames() {
  // The WebFetch hook asks once per fetch (webfetch-hook.js): it is not a client to list.
  return [...clients.values()].filter(c => c.authed && !c.worker && c.name !== 'webfetch-hook').map(c => c.name);
}

function announceClients() {
  sendAddon({ type: 'clients', clients: clientNames() });
}

// ------------------------------------------------------------------ tools the helper answers itself
// read_document: the text of a Word, PowerPoint, Excel or OpenDocument file in the file-tools folder or among the
// files attached to the chat, with the same limits as the file tools (never a protected place).
// The helper tools that read a page or a file: a read that worked in a running turn sends page_read (see the dispatch below).
const PAGE_READ_TOOLS = new Set(['read_document', 'local_files', 'local_file_read', 'watch_video', 'army_wait']);
// download_image (lib/downloadgate.js): a picture from a public address, saved only after the user allows it in a card.
// The folder is the pictures folder, or a folder the user allowed: a local-page folder, or the file-tools folder in write mode.
async function downloadImage(args) {
  let u = null;
  try { u = new URL(String((args && args.url) || '').trim()); } catch { u = null; }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new Error('Give the address of the picture, starting with https://.');
  const allowed = grants.list().map(f => path.resolve(f));
  if (confirmed.files && confirmed.files.mode === 'write') allowed.push(path.resolve(confirmed.files.folder));
  const picked = pictureFolder(args || {}, { outputDir: OUTPUT_DIR, allowed, folderProblem: (f, mode) => guard.folderProblem(f, mode) });
  if (picked.error) throw new Error(picked.error);
  const name = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
  const ask = await downloadGate.ask({ host: u.hostname, name, folder: picked.folder });
  if (!ask.ok) throw new Error(ask.message);
  fs.mkdirSync(picked.folder, { recursive: true });
  const ac = new AbortController();
  downloadAbort = ac;
  let r;
  try { r = await downloader.download({ url: u.href, folder: picked.folder, signal: ac.signal }); }
  finally { if (downloadAbort === ac) downloadAbort = null; }
  if (!r.ok) throw new Error(r.error);
  return `Saved ${path.basename(r.path)} (${Math.max(1, Math.round(r.bytes / 1024))} KB) in ${picked.folder}.`;
}
const HELPER_TOOLS = {
  army_start: (args, client) => army.start(args, client),
  army_wait: (args, client) => army.wait(args, client),
  // Local pages (lib/localpages.js): only inside a folder the user allows in the panel.
  local_page_open: args => local.open(args),
  local_files: args => local.list(args),
  local_file_read: args => local.read(args),
  watch_video: args => watchvideo.watchVideo(args, watchDeps()),
  download_image: args => downloadImage(args),
  read_document(args) {
    const run = chatTurns.current();
    const raw = String((args && args.path) || '').trim();
    if (!raw) throw new Error('Give the path of the file.');
    const folder = run && run.files && run.files.mode ? run.files.folder : '';
    const file = path.resolve(folder && !path.isAbsolute(raw) ? folder : P.WORKSPACE, raw);
    if (!guard.readable(file, [P.WORKSPACE, folder].filter(Boolean))) {
      throw new Error(folder
        ? `Not allowed: ${raw} is outside ${folder} and the attachments, or it is a protected file.`
        : 'Not allowed: file tools are off, so only files attached in this chat can be read. The user can turn file tools on in Settings.');
    }
    if (!docKind(file)) throw new Error('read_document opens .docx, .pptx, .xlsx, .odt, .odp and .ods files. Use Read for PDFs, images and text files.');
    let st;
    try { st = fs.statSync(file); } catch { throw new Error(`No such file: ${raw}`); }
    if (!st.isFile()) throw new Error(`${raw} is a folder, not a file.`);
    const r = extractText(file);
    const start = Math.max(0, Math.floor(Number(args.start_at) || 0));
    const max = Math.min(Math.max(Math.floor(Number(args.max_chars) || 60000), 1000), 200000);
    const next = start + max < r.text.length ? start + max : null;
    return { title: path.basename(file), url: file, kind: r.kind, text: r.text.slice(start, start + max) || '(No text found.)',
      total_chars: r.text.length, next_start: next, truncated: next != null || r.truncated };
  },
};

// ------------------------------------------------------------------ shutdown

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down: ${reason}`);
  cancelChat('*', 'Stopped.');
  confirm.closeAll(true);   // an open confirm window answers no
  gate.cancel();
  downloadGate.cancel();
  if (downloadAbort) downloadAbort.abort();
  watchRuns.stopAll(true);   // a watch run in progress is cut
  forgetLogin();   // the window itself stays: finishing it still works later
  for (const c of clients.values()) { try { c.sock.destroy(); } catch {} }
  try { server.close(); } catch {}
  try { if (fs.readFileSync(P.TOKEN_FILE, 'utf8') === token) fs.unlinkSync(P.TOKEN_FILE); } catch {}
  setTimeout(() => process.exit(0), 50);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => log.error('uncaught', e.stack || e.message));
