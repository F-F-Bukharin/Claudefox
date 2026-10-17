'use strict';
// Cost, tokens and tool ids (C11, C17), helper side. Part one: a chat turn through the real helper with a fake claude whose
// result events carry usage, or none: the stats event, the id on tool and tool_result, and the 'armymax' model turning army
// mode on. Part two: a real army run (lib/army.js) with fake workers: army_wait adds up their usage.
// POSIX only (the fake claude is a script with a shebang).   node host/test/usage-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  usage-smoke runs on Linux/macOS only'); process.exit(0); }

// The temp folders this test makes are removed however it ends (passing, failed checks, an exception or an early exit), and
// the helper and the fake workers it starts are stopped first, so nothing writes into the folders meanwhile.
const madeDirs = [], helpers = [], stops = [];
process.on('exit', () => {
  for (const H of helpers.splice(0)) { try { H.proc.kill('SIGKILL'); } catch {} try { H.stop(); } catch {} }
  for (const stop of stops.splice(0)) { try { stop(); } catch {} }
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));   // Ctrl-C or a kill cleans up too

const SID = '11111111-2222-3333-4444-555555555555';
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

// The fake claude for a chat turn: stream-json in, and the script chosen by the message text.
function fakeChat(cfg) {
  const fs = require('fs');
  const argv = process.argv.slice(2);
  if (argv[0] === 'plugin' || argv[0] === 'mcp' || argv[0] === 'auth') process.exit(argv[0] === 'auth' ? 1 : 0);
  fs.appendFileSync(cfg.dir + '/spawns', JSON.stringify({ pid: process.pid, argv }) + '\n');
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  let inited = false;
  const answer = text => {
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: cfg.sid, model: 'fake-model', mcp_servers: [] }); }
    if (text.startsWith('USAGE')) {
      out({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_A1', name: 'mcp__claudefox__click', input: { selector: 'a' } },
        { type: 'tool_use', id: 'toolu_A2', name: 'mcp__claudefox__tabs_list', input: {} },
      ] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A2', content: 'two tabs' }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A1', content: 'clicked', is_error: true }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: cfg.sid, duration_ms: 12300, num_turns: 3,
        total_cost_usd: 0.18, usage: { input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 7000, output_tokens: 1200 } });
    } else if (text.startsWith('PARTIAL')) {
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: cfg.sid, duration_ms: 50, num_turns: 1, usage: { input_tokens: 30, output_tokens: 4 } });
    } else {
      out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: cfg.sid, duration_ms: 7, num_turns: 1 });
    }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-usage-'));
  madeDirs.push(dir);
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}\n(${fakeChat.toString()})(${JSON.stringify({ dir, sid: SID })});\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'claudefox'), { recursive: true });
  const env = { ...process.env, LOCALAPPDATA: dir, CLAUDEFOX_PIPE: path.join(dir, 's.sock'), CLAUDEFOX_TEST: '1', CLAUDEFOX_CLAUDE: fake };
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'claudefox-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
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
  H.log = () => { try { return fs.readFileSync(path.join(dir, 'claudefox', 'logs', 'host.log'), 'utf8'); } catch { return ''; } };
  H.chat = async (id, fields) => { H.send({ type: 'chat', id, text: id, resume: '', ...(fields || {}) }); return H.next(m => m.type === 'chat_done' && m.id === id, 15000); };
  H.hello = async () => { H.send({ type: 'hello', version: 'test' }); await H.next(m => m.type === 'hello'); await H.next(m => m.type === 'confirmed_state'); };
  H.stop = () => { try { proc.kill(); } catch {} for (const s of H.spawns()) if (alive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch {} } };
  helpers.push(H);
  return H;
}

async function partChat() {
  const H = startHelper();
  try {
    await H.hello();
    const d1 = await H.chat('USAGE1');
    check('the turn with usage is answered', d1.ok, d1.error);
    const st = H.events('USAGE1').filter(e => e.kind === 'stats');
    check('one stats event per turn', st.length === 1, JSON.stringify(st));
    const s = st[0] || {};
    check('stats: ms and turns as before', s.ms === 12300 && s.turns === 3, JSON.stringify(s));
    check('stats: tokensIn adds input, cache read and cache creation', s.tokensIn === 48000, String(s.tokensIn));
    check('stats: tokensCached is the cache read', s.tokensCached === 40000, String(s.tokensCached));
    check('stats: tokensOut is the output tokens', s.tokensOut === 1200, String(s.tokensOut));
    check('stats: costUsd is total_cost_usd', near(s.costUsd, 0.18), String(s.costUsd));
    check('stats has exactly the six fields', Object.keys(s).sort().join() === 'costUsd,kind,ms,tokensCached,tokensIn,tokensOut,turns', Object.keys(s).join());

    const tools = H.events('USAGE1').filter(e => e.kind === 'tool');
    const res = H.events('USAGE1').filter(e => e.kind === 'tool_result');
    check('tool events carry the tool_use id', tools.length === 2 && tools[0].id === 'toolu_A1' && tools[1].id === 'toolu_A2', JSON.stringify(tools));
    check('tool_result events carry the tool_use_id as id, in the order they came', res.length === 2 && res[0].id === 'toolu_A2' && res[1].id === 'toolu_A1', JSON.stringify(res));
    check('tool_result keeps its error flag and text', res[1] && res[1].error === true && res[1].text === 'clicked' && res[0].error === false, JSON.stringify(res));

    const d2 = await H.chat('NOUSAGE2', { resume: SID });
    const s2 = H.events('NOUSAGE2').find(e => e.kind === 'stats') || {};
    check('a result without usage: stats has only ms and turns', d2.ok && Object.keys(s2).sort().join() === 'kind,ms,turns' && s2.ms === 7 && s2.turns === 1, JSON.stringify(s2));
    await H.chat('PARTIAL3', { resume: SID });
    const s3 = H.events('PARTIAL3').find(e => e.kind === 'stats') || {};
    check('usage without cache or cost: only the fields it has', s3.tokensIn === 30 && s3.tokensOut === 4 && !('tokensCached' in s3) && !('costUsd' in s3), JSON.stringify(s3));

    const cfgOf = sp => { const i = sp.argv.indexOf('--mcp-config'); return i === -1 ? '' : path.basename(sp.argv[i + 1]); };
    const lastCfg = () => { const all = H.spawns(); return cfgOf(all[all.length - 1] || { argv: [] }); };
    const before = H.spawns().length;
    const d4 = await H.chat('ARMYMAX4', { resume: SID, model: 'armymax' });
    check('the armymax chat runs, with the army tool server', d4.ok && H.spawns().length > before && lastCfg() === 'mcp-army.json', `${d4.error || ''} ${lastCfg()}`);
    await H.chat('ARMY5', { resume: SID, model: 'army' });
    check("'army' still does, and gets the same tool server", lastCfg() === 'mcp-army.json', lastCfg());
    await H.chat('PLAIN6', { resume: SID, model: 'quality' });
    check('a Quality turn gets the plain tool server', lastCfg() === 'mcp.json', lastCfg());
  } catch (e) { check('chat usage test ran', false, e.message); } finally { H.stop(); }
}

// The fake worker: reads its task from stdin and answers with one result event, with usage or without, by the task text.
function fakeWorker() {
  let all = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { all += d; });
  process.stdin.on('end', () => {
    const out = o => process.stdout.write(JSON.stringify(o) + '\n');
    const r = { type: 'result', subtype: 'success', is_error: false, result: 'report for ' + all.slice(0, 40).replace(/\s+/g, ' '), duration_ms: 5, num_turns: 1 };
    if (/ONE/.test(all)) Object.assign(r, { total_cost_usd: 0.01, usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 20 } });
    if (/TWO/.test(all)) Object.assign(r, { total_cost_usd: 0.02, usage: { input_tokens: 200, cache_read_input_tokens: 100, output_tokens: 30 } });
    out(r);
    setTimeout(() => process.exit(0), 20);
  });
}

// A real army run, in this process, with the add-on and the lead's chat turn stubbed.
async function partArmy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-usage-army-'));
  madeDirs.push(dir);
  process.env.LOCALAPPDATA = dir;
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}\n(${fakeWorker.toString()})();\n`, { mode: 0o755 });
  const P = require('../lib/paths');
  fs.mkdirSync(P.WORKSPACE, { recursive: true });
  const army = require('../lib/army');
  const chat = { id: 'c1', finished: false, army: true, key: 'main' };
  let tab = 0;
  const a = army.createArmy({
    callAddon: async (tool, args) => ({ ok: true, result: { tab_id: ++tab, url: args.url } }),
    sendAddon() {}, emit() {}, currentChat: () => chat, findClaude: () => fake,
    envFor: () => ({ ...process.env }), mcpServer: path.join(__dirname, '..', 'claudefox-mcp.js'), limitRe: /usage limit/i,
    workerSettings: () => ({}),
  });
  stops.push(() => { for (const run of a.runs.values()) for (const w of run.workers) if (w.child && alive(w.child.pid)) { try { process.kill(w.child.pid, 'SIGKILL'); } catch {} } });
  try {
    const go = async tasks => {
      const st = await a.start({ tasks: tasks.map(goal => ({ goal, start_url: 'https://example.com/' })) });
      return a.wait({ run_id: st.run_id, seconds: 30 });
    };
    const r1 = await go(['ONE read the first page', 'TWO read the second page']);
    check('army_wait: both workers finished', r1.finished && r1.done === 2, r1.text.split('\n')[0]);
    const u = r1.usage || {};
    check('army_wait: usage adds the workers (tokensIn counts input, cache read and cache creation)', u.tokensIn === 460, JSON.stringify(r1.usage));
    check('army_wait: tokensOut, tokensCached and costUsd are summed too', u.tokensOut === 50 && u.tokensCached === 150 && near(u.costUsd, 0.03), JSON.stringify(r1.usage));
    check('army_wait: the text the lead reads names the workers\' tokens and cost', /Workers so far: 460 in \(150 cached\) · 50 out · ≈ \$0\.03 at API prices\./.test(r1.text || ''), String(r1.text).slice(-160));
    check('army_wait: usage has just the four fields', Object.keys(u).sort().join() === 'costUsd,tokensCached,tokensIn,tokensOut', Object.keys(u).join());
    const r2 = await go(['ONE alone, and a worker with no usage', 'NOTHING here']);
    const u2 = r2.usage || {};
    check('army_wait: a worker without usage adds nothing', u2.tokensIn === 160 && u2.tokensOut === 20 && u2.tokensCached === 50 && near(u2.costUsd, 0.01), JSON.stringify(r2.usage));
  } catch (e) { check('army usage test ran', false, e.message); }
  try { for (const run of a.runs.values()) for (const w of run.workers) if (w.child && alive(w.child.pid)) process.kill(w.child.pid, 'SIGKILL'); } catch {}
}

(async () => {
  await partChat();
  await partArmy();
  const bad = results.filter(r => !r).length;
  console.log(bad ? `${bad} FAILED of ${results.length}` : `all ${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
