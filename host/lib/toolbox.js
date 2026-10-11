'use strict';
// Tools and plugins for the panel chat (Settings > Tools and plugins).
//
// Each account's Claude Code profile can hold three kinds of extra tools:
//   - claude.ai connectors, which come with the Claude account (Gmail, Claude Docs...);
//   - plugins, synced from claude.ai or installed from a marketplace (vidIQ...): skills plus tool servers;
//   - tool servers the user added by URL or command ("claude mcp add").
// The panel chat runs none of them until the user switches them on. This module lists them, keeps the switches
// (tools.json), opens sign-in windows for servers that need OAuth, adds and removes servers, and turns the switches
// into the flags of each chat turn: only switched-on servers load and are allowed, and every plugin that is off is
// disabled for the turn, so its skills, agents and hooks stay out as well.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const P = require('./paths');
const log = require('./log');

const SAFE_NAME = /^[\w .:@()+'-]{1,120}$/;            // server and plugin names as Claude Code shows them
const NEW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;    // names for servers the user adds
const PLUGIN_SPEC = /^[A-Za-z0-9][\w.-]{0,80}(@[A-Za-z0-9][\w.-]{0,80})?$/;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const RESCAN_MS = 30 * 60 * 1000;
const RANK = { 'needs-auth': 5, failed: 4, 'not-configured': 3, pending: 2, unknown: 1, connected: 0 };
// Plugins the user called essential: listed first, and on until the user turns them off (unless they run programs
// on this PC: those wait for the user's yes, like any other).
const RECOMMENDED = ['vidiq', 'caveman'];

// Tool servers that give Claude a shell: any command, and any file on this PC, past the guard's deny rules (those
// cover Claude Code's own file tools only). The panel chat never gets one, whatever its switch says: no shell in any
// mode. Matched as whole names in a plugin's name or label, a server's name, or the command or address that starts it.
const SHELL_TOOLS = ['desktop-commander', 'mcp-server-commands', 'server-win-cli', 'win-cli-mcp-server', 'cli-mcp-server',
  'mcp-shell', 'mcp-shell-server', 'shell-mcp-server', 'mcp-server-shell', 'terminal-mcp', 'iterm-mcp'];
const SHELL_WHY = 'It gives Claude a shell: it can run any command and read or change any file on this PC, so Claude in Zen never switches it on.';
function shellText(...texts) {
  return texts.some(t => {
    const s = String(t || '').toLowerCase().replace(/_/g, '-');
    return SHELL_TOOLS.includes(s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')) || s.split(/[^a-z0-9-]+/).some(w => SHELL_TOOLS.includes(w));
  });
}

// How Claude Code names a server's tools: mcp__<name with anything but letters, digits, _ and - turned to _>__<tool>.
const norm = name => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

function readJson(file, max) {
  try {
    if (fs.statSync(file).size > (max || 1024 * 1024)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function transportOf(cfg) {
  const t = String((cfg && cfg.type) || '').toLowerCase();
  if (t === 'http' || t === 'streamable-http') return 'http';
  if (t === 'sse' || t === 'ws') return t;
  if (cfg && cfg.command) return 'stdio';
  return cfg && cfg.url ? 'http' : 'unknown';
}

function targetOf(cfg) {
  if (!cfg) return '';
  if (cfg.url) return String(cfg.url).slice(0, 200);
  return [cfg.command].concat(Array.isArray(cfg.args) ? cfg.args : []).filter(Boolean).join(' ').slice(0, 200);
}

// "claude mcp list" / "claude mcp get" status text, or an init status code, to one short code.
function statusOf(text) {
  const s = String(text || '');
  if (/needs[ -]?auth/i.test(s)) return 'needs-auth';
  if (/fail|error/i.test(s)) return 'failed';
  if (/not configured/i.test(s)) return 'not-configured';
  if (/pending/i.test(s)) return 'pending';
  if (/connected/i.test(s)) return 'connected';
  return 'unknown';
}

const failDetail = s => String(s || '').replace(/^[^A-Za-z]*Failed to connect\s*[—-]?\s*/i, '').slice(0, 160);

// One line of "claude mcp list" is "<name>: <url or command> - <status>". Names can hold colons ("plugin:vidiq:vidiq")
// and spaces ("claude.ai Gmail") but never ": ", and the status follows the last " - ".
function parseList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(.+?): (.*) - (.+)$/.exec(line);
    if (!m || !SAFE_NAME.test(m[1])) continue;
    const name = m[1];
    let target = m[2].trim();
    let transport = 'stdio';
    const t = /\((HTTP|SSE|WS)\)$/i.exec(target);
    if (t) { transport = t[1].toLowerCase(); target = target.slice(0, t.index).trim(); }
    else if (/^https?:\/\//i.test(target) || name.startsWith('claude.ai ')) transport = 'http';
    const status = statusOf(m[3]);
    out.push({ name, target: target.slice(0, 200), transport, status, detail: status === 'failed' ? failDetail(m[3]) : '' });
  }
  return out;
}

function kindOf(name) {
  if (name.startsWith('claude.ai ')) return { kind: 'connector', label: name.slice(10) };
  const m = /^plugin:([^:]+):(.+)$/.exec(name);
  if (m) return { kind: 'plugin', plugin: m[1], label: m[2] };
  return { kind: 'added', label: name };
}

// Splits a command line the simple way: spaces separate words, "double quotes" group them.
function splitCommand(s) {
  const out = [];
  let cur = '', q = false, any = false;
  for (const ch of String(s || '')) {
    if (ch === '"') { q = !q; any = true; continue; }
    if (!q && /\s/.test(ch)) { if (any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch; any = true;
  }
  if (any) out.push(cur);
  return out;
}

function firstLine(s) {
  return String(s || '').split(/\r?\n/).map(l => l.trim())
    .filter(l => l && !/^\[mcp-sdk\]|^At line|^\+ |CategoryInfo|FullyQualifiedErrorId/.test(l))[0] || '';
}

// confirm({ title, text, yes, no }) -> Promise<{ ok, error }>: the confirm window (lib/confirm.js), for what runs programs.
function createToolbox({ findClaude, claudeEnv, dirOf, emit, file, confirm }) {
  const FILE = file || path.join(P.BASE, 'tools.json');
  let st = load();
  let busy = null;            // 'checking' | 'adding' | 'removing' | 'installing' while a slow command runs
  let login = null;           // { key, name, label, started, timer }
  const scans = new Map();    // key -> promise of the running scan

  function load() {
    const j = readJson(FILE, 8 * 1024 * 1024) || {};
    const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && SAFE_NAME.test(x)).slice(0, 200) : []);
    return {
      on: { plugins: list(j.on && j.on.plugins), servers: list(j.on && j.on.servers) },
      decided: list(j.decided),   // plugin ids the user switched by hand: defaults never touch them again
      cat: j.cat && typeof j.cat === 'object' && !Array.isArray(j.cat) ? j.cat : {},
    };
  }

  function save() {
    try { fs.writeFileSync(FILE, JSON.stringify(st, null, 2)); } catch (e) { log.error('tools.json', e.message); }
  }

  function cat(key) {
    const c = st.cat[key];
    if (c && Array.isArray(c.plugins) && Array.isArray(c.servers)) return c;
    st.cat[key] = { plugins: [], servers: [], scanned: 0, checked: 0 };
    return st.cat[key];
  }

  function run(key, args, ms) {
    return new Promise(resolve => {
      const exe = findClaude();
      if (!exe) return resolve({ ok: false, out: '', err: 'Claude Code is not installed on this PC.' });
      try { fs.mkdirSync(P.WORKSPACE, { recursive: true }); } catch {}
      execFile(exe, args, { env: claudeEnv(dirOf(key)), cwd: P.WORKSPACE, timeout: ms || 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout || ''), err: String(stderr || '') || (error ? error.message : '') }));
    });
  }

  function upsertServer(c, s) {
    const at = c.servers.findIndex(x => x.name === s.name);
    if (at === -1) { c.servers.push(Object.assign({ status: 'unknown', detail: '' }, s)); return; }
    c.servers[at] = Object.assign({}, c.servers[at], s);
  }

  function readManifest(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return {};
    return readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || readJson(path.join(dir, 'plugin.json')) || {};
  }

  // The tool servers a plugin brings: inline in its manifest, in files it names, or in its own .mcp.json.
  function pluginServers(p, man) {
    const found = new Map();
    const add = obj => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      const map = obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj;
      for (const [k, v] of Object.entries(map)) {
        if (v && typeof v === 'object' && (v.url || v.command || v.type) && SAFE_NAME.test(k) && !found.has(k)) {
          found.set(k, { key: k, transport: transportOf(v), target: targetOf(v) });
        }
      }
    };
    if (p.mcpServers && typeof p.mcpServers === 'object') add(p.mcpServers);
    const dir = typeof p.installPath === 'string' && path.isAbsolute(p.installPath) ? p.installPath : '';
    const ref = man.mcpServers;
    const refs = ref == null ? ['./.mcp.json'] : Array.isArray(ref) ? ref : [ref];
    for (const r of refs) {
      if (typeof r === 'string') {
        if (!dir) continue;
        const f = path.resolve(dir, r);
        if (inside(f, dir)) add(readJson(f));
      } else add(r);
    }
    return [...found.values()];
  }

  // Fast look that starts nothing: the account's plugins (and the servers they declare) and the servers added with
  // "claude mcp add --scope user". Connectors only show up after a check, so the last ones found are kept.
  function scan(key) {
    if (scans.has(key)) return scans.get(key);
    const job = (async () => {
      const c = cat(key);
      const r = await run(key, ['plugin', 'list', '--json'], 45000);
      let list = null;
      try { list = JSON.parse(r.out.trim() || 'null'); } catch {}
      if (Array.isArray(list)) {
        const plugins = [];
        const prev = new Map(c.servers.map(s => [s.name, s]));
        const rows = [];
        for (const p of list.slice(0, 300)) {
          if (!p || typeof p.id !== 'string' || !SAFE_NAME.test(p.id)) continue;
          const name = p.id.split('@')[0];
          const man = readManifest(p.installPath);
          const servers = pluginServers(p, man);
          const dir = typeof p.installPath === 'string' ? p.installPath : '';
          plugins.push({
            id: p.id, name, dir: dir && path.isAbsolute(dir) ? dir : '',
            label: String(man.displayName || man.name || name).replace(/\s+/g, ' ').slice(0, 60),
            version: String(p.version || man.version || '').slice(0, 20),
            scope: String(p.scope || '').slice(0, 20),
            description: String(man.description || '').replace(/\s+/g, ' ').slice(0, 220),
            skills: !!(man.skills || (dir && isDir(path.join(dir, 'skills')))),
            servers: servers.map(s => `plugin:${name}:${s.key}`),
            local: servers.some(s => s.transport === 'stdio'),
            // Hooks are commands Claude Code runs at chat events, so they run programs on this PC too.
            hooks: !!(man.hooks || (dir && path.isAbsolute(dir) && isFile(path.join(dir, 'hooks', 'hooks.json')))),
          });
          for (const s of servers) {
            const full = `plugin:${name}:${s.key}`;
            const old = prev.get(full) || {};
            rows.push({ name: full, kind: 'plugin', plugin: p.id, label: s.key, transport: s.transport, target: s.target,
              local: s.transport === 'stdio', status: old.status || 'unknown', detail: old.detail || '' });
          }
        }
        c.plugins = plugins;
        c.servers = c.servers.filter(s => s.kind !== 'plugin').concat(rows);
        for (const p of plugins) {
          if (RECOMMENDED.includes(p.name) && !runsOf(p, c).length && !shellPlugin(p, c) && !st.decided.includes(p.id) && !st.on.plugins.includes(p.id)) st.on.plugins.push(p.id);
        }
      } else if (!r.ok) {
        log.warn('tools: plugin list failed', firstLine(r.err).slice(0, 200));
      }
      // Servers added at user scope live in the profile's .claude.json.
      const cfg = readJson(path.join(dirOf(key), '.claude.json'), 64 * 1024 * 1024);
      if (cfg) {
        const user = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
        const names = new Set();
        for (const [name, v] of Object.entries(user)) {
          if (!SAFE_NAME.test(name) || !v || typeof v !== 'object') continue;
          names.add(name);
          upsertServer(c, { name, kind: 'added', label: name, transport: transportOf(v), target: targetOf(v), local: transportOf(v) === 'stdio' });
        }
        c.servers = c.servers.filter(s => s.kind !== 'added' || names.has(s.name));
      }
      c.scanned = Date.now();
      save();
      return c;
    })().finally(() => scans.delete(key));
    scans.set(key, job);
    return job;
  }

  async function ensureFresh(key) {
    const c = cat(key);
    if (!c.scanned || Date.now() - c.scanned > RESCAN_MS) await scan(key);
  }

  // Full check with "claude mcp list": starts every server once to see whether it answers, and lists the
  // claude.ai connectors (only claude.ai knows those).
  async function check(key) {
    if (busy) return;
    busy = 'checking';
    push(key);
    try {
      await scan(key);
      const r = await run(key, ['mcp', 'list'], 150000);
      const found = parseList(r.out);
      const c = cat(key);
      if (found.length) {
        const seen = new Set();
        for (const f of found) {
          const k = kindOf(f.name);
          seen.add(f.name);
          const row = { name: f.name, kind: k.kind, label: k.label, transport: f.transport, target: f.target, local: f.transport === 'stdio', status: f.status, detail: f.detail };
          if (k.kind === 'plugin') row.plugin = (c.plugins.find(p => p.name === k.plugin) || {}).id || '';
          upsertServer(c, row);
        }
        c.servers = c.servers.filter(s => s.kind !== 'connector' || seen.has(s.name));
        c.checked = Date.now();
        save();
      } else if (!r.ok) {
        emitResult('check', false, `Check failed: ${firstLine(r.err) || 'no answer from Claude Code'}`);
      }
    } finally { busy = null; push(key); }
  }

  // One server's status, with "claude mcp get".
  async function refreshOne(key, name) {
    const r = await run(key, ['mcp', 'get', name], 60000);
    const m = /Status:\s*(.+)/i.exec(r.out);
    if (!m) return null;
    const status = statusOf(m[1]);
    const s = cat(key).servers.find(x => x.name === name);
    if (s) {
      s.status = status;
      s.detail = status === 'failed' ? failDetail(m[1]) : '';
      save();
    }
    return status;
  }

  function labelOf(c, name) {
    const s = c.servers.find(x => x.name === name);
    if (s && s.kind === 'plugin') {
      const p = c.plugins.find(x => x.id === s.plugin);
      if (p) return p.servers.length > 1 ? `${p.label} (${s.label})` : p.label;
    }
    return s ? s.label : name;
  }

  // Tool names arrive as mcp__<normalized server>__<tool>: the server's label, for the panel's step list.
  function labelFor(key, normalized) {
    const c = cat(key);
    const s = c.servers.find(x => norm(x.name) === normalized);
    return s ? labelOf(c, s.name) : String(normalized).replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  }

  // A shell (see SHELL_TOOLS): the plugin itself, or any tool server it brings.
  function shellPlugin(p, c) {
    if (shellText(p.id, p.name, p.label)) return true;
    return (p.servers || []).some(n => { const s = c.servers.find(x => x.name === n); return shellText(n, s && s.label, s && s.target); });
  }
  function shellServer(s) { return shellText(s.name, s.label, s.target); }

  // What a plugin runs on this PC, for the confirm window: the commands that start its local tool servers, and its
  // hooks. Empty when it runs nothing here (skills, and servers reached by address).
  function runsOf(p, c) {
    const out = (p.servers || []).map(n => c.servers.find(s => s.name === n)).filter(s => s && s.transport === 'stdio').map(s => s.target || s.label);
    if (!out.length && p.local) out.push('its tool server');
    if (p.hooks) out.push('its hooks (commands that run at chat events)');
    return out;
  }

  function chatOptions(key) {
    const c = cat(key);
    const onP = new Set(st.on.plugins), onS = new Set(st.on.servers);
    const enabledPlugins = {};
    // A shell stays off and out even when tools.json says it is on (switched on before shells were refused).
    for (const p of c.plugins) enabledPlugins[p.id] = onP.has(p.id) && !shellPlugin(p, c);
    const allow = [], deny = [], extras = [];
    let connector = false;
    for (const p of c.plugins) {
      if (!enabledPlugins[p.id]) continue;
      allow.push(...p.servers);
      extras.push({ label: p.label, kind: 'plugin', skills: !!p.skills, description: p.description });
    }
    for (const s of c.servers) {
      if (s.kind === 'plugin') continue;   // plugin servers come and go with their plugin
      if (onS.has(s.name) && !shellServer(s)) {
        allow.push(s.name);
        extras.push({ label: s.label, kind: s.kind });
        if (s.kind === 'connector') connector = true;
      } else deny.push(s.name);
    }
    const settings = { enabledPlugins };
    if (!connector) settings.disableClaudeAiConnectors = true;
    if (deny.length) settings.deniedMcpServers = deny.map(serverName => ({ serverName }));
    const servers = [...new Set(allow)];
    return {
      strict: servers.length === 0,
      settings,
      allowTools: servers.map(n => 'mcp__' + norm(n)),
      skills: c.plugins.some(p => onP.has(p.id) && p.skills),
      extras,
      servers,
    };
  }

  // What Claude Code reported at the start of a chat turn (system/init mcp_servers). Returns the switched-on servers
  // that cannot be used right now, so the chat can say what to do.
  function learn(key, servers) {
    if (!Array.isArray(servers)) return [];
    const c = cat(key);
    const allowed = new Set(chatOptions(key).servers);
    const problems = [];
    let changed = false;
    for (const s of servers.slice(0, 200)) {
      if (!s || typeof s.name !== 'string' || !SAFE_NAME.test(s.name) || s.name === 'claude-in-zen') continue;
      const status = statusOf(s.status);
      const k = kindOf(s.name);
      const row = c.servers.find(x => x.name === s.name);
      if (!row) {
        const add = { name: s.name, kind: k.kind, label: k.label, transport: 'unknown', target: '', local: false, status };
        if (k.kind === 'plugin') add.plugin = (c.plugins.find(p => p.name === k.plugin) || {}).id || '';
        upsertServer(c, add);
        changed = true;
      } else if (row.status !== status) { row.status = status; changed = true; }
      if (allowed.has(s.name) && (status === 'needs-auth' || status === 'failed')) problems.push({ name: s.name, label: labelOf(c, s.name), status });
    }
    if (changed) { save(); push(key); }
    return problems;
  }

  function worst(statuses) {
    if (!statuses.length) return 'none';
    return statuses.reduce((a, b) => ((RANK[b] || 0) > (RANK[a] || 0) ? b : a), 'connected');
  }

  function view(key) {
    const c = cat(key);
    const onP = new Set(st.on.plugins), onS = new Set(st.on.servers);
    const sv = s => {
      const blocked = shellServer(s) ? SHELL_WHY : '';
      return { name: s.name, label: s.label, status: s.status || 'unknown', detail: s.detail || '', transport: s.transport || '',
        local: !!s.local, target: s.target || '', on: onS.has(s.name) && !blocked, blocked };
    };
    return {
      type: 'tools', account: key, busy, scanned: c.scanned || 0, checked: c.checked || 0,
      login: login ? { name: login.name, label: login.label } : null,
      plugins: c.plugins.map(p => {
        const rows = p.servers.map(n => c.servers.find(s => s.name === n) || { name: n, label: n.split(':').pop(), status: 'unknown' });
        const blocked = shellPlugin(p, c) ? SHELL_WHY : '';
        // local: it runs programs on this PC (local tool servers or hooks).
        return { id: p.id, label: p.label, version: p.version, scope: p.scope, description: p.description, skills: p.skills, local: !!(p.local || p.hooks),
          recommended: RECOMMENDED.includes(p.name), on: onP.has(p.id) && !blocked, blocked, status: worst(rows.map(s => s.status || 'unknown')), servers: rows.map(sv) };
      }).sort((a, b) => (b.recommended - a.recommended) || (b.on - a.on) || a.label.localeCompare(b.label)),
      connectors: c.servers.filter(s => s.kind === 'connector').map(sv),
      added: c.servers.filter(s => s.kind === 'added').map(sv),
    };
  }

  function push(key) { emit(view(key)); }
  function emitResult(action, ok, error, extra) { emit(Object.assign({ type: 'tool_result', action, ok: !!ok, error: error || '' }, extra || {})); }

  // Switching on: a shell is refused outright; anything else that runs a program on this PC (a local tool server, a
  // plugin's hooks) waits for a yes in the confirm window, which the panel (a mod included) cannot answer. Switching
  // off never asks.
  async function set(key, kind, id, value) {
    const list = kind === 'plugin' ? st.on.plugins : kind === 'server' ? st.on.servers : null;
    if (!list || typeof id !== 'string' || !SAFE_NAME.test(id)) return;
    if (value) {
      const c = cat(key);
      const item = kind === 'plugin' ? c.plugins.find(p => p.id === id) : c.servers.find(s => s.name === id && s.kind !== 'plugin');
      const label = item ? (kind === 'plugin' ? item.label : labelOf(c, item.name)) : id;
      const refuse = error => { emitResult('set', false, error, { name: id, label }); push(key); };
      if (!item) return refuse(`${label}: that tool is not on the list any more. Press check.`);
      if (kind === 'plugin' ? shellPlugin(item, c) : shellServer(item)) return refuse(`${label}: ${SHELL_WHY}`);
      const runs = kind === 'plugin' ? runsOf(item, c) : item.kind === 'added' && item.local ? [item.target || item.name] : [];
      if (runs.length && !list.includes(id)) {
        const ok = confirm ? await confirm({ title: 'Claude in Zen: switch on something that runs programs?',
          text: `Switch on ${label}? Every chat with it on runs this on your PC, with your permissions:\n\n${runs.join('\n')}\n\nA web page could try to trick Claude into using it. Only switch on what you trust.`,
          yes: 'Switch on', no: 'Cancel' }) : { ok: false, error: 'There is no confirm window.' };
        if (!ok.ok) return refuse(`${label} stays off: ${ok.error}`);
      }
    }
    const at = list.indexOf(id);
    if (value && at === -1) list.push(id);
    if (!value && at !== -1) list.splice(at, 1);
    if (kind === 'plugin' && !st.decided.includes(id)) st.decided.push(id);
    save();
    push(key);
    if (!value) return;
    // Turned on: look at the status of what it brings, so a needed sign-in shows up right away.
    const c = cat(key);
    const names = kind === 'plugin' ? ((c.plugins.find(p => p.id === id) || {}).servers || []) : [id];
    let looked = false;
    for (const n of names.slice(0, 12)) {
      const s = c.servers.find(x => x.name === n);
      if (s && s.status === 'connected') continue;
      await refreshOne(key, n);
      looked = true;
    }
    if (looked) push(key);
  }

  // A console window runs "claude mcp login <name>", which opens the browser for the server's own sign-in. The
  // helper polls until the server answers as connected.
  function signIn(key, name) {
    if (login) return emitResult('signin', false, 'A sign-in window is already open. Finish it or press Cancel.');
    const c = cat(key);
    const s = c.servers.find(x => x.name === name);
    if (!s || !SAFE_NAME.test(name) || /["%^&|<>!]/.test(name)) return emitResult('signin', false, 'That tool is not on the list any more. Press check.');
    const exe = findClaude();
    if (!exe) return emitResult('signin', false, 'Claude Code is not installed on this PC.');
    const label = labelOf(c, name);
    const dir = dirOf(key);
    try {
      if (process.platform === 'win32') {
        const q = v => String(v).replace(/%/g, '%%');
        const plain = String(label).replace(/[^\w .()+-]/g, '');
        const script = path.join(P.BASE, 'tool-sign-in.cmd');
        const lines = [
          '@echo off', 'chcp 65001 >nul', `title Claude in Zen - sign in to ${plain}`,
          `set "CLAUDE_CONFIG_DIR=${q(dir)}"`, 'set "ANTHROPIC_API_KEY="', 'set "ANTHROPIC_AUTH_TOKEN="', 'set "CLAUDE_CODE_OAUTH_TOKEN="',
          `echo A browser window opens. Sign in to ${plain} there and allow access.`,
          'echo If the page does not open, copy the link shown below into your browser.', 'echo.',
          `"${q(exe)}" mcp login "${q(name)}"`, 'echo.',
          'echo The Claude in Zen panel picks this up on its own. You can close this window.', 'timeout /t 20 >nul',
        ];
        fs.writeFileSync(script, lines.join('\r\n') + '\r\n', 'utf8');
        const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" "${script}""`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', e => log.warn('tool sign-in window', e.message));
        child.unref();
      } else {
        const child = spawn(exe, ['mcp', 'login', name], { env: claudeEnv(dir), cwd: P.WORKSPACE, detached: true, stdio: 'ignore' });
        child.on('error', e => log.warn('mcp login', e.message));
        child.unref();
      }
    } catch (e) { return emitResult('signin', false, `Could not open the sign-in window: ${e.message}`); }
    login = { key, name, label, started: Date.now(), timer: null };
    log.info(`tools: sign-in window open for ${name}`);
    emitResult('signin_started', true, '', { name, label });
    push(key);
    const poll = async () => {
      if (!login || login.name !== name) return;
      const status = await refreshOne(key, name);
      if (!login || login.name !== name) return;
      if (status === 'connected') return finishSignIn(true);
      if (Date.now() - login.started > LOGIN_TIMEOUT_MS) return finishSignIn(false, 'The sign-in was not finished within 10 minutes.');
      login.timer = setTimeout(poll, 4000);
    };
    login.timer = setTimeout(poll, 5000);
  }

  function finishSignIn(ok, error) {
    const L = login;
    if (!L) return;
    login = null;
    clearTimeout(L.timer);
    log.info(`tools: sign-in for ${L.name} ${ok ? 'done' : 'ended: ' + error}`);
    emitResult('signin', ok, error || '', { name: L.name, label: L.label });
    push(L.key);
  }

  function cancelSignIn() { if (login) finishSignIn(false, 'Cancelled.'); }

  async function add(key, spec) {
    if (busy) return emitResult('add', false, 'Wait for the last change to finish.');
    const name = String((spec && spec.name) || '').trim();
    const target = String((spec && spec.target) || '').trim();
    if (!NEW_NAME.test(name)) return emitResult('add', false, 'Name: up to 40 letters, digits, - or _, starting with a letter or digit.');
    if (shellText(name, target)) return emitResult('add', false, `Not added. ${SHELL_WHY}`);
    const c = cat(key);
    if (c.servers.some(s => s.name.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === 'claude-in-zen') {
      return emitResult('add', false, `There is already a tool called ${name}.`);
    }
    let args;
    let local = false;
    if (/^https?:\/\//i.test(target)) {
      let u;
      try { u = new URL(target); } catch { return emitResult('add', false, 'That is not a valid address.'); }
      const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
      if (u.protocol !== 'https:' && !loopback) return emitResult('add', false, 'Use an https:// address (plain http only works for this PC).');
      args = ['mcp', 'add', '--scope', 'user', '--transport', /\/sse\/?$/i.test(u.pathname) ? 'sse' : 'http'];
      const header = String((spec && spec.header) || '').trim();
      if (header) {
        if (!/^[A-Za-z0-9-]{1,60}:\s*\S[^\r\n]{0,4000}$/.test(header)) return emitResult('add', false, 'Header: write it as Name: value, for example Authorization: Bearer abc123.');
        args.push('--header', header);
      }
      args.push(name, u.href);
    } else {
      const parts = splitCommand(target);
      if (!parts.length || target.length > 2000) return emitResult('add', false, 'Give the server\'s address (https://...) or the command that starts it.');
      if (process.platform === 'win32' && /^(npx|npm|pnpm|yarn|bunx|uvx)(\.cmd)?$/i.test(parts[0])) parts.unshift('cmd', '/c');
      args = ['mcp', 'add', '--scope', 'user', name, '--', ...parts];
      local = true;
    }
    busy = 'adding';
    push(key);
    try {
      // A tool that runs a program on this PC is the user's call, made in the confirm window, which nothing in the
      // add-on or the panel (a mod included) can answer for them.
      if (local) {
        const ok = confirm ? await confirm({ title: 'Claude in Zen: add a tool that runs a program?',
          text: `Add the tool "${name}"? Every chat with it switched on runs this on your PC:\n\n${target}\n\nOnly add tools you trust.`,
          yes: 'Add tool', no: 'Cancel' }) : { ok: false, error: 'There is no confirm window.' };
        if (!ok.ok) return emitResult('add', false, `Not added: ${ok.error}`);
      }
      const r = await run(key, args, 90000);
      if (!r.ok) return emitResult('add', false, `Claude Code did not add it: ${firstLine(r.err) || firstLine(r.out) || 'unknown error'}`);
      if (spec.on && !st.on.servers.includes(name)) { st.on.servers.push(name); save(); }
      await scan(key);
      await refreshOne(key, name);
      log.info(`tools: added ${name} (${local ? 'command' : 'address'})`);
      emitResult('add', true, '', { name, local });
    } finally { busy = null; push(key); }
  }

  async function remove(key, name) {
    if (busy) return emitResult('remove', false, 'Wait for the last change to finish.');
    const c = cat(key);
    const s = c.servers.find(x => x.name === name);
    if (!s || s.kind !== 'added') return emitResult('remove', false, 'Only tools you added can be removed here.');
    busy = 'removing';
    push(key);
    try {
      const r = await run(key, ['mcp', 'remove', '--scope', 'user', name], 60000);
      if (!r.ok && !/not found|no .*server/i.test(r.err + r.out)) return emitResult('remove', false, `Claude Code did not remove it: ${firstLine(r.err) || firstLine(r.out)}`);
      st.on.servers = st.on.servers.filter(x => x !== name);
      c.servers = c.servers.filter(x => x.name !== name);
      save();
      await scan(key);
      log.info(`tools: removed ${name}`);
      emitResult('remove', true, '', { name });
    } finally { busy = null; push(key); }
  }

  // Installs a plugin from a marketplace ("name@marketplace"; with a source, that marketplace is added first).
  // A plugin that runs a command while installing is refused here: that needs a person at a terminal.
  async function installPlugin(key, spec, source) {
    if (busy) return emitResult('install', false, 'Wait for the last change to finish.');
    const s = String(spec || '').trim();
    if (!PLUGIN_SPEC.test(s)) return emitResult('install', false, 'Write the plugin as name@marketplace, for example vidiq@vidiq.');
    if (shellText(s.split('@')[0])) return emitResult('install', false, `Not installed. ${SHELL_WHY}`);
    const src = String(source || '').trim();
    if (src && !/^([\w.-]+\/[\w.-]+|https:\/\/[^\s"]{1,500})$/.test(src)) return emitResult('install', false, 'Marketplace: owner/repo or an https:// address.');
    const args = ['plugin', 'install', s, '--scope', 'user', '--json'];
    if (src) args.push('--marketplace', src);
    busy = 'installing';
    push(key);
    try {
      // Plugins can run programs on this PC (hooks and tool servers): the user says yes in the confirm window.
      const ok = confirm ? await confirm({ title: 'Claude in Zen: install a plugin?',
        text: `Install the plugin "${s}"${src ? ` from ${src}` : ''}?\n\nPlugins can run programs on your PC (hooks and tool servers). Only install plugins you trust.`,
        yes: 'Install', no: 'Cancel' }) : { ok: false, error: 'There is no confirm window.' };
      if (!ok.ok) return emitResult('install', false, `Not installed: ${ok.error}`);
      const r = await run(key, args, 180000);
      let res = null;
      for (const line of r.out.split(/\r?\n/).reverse()) { try { res = JSON.parse(line); break; } catch {} }
      const text = [res && (res.error || res.message), firstLine(r.err), firstLine(r.out)].filter(x => typeof x === 'string' && x)[0] || '';
      const failed = res && ((res.outcome && res.outcome !== 'ok') || res.success === false || res.ok === false);
      if (!r.ok || failed) {
        const why = /command|confirm|--yes|\b-y\b/i.test(text)
          ? `This plugin runs a setup command while installing, so install it from a terminal: claude plugin install ${s}`
          : `Claude Code did not install it: ${text || 'unknown error'}`;
        return emitResult('install', false, why);
      }
      await scan(key);
      log.info(`tools: installed plugin ${s}`);
      emitResult('install', true, '', { id: s });
    } finally { busy = null; push(key); }
  }

  async function uninstallPlugin(key, id) {
    if (busy) return emitResult('uninstall', false, 'Wait for the last change to finish.');
    const p = cat(key).plugins.find(x => x.id === id);
    if (!p || p.scope !== 'user') return emitResult('uninstall', false, 'Only plugins installed here can be removed here. Synced plugins are managed on claude.ai.');
    busy = 'removing';
    push(key);
    try {
      const r = await run(key, ['plugin', 'uninstall', id, '--scope', 'user'], 90000);
      if (!r.ok) return emitResult('uninstall', false, `Claude Code did not remove it: ${firstLine(r.err) || firstLine(r.out)}`);
      st.on.plugins = st.on.plugins.filter(x => x !== id);
      save();
      await scan(key);
      emitResult('uninstall', true, '', { id });
    } finally { busy = null; push(key); }
  }

  // The text of one skill from an installed plugin (without its front matter), for switches like Caveman mode
  // that put the skill straight into the prompt instead of making Claude call it each time.
  function skillText(key, pluginName, skillName) {
    const p = cat(key).plugins.find(x => x.name === pluginName && x.dir);
    if (!p) return '';
    const f = path.join(p.dir, 'skills', skillName, 'SKILL.md');
    if (!inside(f, p.dir)) return '';
    try {
      if (fs.statSync(f).size > 64 * 1024) return '';
      return fs.readFileSync(f, 'utf8').replace(/^---[\s\S]*?\n---\s*\n/, '').trim();
    } catch { return ''; }
  }

  function hasPlugin(key, pluginName) { return cat(key).plugins.some(p => p.name === pluginName); }

  return {
    view, push, scan, skillText, hasPlugin, ensureFresh, check, refreshOne, learn, labelFor, chatOptions, set, signIn, cancelSignIn,
    add, remove, installPlugin, uninstallPlugin,
    get busy() { return busy; },
    get signingIn() { return login ? login.name : null; },
  };
}

module.exports = { createToolbox, parseList, splitCommand, norm, statusOf, kindOf, shellText, SHELL_TOOLS };
