'use strict';
// One Claude Code process per chat (lib/chatturns.js), with a fake claude that takes stream-json lines on stdin; and the
// plugin scan running in the background. The fake records every spawn (pid, argv, settings) and every message it gets.
// POSIX only (the fake claude is a script with a shebang).   node host/test/session-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  session-smoke runs on Linux/macOS only'); process.exit(0); }

const SID = '11111111-2222-3333-4444-555555555555';
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The fake claude, as a function whose source is written out with its settings.
function fakeMain(cfg) {
  const fs = require('fs');
  const argv = process.argv.slice(2);
  const rec = n => cfg.dir + '/' + n;
  if (argv[0] === 'plugin' && argv[1] === 'list') {
    let ms = 0; try { ms = Number(fs.readFileSync(rec('plugdelay'), 'utf8')) || 0; } catch {}
    fs.appendFileSync(rec('plugcalls'), Date.now() + '\n');
    let list = '[]'; try { list = fs.readFileSync(rec('plugins'), 'utf8'); } catch {}
    setTimeout(() => { process.stdout.write(list); process.exit(0); }, ms);
    return;
  }
  if (argv[0] === 'plugin' || argv[0] === 'mcp' || argv[0] === 'auth') process.exit(argv[0] === 'auth' ? 1 : 0);
  const stream = argv.includes('--input-format');
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8')); } catch {}
  fs.appendFileSync(rec('spawns'), JSON.stringify({ pid: process.pid, argv, settings, stream }) + '\n');
  if (stream && cfg.noStream) { process.stderr.write("error: unknown option '--input-format'\n"); process.exit(1); }
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  const ri = argv.indexOf('--resume');
  const sid = ri !== -1 ? argv[ri + 1] : cfg.sid;
  let inited = false;
  const answer = (text, raw) => {
    fs.appendFileSync(rec('msgs'), JSON.stringify({ pid: process.pid, text, raw, stream }) + '\n');
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-model', mcp_servers: [] }); }
    if (text === 'SLEEP') return;
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'echo:' + text + ':' + process.pid } }, session_id: sid });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'echo', session_id: sid, duration_ms: 5, num_turns: 1 });
    if (!stream) process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  let buf = '', all = '';
  process.stdin.on('data', d => {
    if (!stream) { all += d; return; }
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      answer(m.message.content.map(b => b.text).join(''), line);
    }
  });
  process.stdin.on('end', () => { if (!stream) answer(all, ''); else process.exit(0); });
}

// A helper process on its own data folder, with a fake claude baked to that folder. opts: { noStream, env, before(dir) }.
function startHelper(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-sess-'));
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}\n(${fakeMain.toString()})(${JSON.stringify({ dir, sid: SID, noStream: !!o.noStream })});\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'claude-in-zen'), { recursive: true });
  if (o.before) o.before(dir);
  const env = { ...process.env, LOCALAPPDATA: dir, CLAUDE_IN_ZEN_PIPE: path.join(dir, 's.sock'), CLAUDE_IN_ZEN_TEST: '1', CLAUDE_IN_ZEN_CLAUDE: fake, ...(o.env || {}) };
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
  const lines = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  H.spawns = () => lines('spawns');
  H.msgs = () => lines('msgs');
  H.log = () => { try { return fs.readFileSync(path.join(dir, 'claude-in-zen', 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
  // One message to the helper, resolved with its chat_done.
  H.chat = async (id, fields) => { H.send({ type: 'chat', id, text: id, resume: '', ...(fields || {}) }); return H.next(m => m.type === 'chat_done' && m.id === id, 15000); };
  H.hello = async () => { H.send({ type: 'hello', version: 'test' }); await H.next(m => m.type === 'hello'); await H.next(m => m.type === 'confirmed_state'); };
  H.stop = () => { try { proc.kill(); } catch {} for (const s of H.spawns()) if (alive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch {} } };
  return H;
}
const val = (a, f) => a[a.indexOf(f) + 1];
const text = (H, id) => H.events(id).filter(e => e.kind === 'text').map(e => e.text).join('');

// One process serves the whole chat, and respawns when it must.
async function partOne() {
  const A = startHelper({ env: { CLAUDE_IN_ZEN_IDLE_MS: '1500' } });
  try {
    await A.hello();
    const d1 = await A.chat('m1');
    check('first message is answered', d1.ok && text(A, 'm1').startsWith('echo:m1:'), d1.error);
    check('chat_done carries the session id', d1.sessionId === SID, d1.sessionId);
    const d2 = await A.chat('m2', { resume: SID });
    check('second message is answered, with the session id', d2.ok && d2.sessionId === SID && text(A, 'm2').startsWith('echo:m2:'), d2.error);
    const sp = A.spawns(), ms = A.msgs();
    check('two messages in a row: one spawn', sp.length === 1, `spawns ${sp.length}`);
    check('both messages reached the same process', ms.length === 2 && ms[0].pid === ms[1].pid && ms[0].pid === sp[0].pid);
    check('the process takes stream input, no --resume for a new chat', val(sp[0].argv, '--input-format') === 'stream-json' && !sp[0].argv.includes('--resume'), sp[0].argv.join(' ').slice(0, 200));
    check('each message is one JSON user line', ms[0].raw === JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'm1' }] } }), ms[0].raw);
    check('each turn shows its stats event', A.events('m1').some(e => e.kind === 'stats') && A.events('m2').some(e => e.kind === 'stats'));

    const d3 = await A.chat('m3', { resume: SID, model: 'quality' });
    const sp3 = A.spawns();
    check('a changed model respawns, resuming the session', d3.ok && sp3.length === 2 && val(sp3[1].argv, '--model') === 'claude-opus-5-5' && val(sp3[1].argv, '--resume') === SID && val(sp3[1].argv, '--input-format') === 'stream-json');
    check('the old process is gone', !alive(sp3[0].pid));
    const d4 = await A.chat('m4', { resume: SID, model: 'quality' });
    check('same settings again: no new spawn', d4.ok && A.spawns().length === 2);
    const d5 = await A.chat('m5', { resume: SID, model: 'quality', caveman: true });
    check('caveman switched on respawns', d5.ok && A.spawns().length === 3 && !alive(sp3[1].pid));
    const d6 = await A.chat('m6', { resume: '', model: 'quality', caveman: true });
    check('a new chat (no session to resume) does not reuse the old conversation', d6.ok && A.spawns().length === 4 && !A.spawns()[3].argv.includes('--resume'));

    // Cancel kills the process; the next message spawns anew.
    A.send({ type: 'chat', id: 'SLEEP', text: 'SLEEP', resume: SID, model: 'quality', caveman: true });
    for (let i = 0; i < 50 && !A.msgs().some(m => m.text === 'SLEEP'); i++) await sleep(100);
    const before = A.spawns(); const slpPid = before[before.length - 1].pid;
    A.send({ type: 'chat_cancel', id: 'SLEEP' });
    const dc = await A.next(m => m.type === 'chat_done' && m.id === 'SLEEP');
    await sleep(300);
    check('Cancel ends the turn and kills the process', dc.ok === false && !alive(slpPid), JSON.stringify(dc));
    const d7 = await A.chat('m7', { resume: SID, model: 'quality', caveman: true });
    check('after Cancel the next message spawns anew', d7.ok && A.spawns().length === before.length + 1 && text(A, 'm7').startsWith('echo:m7:'));

    // Idle: the helper under test runs with a 1.5 s idle limit.
    const idlePid = A.spawns()[A.spawns().length - 1].pid, n = A.spawns().length;
    await sleep(2400);
    check('an idle process is stopped', !alive(idlePid));
    const d8 = await A.chat('m8', { resume: SID, model: 'quality', caveman: true });
    check('after the idle time the next message spawns anew', d8.ok && A.spawns().length === n + 1 && A.spawns()[n].pid !== idlePid);
    const last = A.spawns()[A.spawns().length - 1].pid;
    check('the idle process is alive before the stop', alive(last));
    A.send({ type: 'chat_cancel', id: '*' });   // what the helper sends itself when it shuts down
    await sleep(300);
    check('a stop for everything also stops the idle process', !alive(last));
  } catch (e) { check('chat session test ran', false, e.message); } finally { A.stop(); }
}

// Claude Code that does not know --input-format: the first message is retried as one process per message, for good.
async function partFallback() {
  const C = startHelper({ noStream: true });
  try {
    await C.hello();
    const d1 = await C.chat('f1');
    check('fallback: the first message is still answered', d1.ok && text(C, 'f1').startsWith('echo:f1:') && d1.sessionId === SID, d1.error);
    const sp = C.spawns();
    check('fallback: a stream spawn that failed, then one plain spawn', sp.length === 2 && sp[0].stream === true && sp[1].stream === false && !sp[1].argv.includes('--input-format'), JSON.stringify(sp.map(s => s.stream)));
    check('fallback: the helper says so in its log', C.log().includes('Claude Code does not take stream input; using one process per message.'));
    const d2 = await C.chat('f2', { resume: SID });
    const d3 = await C.chat('f3', { resume: SID });
    const sp2 = C.spawns();
    check('fallback: later messages are one process each, with no stream flag', d2.ok && d3.ok && sp2.length === 4 && sp2.slice(2).every(s => !s.stream && !s.argv.includes('--input-format') && val(s.argv, '--resume') === SID));
    check('fallback: the prompt still goes on stdin', C.msgs().every(m => m.stream === false) && C.msgs().map(m => m.text).join() === 'f1,f2,f3');
  } catch (e) { check('fallback test ran', false, e.message); } finally { C.stop(); }
}

// A stale plugin list does not hold the message back; the refreshed list applies from the next turn.
async function partPlugins() {
  const B = startHelper({
    before(dir) {
      fs.mkdirSync(path.join(dir, 'late'));
      fs.writeFileSync(path.join(dir, 'plugins'), JSON.stringify([{ id: 'late@test', version: '1.0.0', scope: 'user', enabled: true, installPath: path.join(dir, 'late') }]));
      fs.writeFileSync(path.join(dir, 'plugdelay'), '2500');
      fs.writeFileSync(path.join(dir, 'claude-in-zen', 'tools.json'), JSON.stringify({
        on: { plugins: ['late@test'], servers: [] }, decided: ['late@test'], cat: { main: { plugins: [], servers: [], scanned: 1, checked: 0 } },
      }));
    },
  });
  try {
    const t0 = Date.now();
    const d1 = await B.chat('b1');
    const took = Date.now() - t0;
    check('plugins: a stale list does not delay the message', d1.ok && took < 1800, `${took} ms`);
    check('plugins: the first turn used the cached list', B.spawns().length === 1 && !(B.spawns()[0].settings.enabledPlugins || {})['late@test']);
    check('plugins: the refresh ran in the background', (() => { try { return fs.readFileSync(path.join(B.dir, 'plugcalls'), 'utf8').trim().split('\n').length >= 1; } catch { return false; } })());
    for (let i = 0; i < 60 && !(() => { try { return JSON.parse(fs.readFileSync(path.join(B.dir, 'claude-in-zen', 'tools.json'), 'utf8')).cat.main.plugins.length === 1; } catch { return false; } })(); i++) await sleep(100);
    const d2 = await B.chat('b2', { resume: SID });
    const sp = B.spawns();
    check('plugins: the next turn sees the refreshed list (and respawns for it)', d2.ok && sp.length === 2 && sp[1].settings.enabledPlugins['late@test'] === true && sp[1].pid !== sp[0].pid);
  } catch (e) { check('plugin test ran', false, e.message); } finally { B.stop(); }
}

(async () => {
  await partOne();
  await partFallback();
  await partPlugins();
  const failed = results.filter(r => !r).length;
  console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nall ${results.length} checks passed`);
  process.exit(failed || !results.length ? 1 : 0);
})();
