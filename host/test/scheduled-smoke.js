'use strict';
// Scheduled macro turns, helper side (E8): a turn the add-on marks `scheduled: true` runs on the strict toolbox (every plugin off,
// no connectors, no other tool servers), has no file tools, and the helper refuses its own tools (documents, local pages and
// files, videos, images, uploads) with "Scheduled macros only read pages." A normal turn keeps all of them.
// POSIX only (the fake claude is a script with a shebang).   node host/test/scheduled-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  scheduled-smoke runs on Linux/macOS only'); process.exit(0); }

const SID = '11111111-2222-3333-4444-555555555555';
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + String(extra).slice(0, 200) : ''}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REFUSAL = 'Scheduled macros only read pages.';

// The fake claude: records its flags and the settings file it was given, and answers a HOLD-x message once the test creates go-HOLD-x.
function fakeChat(cfg) {
  const fs = require('fs');
  const argv = process.argv.slice(2);
  if (argv[0] === 'plugin' || argv[0] === 'mcp' || argv[0] === 'auth') process.exit(argv[0] === 'auth' ? 1 : 0);
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8')); } catch {}
  fs.appendFileSync(cfg.dir + '/spawns', JSON.stringify({ pid: process.pid, argv, settings }) + '\n');
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  let inited = false;
  const answer = text => {
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: cfg.sid, model: 'fake-model', mcp_servers: [] }); }
    const done = () => out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: cfg.sid, duration_ms: 5, num_turns: 1 });
    if (!text.startsWith('HOLD')) return done();
    const t = setInterval(() => { if (fs.existsSync(cfg.dir + '/go-' + text)) { clearInterval(t); done(); } }, 30);
  };
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      answer(JSON.parse(line).message.content.map(b => b.text).join(''));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

function startHelper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-sched-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}\n(${fakeChat.toString()})(${JSON.stringify({ dir, sid: SID })});\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'claude-in-zen'), { recursive: true });
  // One plugin and one tool server the user switched on (tools.json is fresh, so no scan replaces it).
  fs.writeFileSync(path.join(dir, 'claude-in-zen', 'tools.json'), JSON.stringify({
    on: { plugins: ['p@test'], servers: ['srvx'] }, decided: ['p@test'],
    cat: { main: { plugins: [{ id: 'p@test', name: 'p', label: 'P', servers: [], skills: false }],
      servers: [{ name: 'srvx', kind: 'server', label: 'srvx', transport: 'http', target: '', local: false, status: 'connected' }], scanned: Date.now(), checked: 0 } },
  }));
  const env = { ...process.env, LOCALAPPDATA: dir, CLAUDE_IN_ZEN_PIPE: path.join(dir, 's.sock'), CLAUDE_IN_ZEN_TEST: '1', CLAUDE_IN_ZEN_CLAUDE: fake };
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const inbox = []; let waiters = []; let hbuf = Buffer.alloc(0);
  const H = { dir, proc };
  H.send = msg => { const body = Buffer.from(JSON.stringify(msg)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0); proc.stdin.write(Buffer.concat([head, body])); };
  proc.stdout.on('data', chunk => {
    hbuf = Buffer.concat([hbuf, chunk]);
    while (hbuf.length >= 4) {
      const len = hbuf.readUInt32LE(0);
      if (hbuf.length < 4 + len) break;
      const msg = JSON.parse(hbuf.subarray(4, 4 + len).toString());
      hbuf = hbuf.subarray(4 + len);
      if (msg.type === 'call') { H.send({ type: 'result', id: msg.id, ok: true, result: [] }); continue; }
      inbox.push(msg);
      waiters = waiters.filter(w => !w(msg));
    }
  });
  H.next = (pred, ms = 8000) => {
    const hit = inbox.find(pred);
    if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for helper')), ms);
      waiters.push(m => { if (!pred(m)) return false; clearTimeout(t); inbox.splice(inbox.indexOf(m), 1); resolve(m); return true; });
    });
  };
  H.events = id => inbox.filter(m => m.type === 'chat_event' && m.id === id).map(m => m.event);
  H.spawns = () => { try { return fs.readFileSync(path.join(dir, 'spawns'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  H.log = () => { try { return fs.readFileSync(path.join(dir, 'claude-in-zen', 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
  H.chat = async (id, fields) => { H.send({ type: 'chat', id, text: id, resume: '', ...(fields || {}) }); return H.next(m => m.type === 'chat_done' && m.id === id, 15000); };
  H.hello = async () => { H.send({ type: 'hello', version: 'test' }); await H.next(m => m.type === 'hello'); await H.next(m => m.type === 'confirmed_state'); };
  H.stop = () => { try { proc.kill(); } catch {} for (const s of H.spawns()) if (alive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch {} } };
  return H;
}

// One call to the helper's own tools over the pipe, the way the tool server does.
function pipeCall(H, tool, args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(path.join(H.dir, 's.sock'));
    let buf = '', sent = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('no answer over the pipe')); }, 5000);
    sock.on('error', e => { clearTimeout(timer); reject(e); });
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'hello', token: fs.readFileSync(path.join(H.dir, 'claude-in-zen', 'pipe-token'), 'utf8').trim(), client: 'test' }) + '\n'));
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (m.type === 'hello_ok' && !sent) { sent = true; sock.write(JSON.stringify({ type: 'call', id: 'k1', tool, args: args || {} }) + '\n'); }
        else if (m.type === 'result') { clearTimeout(timer); sock.destroy(); resolve(m); }
      }
    });
  });
}
const flag = (argv, name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };

(async () => {
  const H = startHelper();
  try {
    await H.hello();
    // A normal turn: the plugin and the tool server are on, Read is there, and the helper's tools answer.
    H.send({ type: 'chat', id: 'n1', text: 'HOLD-N', resume: '' });
    for (let i = 0; i < 100 && H.spawns().length < 1; i++) await sleep(50);
    const n = H.spawns()[0] || { argv: [], settings: {} };
    check('normal turn: the plugin is on and the tool server is allowed', n.settings && n.settings.enabledPlugins && n.settings.enabledPlugins['p@test'] === true && /mcp__srvx/.test(flag(n.argv, '--allowedTools') || ''), JSON.stringify(n.settings));
    check('normal turn: Read is a tool', /(^|,)Read(,|$)/.test(flag(n.argv, '--tools') || ''), flag(n.argv, '--tools'));
    let r = await pipeCall(H, 'local_files', { path: H.dir });
    check('normal turn: a helper tool is not refused as scheduled', !(r.error || '').includes(REFUSAL), JSON.stringify(r));
    fs.writeFileSync(path.join(H.dir, 'go-HOLD-N'), '');
    const d1 = await H.next(m => m.type === 'chat_done' && m.id === 'n1', 15000);
    check('normal turn: finished', d1.ok, d1.error);

    // A scheduled turn, with the fields a hostile or buggy message could add.
    H.send({ type: 'chat', id: 's1', text: 'HOLD-S', resume: '', scheduled: true, files: 'read', folder: H.dir, trusted: true, unsafe: true, model: 'army' });
    for (let i = 0; i < 100 && H.spawns().length < 2; i++) await sleep(50);
    const s = H.spawns()[1] || { argv: [], settings: {} };
    const tools = flag(s.argv, '--tools') || '', allowed = flag(s.argv, '--allowedTools') || '';
    check('scheduled turn: it gets its own process (the strict toolbox needs one)', H.spawns().length === 2 && s.pid !== n.pid);
    check('scheduled turn: every plugin is off and connectors are disabled', s.settings && s.settings.enabledPlugins && s.settings.enabledPlugins['p@test'] === false && s.settings.disableClaudeAiConnectors === true, JSON.stringify(s.settings));
    check('scheduled turn: only the Zen tool server loads (strict config), the other server is not allowed', s.argv.includes('--strict-mcp-config') && !/srvx/.test(allowed) && /mcp__claude-in-zen/.test(allowed), allowed);
    check('scheduled turn: no file tools at all (not even Read)', !/(^|,)(Read|Glob|Grep|Edit|Write)(,|$)/.test(tools) && !s.argv.includes('--add-dir'), tools);
    check('scheduled turn: not the army lead', !/mcp-army/.test(flag(s.argv, '--mcp-config') || ''), flag(s.argv, '--mcp-config'));
    for (const tool of ['local_files', 'read_document', 'local_file_read', 'local_page_open', 'watch_video', 'download_image', 'army_start']) {
      r = await pipeCall(H, tool, { path: H.dir });
      check(`scheduled turn: ${tool} is refused with the fixed text`, r.ok === false && r.error === REFUSAL, JSON.stringify(r));
    }
    fs.writeFileSync(path.join(H.dir, 'go-HOLD-S'), '');
    const d2 = await H.next(m => m.type === 'chat_done' && m.id === 's1', 15000);
    check('scheduled turn: finished', d2.ok, d2.error);
    r = await pipeCall(H, 'local_files', { path: H.dir });
    check('after it, a helper tool is not refused as scheduled', !(r.error || '').includes(REFUSAL), JSON.stringify(r));
  } catch (e) { check('scheduled test ran', false, e.message); } finally { H.stop(); }
  const failed = results.filter(r => !r).length;
  console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nall ${results.length} checks passed`);
  process.exit(failed || !results.length ? 1 : 0);
})();
