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

const VERSION = '0.3.0';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const P = require('./lib/paths');
const log = require('./lib/log');
const { NativeChannel } = require('./lib/nm');
const { onLines, sendLine } = require('./lib/lines');

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
fs.writeFileSync(P.TOKEN_FILE, token);
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

function onAddon(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      addonVersion = String(msg.version || '?');
      log.info(`add-on ${addonVersion} connected`);
      sendAddon({ type: 'hello', version: VERSION, server: `host ${VERSION}`, clients: clientNames() });
      return;

    case 'result': {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      log.info(`result ${p.tool} ${msg.ok ? 'ok' : 'error'} ${Date.now() - p.started} ms`);
      const c = clients.get(p.clientId);
      if (c) sendLine(c.sock, { type: 'result', id: p.callId, ok: !!msg.ok, result: msg.result, error: msg.error });
      return;
    }

    case 'claude_status':
      claudeStatus().then(status => sendAddon({ type: 'claude_status', ...status }));
      return;

    case 'ping':
      sendAddon({ type: 'pong', t: msg.t });
      return;
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

// Environment for every Claude Code process the host starts: the add-on's own profile folder,
// and no API-key or third-party-provider variables, so usage always runs on the user's plan.
function claudeEnv() {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: P.CLAUDE_CONFIG_DIR };
  for (const k of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  ]) delete env[k];
  return env;
}

function claudeStatus() {
  return new Promise(resolve => {
    const exe = findClaude();
    if (!exe) return resolve({ installed: false, loggedIn: false });
    execFile(exe, ['auth', 'status'], { env: claudeEnv(), timeout: 20000, windowsHide: true }, (err, stdout) => {
      let info = {};
      try { info = JSON.parse(String(stdout || '').trim() || '{}'); } catch {}
      const pick = {};
      for (const k of ['authMethod', 'email', 'emailAddress', 'organizationName', 'orgName', 'subscriptionType']) {
        if (typeof info[k] === 'string') pick[k] = info[k];
      }
      const loggedIn = typeof info.loggedIn === 'boolean' ? info.loggedIn : (!err && pick.authMethod !== 'none');
      resolve({ installed: true, loggedIn, ...pick });
    });
  });
}

// ------------------------------------------------------------------ shutdown

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down: ${reason}`);
  for (const c of clients.values()) { try { c.sock.destroy(); } catch {} }
  try { server.close(); } catch {}
  try { if (fs.readFileSync(P.TOKEN_FILE, 'utf8') === token) fs.unlinkSync(P.TOKEN_FILE); } catch {}
  setTimeout(() => process.exit(0), 50);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => log.error('uncaught', e.stack || e.message));
