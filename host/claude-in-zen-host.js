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

const VERSION = '0.8.0';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const P = require('./lib/paths');
const log = require('./lib/log');
const { NativeChannel } = require('./lib/nm');
const { onLines, sendLine } = require('./lib/lines');
const { createToolbox, norm } = require('./lib/toolbox');
const guard = require('./lib/guard');
const uploads = require('./lib/uploads');
const { extractText, kindOf: docKind } = require('./lib/doctext');

log.open('host.log');
// Stray console output must never reach stdout (the native messaging channel).
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = (...a) => log.info('console', ...a);

const nm = new NativeChannel(process.stdin, process.stdout);
const token = crypto.randomBytes(32).toString('hex');
const clients = new Map();   // id -> { id, sock, name, authed }
const pending = new Map();   // host call id -> { clientId, callId, timer, tool, started }
let nextId = 1;
let addonVersion = null;
let shuttingDown = false;

fs.mkdirSync(P.BASE, { recursive: true });
fs.mkdirSync(P.WORKSPACE, { recursive: true });
fs.writeFileSync(P.TOKEN_FILE, token);
writeMcpConfig();
uploads.cleanup();
log.info(`host ${VERSION} started, pid ${process.pid}, node ${process.version}`);

// ------------------------------------------------------------------ add-on side

nm.on('message', msg => {
  try { onAddon(msg); } catch (e) { log.error('add-on message', e.stack || e.message); }
});
nm.on('bad', e => log.warn('unreadable message from the add-on', e.message));
nm.on('end', () => shutdown('add-on disconnected'));

function sendAddon(msg) {
  try { nm.send(msg); return true; } catch (e) { log.error('send to add-on failed', e.message); return false; }
}

// "Choose folder…": a Windows folder window (pick-folder.ps1, run in an STA thread, which the dialog needs).
// CLAUDE_IN_ZEN_PICK is a test stub: the path to return, or "cancel".
let folderWindowOpen = false;
function pickFolder() {
  const stub = process.env.CLAUDE_IN_ZEN_PICK;
  if (stub !== undefined) return sendAddon({ type: 'pick_folder_result', ok: true, path: stub === 'cancel' ? '' : stub, cancelled: stub === 'cancel' });
  if (folderWindowOpen) return sendAddon({ type: 'pick_folder_result', ok: false, error: 'A folder window is already open.' });
  if (process.platform !== 'win32') return sendAddon({ type: 'pick_folder_result', ok: false, error: 'The folder window works on Windows. Type the path instead.' });
  folderWindowOpen = true;
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', path.join(__dirname, 'pick-folder.ps1')],
    { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, stdout) => {
      folderWindowOpen = false;
      if (err) return sendAddon({ type: 'pick_folder_result', ok: false, error: 'The folder window did not finish. Type the path instead.' });
      const picked = String(stdout || '').replace(/^\uFEFF/, '').trim();
      sendAddon({ type: 'pick_folder_result', ok: true, path: picked, cancelled: !picked });
    });
}

function onAddon(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      addonVersion = String(msg.version || '?');
      log.info(`add-on ${addonVersion} connected`);
      sendAddon({ type: 'hello', version: VERSION, server: `host ${VERSION}`, clients: clientNames(), ...sourceInfo() });
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
      const c = clients.get(p.clientId);
      if (c) sendLine(c.sock, { type: 'result', id: p.callId, ok: !!msg.ok, result: msg.result, error: msg.error });
      return;
    }

    case 'claude_status':
      sendStatus();
      return;

    case 'update_addon':
      updateAddon();
      return;

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
      if (login) finishLogin(false, null, 'Cancelled.');
      return;

    case 'ping':
      sendAddon({ type: 'pong', t: msg.t });
      return;

    case 'chat':
      startChat(msg);
      return;

    case 'chat_cancel':
      cancelChat(String(msg.id || '*'), 'Cancelled.');
      return;

    // Settings > Tools and plugins (lib/toolbox.js)
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
    if (m.type === 'hello' && safeEqual(m.token, token)) {
      c.authed = true;
      c.name = String(m.client || 'client').replace(/[^\w .()-]/g, '').slice(0, 40) || 'client';
      sendLine(c.sock, { type: 'hello_ok', version: VERSION, addon: addonVersion });
      log.info(`client "${c.name}" connected`);
      announceClients();
    } else {
      sendLine(c.sock, { type: 'error', error: 'unauthorized' });
      c.sock.end();
    }
    return;
  }

  if (m.type === 'call' && HELPER_TOOLS[m.tool]) {
    log.info(`call ${m.tool} from "${c.name}" (answered by the helper)`);
    Promise.resolve().then(() => HELPER_TOOLS[m.tool](m.args || {}))
      .then(result => sendLine(c.sock, { type: 'result', id: m.id, ok: true, result }),
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
    pending.set(hid, { clientId: c.id, callId: m.id, timer, tool: String(m.tool), started: Date.now() });
    log.info(`call ${m.tool} from "${c.name}"`);
    if (!sendAddon({ type: 'call', id: hid, tool: String(m.tool), args: m.args || {}, source: c.name })) {
      clearTimeout(timer);
      pending.delete(hid);
      sendLine(c.sock, { type: 'result', id: m.id, ok: false, error: 'Could not reach the add-on.' });
    }
    return;
  }

  if (m.type === 'status') {
    sendLine(c.sock, { type: 'status', id: m.id, version: VERSION, addon: addonVersion, clients: clientNames() });
  }
}

function clientNames() {
  return [...clients.values()].filter(c => c.authed).map(c => c.name);
}

function announceClients() {
  sendAddon({ type: 'clients', clients: clientNames() });
}

// ------------------------------------------------------------------ Claude Code

// Locates the Claude Code binary. The native installer puts it in ~/.local/bin.
function findClaude() {
  const win = process.platform === 'win32';
  const names = win ? ['claude.exe'] : ['claude'];
  const candidates = [];
  if (process.env.CLAUDE_IN_ZEN_CLAUDE) candidates.push(process.env.CLAUDE_IN_ZEN_CLAUDE);
  candidates.push(path.join(os.homedir(), '.local', 'bin', names[0]));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) for (const n of names) candidates.push(path.join(dir, n));
  }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Environment for every Claude Code process the host starts: the profile folder of the active account (or the
// one given), and no API-key or third-party-provider variables, so usage always runs on the user's plan.
function claudeEnv(dir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir || accountDir(activeId()) };
  for (const k of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ]) delete env[k];
  return env;
}

// Sends the active account's sign-in state. Each call supersedes the ones before it, so a slow
// "auth status" for an account the user just switched away from can never overwrite the new one.
let statusSeq = 0;
function sendStatus() {
  const seq = ++statusSeq, id = activeId();
  statusOf(accountDir(id))
    .then(s => { if (seq === statusSeq) sendAddon({ type: 'claude_status', ...s, accountId: id }); })
    .catch(e => log.error('status', e.message));
}

// "claude auth status" for one profile folder.
function statusOf(dir) {
  return new Promise(resolve => {
    const exe = findClaude();
    if (!exe) return resolve({ installed: false, loggedIn: false });
    execFile(exe, ['auth', 'status'], { env: claudeEnv(dir), timeout: 20000, windowsHide: true }, (err, stdout) => {
      let info = {};
      try { info = JSON.parse(String(stdout || '').trim() || '{}'); } catch {}
      const pick = {};
      for (const k of ['authMethod', 'email', 'emailAddress', 'organizationName', 'orgName', 'subscriptionType', 'configDirectory']) {
        if (typeof info[k] === 'string') pick[k] = info[k];
      }
      const loggedIn = typeof info.loggedIn === 'boolean' ? info.loggedIn : (!err && pick.authMethod !== 'none');
      resolve({ installed: true, loggedIn, ...pick });
    });
  });
}

// ------------------------------------------------------------------ chat (one Claude Code turn per message)

// The tool server config Claude Code loads for chat turns (and that "Test" scripts can reuse).
function writeMcpConfig() {
  const cfg = {
    mcpServers: {
      'claude-in-zen': {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(__dirname, 'zen-mcp.js')],
        env: { CLAUDE_IN_ZEN_CLIENT: 'Claude in Zen panel', CLAUDE_IN_ZEN_PANEL: '1' },
        alwaysLoad: true,   // never hidden behind tool search, whatever else is switched on
      },
    },
  };
  try { fs.writeFileSync(P.MCP_CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) { log.error('mcp.json', e.message); }
}

const CHAT_TIMEOUT_MS = 60 * 60 * 1000;   // long jobs (a whole course's homework) take a while; Cancel is always there
const { MODELS, chatArgs } = require('./lib/chatargs');
const LIMIT_RE = /usage limit|limit reached|rate.?limit|reached your|limit will reset|out of (extra )?usage/i;
let chat = null;   // the running turn: { id, child, sessionId, finished, stderr, resultError, timer, files, key }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function emitChat(run, event) { sendAddon({ type: 'chat_event', id: run.id, event }); }

// mcp__claude-in-zen__click -> { name: 'click' }; mcp__plugin_vidiq_vidiq__vidiq_video_transcript -> { name: 'vidiq_video_transcript', server: 'vidIQ' }.
function toolName(run, raw) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(raw || ''));
  if (!m) return { name: String(raw || '') };
  if (m[1] === 'claude-in-zen') return { name: m[2] };
  return { name: m[2], server: toolbox.labelFor(run.key, m[1]) };
}

function brief(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : (s || '');
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[image]' : '')).join(' ');
}

const SIGN_IN_TOLD = new Set();   // "<session>|<server>": each conversation is told once per server

function onChatLine(run, line) {
  if (run.finished || !line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev && typeof ev.session_id === 'string' && !run.sessionId) run.sessionId = ev.session_id;
  if (ev && ev.type === 'system' && ev.subtype === 'init') {
    if (ev.model) emitChat(run, { kind: 'meta', model: String(ev.model), effort: run.effort });   // the model Claude Code reports
    if (Array.isArray(ev.mcp_servers)) {
      for (const p of toolbox.learn(run.key, ev.mcp_servers)) {
        const k = `${run.sessionId || run.id}|${p.name}`;
        if (SIGN_IN_TOLD.has(k)) continue;
        SIGN_IN_TOLD.add(k);
        emitChat(run, p.status === 'needs-auth'
          ? { kind: 'notice', text: `${p.label} needs you to sign in before Claude can use it.`, action: { type: 'tool_signin', name: p.name, label: `Sign in to ${p.label}` } }
          : { kind: 'notice', text: `${p.label} did not answer, so Claude cannot use it right now. Settings → Tools and plugins → check shows why.` });
      }
    }
  }
  switch (ev && ev.type) {
    case 'stream_event': {
      const e = ev.event || {};
      if (ev.parent_tool_use_id) return;
      if (e.type === 'content_block_start' && e.content_block) {
        const t = e.content_block.type;
        if (t === 'thinking' || t === 'redacted_thinking') emitChat(run, { kind: 'status', status: 'thinking' });
        // A new text block after tools: start a new paragraph, so "...post it.I posted" can't happen.
        if (t === 'text' && run.wroteText && run.actedSinceText) { emitChat(run, { kind: 'text', text: '\n\n' }); run.actedSinceText = false; }
      }
      if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
        run.wroteText = true;
        emitChat(run, { kind: 'text', text: String(e.delta.text) });
      }
      return;
    }
    case 'assistant':
      for (const b of (ev.message && ev.message.content) || []) {
        if (!b || b.type !== 'tool_use') continue;
        run.actedSinceText = true;
        const t = toolName(run, b.name);
        if (t.name === 'progress' && !t.server) {
          run.progressIds.add(b.id);
          const inp = b.input || {};
          emitChat(run, {
            kind: 'progress', done: Math.max(0, Number(inp.done) || 0), note: String(inp.note || '').slice(0, 120),
            steps: Array.isArray(inp.steps) ? inp.steps.slice(0, 12).map(x => String(x).slice(0, 80)) : null,
          });
          continue;
        }
        emitChat(run, Object.assign({ kind: 'tool', name: t.name, input: brief(b.input, 300) }, t.server ? { server: t.server } : {}));
      }
      return;
    case 'user':
      for (const b of (ev.message && ev.message.content) || []) {
        if (b && b.type === 'tool_result' && !run.progressIds.has(b.tool_use_id)) emitChat(run, { kind: 'tool_result', error: !!b.is_error, text: brief(resultText(b.content), 200) });
      }
      return;
    case 'result':
      emitChat(run, { kind: 'stats', ms: Number(ev.duration_ms) || Date.now() - run.started, turns: Number(ev.num_turns) || 0 });
      if (ev.is_error || ev.subtype !== 'success') {
        run.resultError = String(ev.result || (Array.isArray(ev.errors) && ev.errors.join(' ')) || ev.subtype || 'Claude Code reported an error.');
      }
      return;
  }
}

function finishChat(run, ok, error) {
  if (run.finished) return;
  run.finished = true;
  clearTimeout(run.timer);
  if (chat === run) chat = null;
  const err = ok ? '' : String(error || 'Claude Code stopped without an answer.').slice(0, 1500);
  if (!ok) log.warn(`chat ${run.id} failed: ${err.slice(0, 200)}`); else log.info(`chat ${run.id} done ${Date.now() - run.started} ms`);
  sendAddon({ type: 'chat_done', id: run.id, ok: !!ok, error: err, limit: !ok && LIMIT_RE.test(err), sessionId: run.sessionId || '' });
}

function startChat(msg) {
  const id = String(msg.id || '').slice(0, 64);
  const refuse = error => sendAddon({ type: 'chat_done', id, ok: false, error, limit: false, sessionId: '' });
  if (chat) return refuse('Claude is still answering the last message.');
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (!text.trim() && !(Array.isArray(msg.attachments) && msg.attachments.length)) return refuse('The message is empty.');
  if (text.length > 50000) return refuse('The message is too long.');
  const exe = findClaude();
  if (!exe) return refuse('Claude Code is not installed on this PC. Install it, then run "Sign in Claude Code.bat".');

  const files = { mode: null, folder: '' };
  if (msg.files === 'read' || msg.files === 'write') {
    const folder = String(msg.folder || '').trim();
    if (!folder || !path.isAbsolute(folder) || !isDir(folder)) {
      return refuse(`File tools are on, but this folder was not found: ${folder || '(none)'}. Fix it in Settings or turn file tools off.`);
    }
    const why = guard.folderProblem(folder);
    if (why) return refuse(`File tools can't use ${folder}: ${why}. Pick another folder in Settings.`);
    files.mode = msg.files;
    files.folder = path.resolve(folder);
  }
  const choice = MODELS[msg.model] || MODELS.speed;
  const unsafe = msg.unsafe === true;
  const caveman = msg.caveman === true;
  const resume = typeof msg.resume === 'string' && /^[0-9a-f-]{36}$/i.test(msg.resume) ? msg.resume : '';
  const key = activeId();

  // The turn is reserved now (one at a time); it starts after the tool list is fresh and the uploads are saved.
  const run = { id, child: null, key, files, effort: choice.effort, sessionId: resume, finished: false, stderr: '', resultError: '', started: Date.now(), timer: null,
    wroteText: false, actedSinceText: false, progressIds: new Set() };
  chat = run;
  emitChat(run, { kind: 'meta', model: choice.model, effort: choice.effort });   // what the helper asked for
  run.timer = setTimeout(() => cancelChat(id, 'The answer took longer than an hour and was stopped.'), CHAT_TIMEOUT_MS);

  Promise.resolve(toolbox.ensureFresh(key)).catch(e => log.warn('tools scan', e.message)).then(() => {
    if (run.finished) return;
    let saved = { files: [], errors: [] };
    try { saved = uploads.save(msg.attachments); } catch (e) { saved.errors.push(`attachments: ${e.message}`); }
    const tb = toolbox.chatOptions(key);
    const opts = { unsafe, caveman, tb, cavemanText: caveman ? toolbox.skillText(key, 'caveman', 'caveman') : '' };
    let child;
    try {
      child = spawn(exe, chatArgs(files, resume, choice, opts), {
        // Only the Zen tools: all loaded up front (ENABLE_TOOL_SEARCH=false). With other servers on: "auto" loads them up
        // front while they are small and defers big sets (like vidIQ's) behind ToolSearch, to keep each turn light.
        cwd: P.WORKSPACE, env: { ...claudeEnv(accountDir(key)), ENABLE_TOOL_SEARCH: tb.servers.length ? 'auto' : 'false' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return finishChat(run, false, `Could not start Claude Code: ${e.message}`);
    }
    run.child = child;
    log.info(`chat ${id} started (${choice.model}, files: ${files.mode || 'off'}, ${resume ? 'resumed' : 'new'}${unsafe ? ', unsafe mode' : ''}`
      + `${tb.servers.length ? `, tools: ${tb.servers.join(', ')}` : ''}${saved.files.length ? `, ${saved.files.length} attachment(s)` : ''}${caveman ? ', caveman' : ''})`);

    child.stdin.on('error', () => {});
    const ctx = msg.tab && typeof msg.tab === 'object'
      ? `[Current tab: id ${Number(msg.tab.id)}, "${String(msg.tab.title || '').slice(0, 200)}", ${String(msg.tab.url || '').slice(0, 500)}]\n\n`
      : '';
    const body = text.trim() ? text : 'Look at the attached files.';
    child.stdin.end(ctx + uploads.promptBlock(saved) + body, 'utf8');   // the prompt goes on stdin: no quoting or length limits

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) { onChatLine(run, buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { run.stderr = (run.stderr + d).slice(-4000); });
    child.on('error', e => finishChat(run, false, `Could not run Claude Code: ${e.message}`));
    child.on('close', code => {
      if (buf) onChatLine(run, buf);
      if (run.resultError) return finishChat(run, false, run.resultError);
      if (code === 0) return finishChat(run, true);
      const tail = run.stderr.trim().split('\n').slice(-6).join('\n');
      finishChat(run, false, tail || `Claude Code exited with code ${code}.`);
    });
  });
}

function cancelChat(id, reason) {
  const run = chat;
  if (!run || (id !== '*' && id !== run.id)) return;
  try { if (run.child) run.child.kill(); } catch {}
  finishChat(run, false, reason || 'Stopped.');
}

// ------------------------------------------------------------------ tools the helper answers itself
// read_document: the text of a Word, PowerPoint, Excel or OpenDocument file in the file-tools folder or among the
// files attached to the chat, with the same limits as the file tools (never a protected place).
const HELPER_TOOLS = {
  read_document(args) {
    const run = chat;
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

// ------------------------------------------------------------------ update the add-on
// The project folder this helper runs from (host\..). With the source there, the helper runs install-xpi.ps1:
// it rebuilds the .xpi (or picks the signed one for this version) and hands it to Zen, which shows its install
// prompt. When Zen is linked to the folder the add-on just reloads instead. Friends' copies have no source.

const ROOT = path.join(__dirname, '..');

function sourceInfo() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
    return { sourceVersion: String(m.version || ''), canUpdate: process.platform === 'win32' && fs.existsSync(path.join(ROOT, 'install-xpi.ps1')), linked: isLinked() };
  } catch { return { sourceVersion: '', canUpdate: false, linked: false }; }
}

// True when a Zen profile loads the add-on straight from this folder (a proxy file written by link.ps1).
function isLinked() {
  try {
    const zen = path.join(process.env.APPDATA || '', 'zen');
    const ini = fs.readFileSync(path.join(zen, 'profiles.ini'), 'utf8');
    const want = path.resolve(ROOT, 'extension').toLowerCase().replace(/[\\/]+$/, '');
    for (const m of ini.matchAll(/^Path=(.+)$/gm)) {
      const rel = m[1].trim();
      const dir = path.isAbsolute(rel) ? rel : path.join(zen, rel);
      try {
        const target = fs.readFileSync(path.join(dir, 'extensions', 'claude-in-zen@f.local'), 'utf8').trim();
        if (path.resolve(target).toLowerCase().replace(/[\\/]+$/, '') === want) return true;
      } catch {}
    }
  } catch {}
  return false;
}

let updating = false;
function updateAddon() {
  const done = (ok, error, version, note) => {
    updating = false;
    sendAddon({ type: 'update_result', ok, error: error || '', version: version || '', note: note || '' });
  };
  if (updating) return;
  const info = sourceInfo();
  if (!info.canUpdate) return done(false, 'This copy has no add-on source to build from. Install the newer .xpi you were sent instead.');
  updating = true;
  log.info(`update: installing v${info.sourceVersion}`);
  // Zen gives its child processes (this helper included) variables that change how a new zen.exe starts.
  // install-xpi.ps1 drops them too; dropping them here keeps PowerShell itself clean.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(MOZ_|XRE_|XUL_|MOZILLA_)/i.test(k)) delete env[k];
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'install-xpi.ps1'), '-Quiet'],
    { cwd: ROOT, env, timeout: 120000, windowsHide: true }, (err, stdout) => {
      const lines = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (err && err.code === 2) return done(false, 'Zen is linked to the project folder, so the add-on reloads instead of reinstalling.');
      if (err) return done(false, (lines.find(l => /failed/i.test(l)) || lines.pop() || err.message).slice(0, 300));
      done(true, '', info.sourceVersion, lines.find(l => /signed build|unsigned/i.test(l)) || '');
    });
}

// ------------------------------------------------------------------ accounts
// Every chat account is its own Claude Code profile folder: "main" is the one "Sign in Claude Code.bat" signs in,
// added accounts live in accounts\<id>. Switching only changes which folder chat turns use, so nothing is ever
// logged out to switch and each account keeps its own sign-in, like Google's account switcher.

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
let acc = loadAccounts();
let login = null;   // the open sign-in window: { id, dir, isNew, started, timer }

// Settings > Tools and plugins: per account (each account is its own Claude Code profile).
const toolbox = createToolbox({ findClaude, claudeEnv, dirOf: id => accountDir(id), emit: m => sendAddon(m) });

function loadAccounts() {
  let a = {};
  try { a = JSON.parse(fs.readFileSync(P.ACCOUNTS_FILE, 'utf8')) || {}; } catch {}
  return {
    active: typeof a.active === 'string' ? a.active : 'main',
    meta: a.meta && typeof a.meta === 'object' ? a.meta : {},
    hidden: Array.isArray(a.hidden) ? a.hidden.filter(x => typeof x === 'string') : [],
  };
}

function saveAccounts() {
  try { fs.writeFileSync(P.ACCOUNTS_FILE, JSON.stringify(acc, null, 2)); } catch (e) { log.error('accounts.json', e.message); }
}

const ADDED_ID = /^a[0-9a-z]{4,24}$/;

function accountIds() {
  const ids = acc.hidden.includes('main') ? [] : ['main'];
  try {
    for (const d of fs.readdirSync(P.ACCOUNTS_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && ADDED_ID.test(d.name) && !acc.hidden.includes(d.name)) ids.push(d.name);
    }
  } catch {}
  return ids;
}

function accountDir(id) { return id === 'main' || !ADDED_ID.test(id) ? P.CLAUDE_CONFIG_DIR : path.join(P.ACCOUNTS_DIR, id); }

function activeId() {
  const ids = accountIds();
  return ids.includes(acc.active) ? acc.active : (ids[0] || 'main');
}

function removeAccountDir(id) {
  if (!ADDED_ID.test(id)) return;   // never touch "main" or anything outside accounts\
  try { fs.rmSync(path.join(P.ACCOUNTS_DIR, id), { recursive: true, force: true }); } catch (e) { log.warn('remove account dir', e.message); }
}

async function listAccounts() {
  const ids = accountIds();
  if (acc.hidden.includes('main')) {
    // "Sign in Claude Code.bat" may have signed the removed main profile back in: show it again.
    const s = await statusOf(P.CLAUDE_CONFIG_DIR);
    if (s.loggedIn) { acc.hidden = acc.hidden.filter(x => x !== 'main'); ids.unshift('main'); }
  }
  const active = activeId();
  const rows = await Promise.all(ids.map(async id => {
    const s = await statusOf(accountDir(id));
    const m = acc.meta[id] || {};
    const email = String(s.email || s.emailAddress || m.email || '');
    const plan = String(s.subscriptionType || m.plan || '');
    if (s.loggedIn && email) acc.meta[id] = Object.assign({}, m, { email, plan });
    return {
      id, email, plan, loggedIn: !!s.loggedIn, active: id === active,
      org: String(s.orgName || s.organizationName || ''), lastUsed: Number(m.lastUsed) || 0,
    };
  }));
  saveAccounts();
  rows.sort((a, b) => (b.active - a.active) || (b.loggedIn - a.loggedIn) || (b.lastUsed - a.lastUsed));
  return rows;
}

let accountsSeq = 0;
function sendAccounts() {
  const seq = ++accountsSeq;   // same rule as sendStatus: only the newest list reaches the panel
  listAccounts()
    .then(rows => { if (seq === accountsSeq) sendAddon({ type: 'accounts', accounts: rows, login: login ? { id: login.id, isNew: login.isNew } : null }); })
    .catch(e => log.error('accounts', e.message));
}

function accountDone(action, id, ok, error, extra) {
  sendAddon(Object.assign({ type: 'account_result', action, id, ok: !!ok, error: error || '' }, extra || {}));
}

function afterAccountChange() {
  sendStatus();
  sendAccounts();
}

function useAccount(id) {
  if (chat) return accountDone('use', id, false, 'Claude is still answering. Switch accounts after it finishes.');
  if (!accountIds().includes(id)) return accountDone('use', id, false, 'That account is not on this PC any more.');
  acc.active = id;
  acc.meta[id] = Object.assign({}, acc.meta[id], { lastUsed: Date.now() });
  saveAccounts();
  log.info(`accounts: using ${id}`);
  accountDone('use', id, true, '', { email: (acc.meta[id] || {}).email || '' });
  afterAccountChange();
}

function addAccount() {
  if (login) return accountDone('add', login.id, false, 'A sign-in window is already open. Finish it or press Cancel.');
  if (chat) return accountDone('add', '', false, 'Claude is still answering. Add the account after it finishes.');
  const id = 'a' + Date.now().toString(36);
  startLogin(id, true);
}

function signInAccount(id) {
  if (login) return accountDone('signin', login.id, false, 'A sign-in window is already open. Finish it or press Cancel.');
  if (!accountIds().includes(id)) return accountDone('signin', id, false, 'That account is not on this PC any more.');
  startLogin(id, false);
}

// "claude auth login" in a console window of its own, so the user sees what it says. On Windows a small .cmd
// file runs it (the window stays open long enough to read the result); elsewhere (tests) it runs directly.
function openLoginWindow(exe, dir) {
  if (process.platform === 'win32') {
    const q = v => String(v).replace(/%/g, '%%');
    const script = path.join(P.BASE, 'sign-in.cmd');
    const lines = [
      '@echo off', 'chcp 65001 >nul', 'title Claude in Zen - add a Claude account',
      `set "CLAUDE_CONFIG_DIR=${q(dir)}"`, 'set "ANTHROPIC_API_KEY="', 'set "ANTHROPIC_AUTH_TOKEN="', 'set "CLAUDE_CODE_OAUTH_TOKEN="',
      'echo A browser window opens. Sign in to the Claude account you want, then click Authorize.', 'echo.',
      `"${q(exe)}" auth login`, 'echo.', `"${q(exe)}" auth status --text`, 'echo.',
      'echo The Claude in Zen panel picks this up on its own. You can close this window.', 'timeout /t 15 >nul',
    ];
    fs.writeFileSync(script, lines.join('\r\n') + '\r\n', 'utf8');
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" "${script}""`],
      { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', e => log.warn('sign-in window', e.message));
    child.unref();
    return;
  }
  const child = spawn(exe, ['auth', 'login'], { env: claudeEnv(dir), cwd: P.WORKSPACE, detached: true, stdio: 'ignore' });
  child.on('error', e => log.warn('auth login', e.message));
  child.unref();
}

function startLogin(id, isNew) {
  const action = isNew ? 'add' : 'signin';
  const exe = findClaude();
  if (!exe) return accountDone(action, id, false, 'Claude Code is not installed on this PC.');
  const dir = accountDir(id);
  try { fs.mkdirSync(dir, { recursive: true }); openLoginWindow(exe, dir); }
  catch (e) { if (isNew) removeAccountDir(id); return accountDone(action, id, false, `Could not open the sign-in window: ${e.message}`); }
  login = { id, dir, isNew, started: Date.now(), timer: null };
  log.info(`accounts: sign-in window open for ${isNew ? 'a new account' : id}`);
  accountDone('login_started', id, true, '', { isNew });
  const poll = async () => {
    if (!login || login.id !== id) return;
    const s = await statusOf(dir);
    if (!login || login.id !== id) return;
    if (s.loggedIn) return finishLogin(true, s);
    if (Date.now() - login.started > LOGIN_TIMEOUT_MS) return finishLogin(false, null, 'The sign-in was not finished within 10 minutes.');
    login.timer = setTimeout(poll, 3000);
  };
  login.timer = setTimeout(poll, 4000);
}

function finishLogin(ok, status, error) {
  const L = login;
  if (!L) return;
  login = null;
  clearTimeout(L.timer);
  if (!ok) {
    if (L.isNew) removeAccountDir(L.id);
    accountDone('login', L.id, false, error || 'Sign-in failed.');
    return afterAccountChange();
  }
  const email = String(status.email || status.emailAddress || '');
  const dupe = L.isNew && email && accountIds().find(k => k !== L.id && ((acc.meta[k] || {}).email || '').toLowerCase() === email.toLowerCase());
  let id = L.id;
  if (dupe) { removeAccountDir(L.id); id = dupe; }   // already on the list: just switch to it
  acc.active = id;
  acc.meta[id] = Object.assign({}, acc.meta[id], { email, plan: String(status.subscriptionType || ''), lastUsed: Date.now() });
  saveAccounts();
  log.info(`accounts: signed in, now using ${id}`);
  accountDone('login', id, true, '', { email, already: !!dupe });
  afterAccountChange();
}

function removeAccount(id) {
  if (!accountIds().includes(id)) return accountDone('remove', id, false, 'That account is not on this PC any more.');
  if (login && login.id === id) return accountDone('remove', id, false, 'Finish or cancel its sign-in window first.');
  if (id === activeId() && accountIds().length > 1) return accountDone('remove', id, false, 'Switch to another account before removing this one.');
  if (chat) return accountDone('remove', id, false, 'Claude is still answering. Remove the account after it finishes.');
  const exe = findClaude();
  const finish = () => {
    if (id === 'main') { if (!acc.hidden.includes('main')) acc.hidden.push('main'); }
    else removeAccountDir(id);
    delete acc.meta[id];
    if (acc.active === id) acc.active = accountIds()[0] || 'main';
    saveAccounts();
    log.info(`accounts: removed ${id}`);
    accountDone('remove', id, true);
    afterAccountChange();
  };
  if (!exe) return finish();
  execFile(exe, ['auth', 'logout'], { env: claudeEnv(accountDir(id)), timeout: 20000, windowsHide: true }, finish);
}

// ------------------------------------------------------------------ shutdown

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down: ${reason}`);
  cancelChat('*', 'Stopped.');
  if (login) { clearTimeout(login.timer); login = null; }   // the window itself stays: finishing it still works later
  for (const c of clients.values()) { try { c.sock.destroy(); } catch {} }
  try { server.close(); } catch {}
  try { if (fs.readFileSync(P.TOKEN_FILE, 'utf8') === token) fs.unlinkSync(P.TOKEN_FILE); } catch {}
  setTimeout(() => process.exit(0), 50);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => log.error('uncaught', e.stack || e.message));
