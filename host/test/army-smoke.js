'use strict';
// Army test with a fake Claude Code: the lead calls army_start and army_wait through the real tool server, the helper
// opens the workers' first tabs and starts each worker (the same fake), and each worker calls the real tool server in
// worker mode. This file plays the add-on. Plus the pure tab and budget rules of lib/armyguard.js.
// POSIX only (the fake claude is a script with a shebang).   node host/test/army-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  army-smoke runs on Linux/macOS only'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-army-'));
const fake = path.join(tmp, 'claude');
const recDir = path.join(tmp, 'rec');
fs.mkdirSync(recDir);
const HOST_DIR = path.join(__dirname, '..');
const { WORKER_TOOLS, checkCall, noteResult } = require('../lib/armyguard');

// The fake claude. It runs as its own script, so it gets everything it needs as one JSON argument.
function fakeClaude(C) {
  const fs = require('fs'); const path = require('path'); const net = require('net'); const { spawn } = require('child_process');
  const argv = process.argv.slice(2);
  if (argv[0] === 'plugin' || argv[0] === 'mcp' || argv[0] === 'auth') { process.stdout.write(argv[1] === 'list' ? '[]' : ''); process.exit(0); }
  const val = f => argv[argv.indexOf(f) + 1];
  const worker = /worker in Claude in Zen's army/.test(val('--append-system-prompt') || '');
  const cfg = JSON.parse(fs.readFileSync(val('--mcp-config'), 'utf8')).mcpServers['claude-in-zen'];
  const out = o => process.stdout.write(JSON.stringify(o) + '\n');
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { prompt += d; });
  process.stdin.on('end', async () => {
    const name = worker ? `w-${cfg.env.CLAUDE_IN_ZEN_ARMY_TOKEN}` : `lead-${(/LEAD:(\w+)/.exec(prompt) || [])[1]}`;
    let settings = null;
    try { settings = JSON.parse(fs.readFileSync(val('--settings'), 'utf8')); } catch {}
    const rec = { worker, argv, prompt, pid: process.pid, env: cfg.env, settings, steps: [] };
    const save = () => fs.writeFileSync(path.join(C.recDir, name + '.json'), JSON.stringify(rec));
    save();
    const key = (worker ? /SCRIPT:(\w+)/ : /LEAD:(\w+)/).exec(prompt);
    const steps = key ? JSON.parse(fs.readFileSync(path.join(C.recDir, `script-${key[1]}.json`), 'utf8')) : [];
    const servers = {};
    const mcp = env => {   // the real tool server, the way Claude Code starts it
      const k = JSON.stringify(env);
      if (servers[k]) return servers[k];
      const p = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
      let buf = '', seq = 1; const waits = {};
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (waits[m.id]) waits[m.id](m); } });
      const rpc = (method, params) => new Promise(r => { const id = seq++; waits[id] = r; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
      servers[k] = { p, rpc, ready: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } }) };
      return servers[k];
    };
    // A call straight on the pipe, like a tool server would send it: reaches the helper's own checks.
    const raw = (tool, args) => new Promise(resolve => {
      const P = require(C.paths);
      const sock = net.connect(P.PIPE);
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (m.type === 'hello_ok') sock.write(JSON.stringify({ type: 'call', id: 'x1', tool, args }) + '\n');
          else { sock.end(); resolve(m); }
        }
      });
      sock.on('connect', () => sock.write(JSON.stringify({ type: 'hello', token: fs.readFileSync(P.TOKEN_FILE, 'utf8').trim(), client: cfg.env.CLAUDE_IN_ZEN_CLIENT, army: cfg.env.CLAUDE_IN_ZEN_ARMY_TOKEN }) + '\n'));
    });
    const s0 = mcp({});
    await s0.ready;
    rec.tools = (await s0.rpc('tools/list', {})).result.tools.map(t => t.name);
    save();
    let run = '', newTab = null, final = null;
    const fill = a => JSON.parse(JSON.stringify(a || {}).replace(/"\$run"/g, JSON.stringify(run)).replace(/"\$newtab"/g, String(newTab)));
    for (const st of steps) {
      if (st.sleep) await new Promise(r => setTimeout(r, st.sleep));
      else if (st.lingerReport) {   // the report, then the process stays (a slow shutdown)
        out({ type: 'system', subtype: 'init', session_id: 'linger' });
        out({ type: 'result', subtype: 'success', is_error: false, result: st.lingerReport, session_id: 'linger' });
        await new Promise(r => setTimeout(r, 60000));
      }
      else if (st.child) {
        const ch = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        rec.childPid = ch.pid;
      } else if (st.raw) rec.steps.push({ raw: st.raw, res: await raw(st.raw, fill(st.args)) });
      else if (st.tool) {
        const s = st.forceLead ? mcp({ CLAUDE_IN_ZEN_ARMY_LEAD: '1' }) : s0;
        await s.ready;
        for (;;) {
          const r = (await s.rpc('tools/call', { name: st.tool, arguments: fill(st.args) })).result;
          const text = r.content.map(c => c.text || '').join('\n');
          rec.steps.push({ tool: st.tool, isError: !!r.isError, text });
          if (st.tool === 'army_start' && !r.isError) run = JSON.parse(text).run_id;
          if (st.tool === 'tab_open' && !r.isError) newTab = JSON.parse(text).tab_id;
          if (!(st.tool === 'army_wait' && st.untilDone && !r.isError && !/All workers finished/.test(text))) break;
        }
      } else final = st;
      save();
    }
    for (const s of Object.values(servers)) s.p.stdin.end();
    const sid = '11111111-2222-3333-4444-555555555555';
    out({ type: 'system', subtype: 'init', session_id: sid });
    if (final && final.exit) { process.stderr.write(final.stderr + '\n'); process.exit(final.exit); }
    if (final && final.error) return out({ type: 'result', subtype: 'success', is_error: true, result: final.error, session_id: sid });
    const report = (final && final.report) || `Report from ${cfg.env.CLAUDE_IN_ZEN_CLIENT || 'the lead'}.`;
    out({ type: 'result', subtype: 'success', is_error: false, result: report, session_id: sid });
  });
}
fs.writeFileSync(fake, `#!${process.execPath}\n'use strict';\n(${fakeClaude.toString()})(${JSON.stringify({ recDir, paths: path.join(HOST_DIR, 'lib', 'paths.js') })});\n`, { mode: 0o755 });
const script = (name, steps) => fs.writeFileSync(path.join(recDir, `script-${name}.json`), JSON.stringify(steps));
const records = () => fs.readdirSync(recDir).filter(f => /^(w|lead)-.*\.json$/.test(f)).map(f => {
  try { return JSON.parse(fs.readFileSync(path.join(recDir, f), 'utf8')); } catch { return null; }
}).filter(Boolean);
const lead = n => records().find(r => !r.worker && /LEAD:(\w+)/.exec(r.prompt)[1] === n);
const workersOf = re => records().filter(r => r.worker && re.test(r.prompt));

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A killed process can stay a zombie until its parent reaps it: that counts as gone.
const alive = pid => {
  try { if (/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; } catch {}
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// One helper on its own folder and pipe. The test answers the add-on's side.
function startHelper(name, extraEnv) {
  const base = path.join(tmp, name);
  fs.mkdirSync(base);
  const env = { ...process.env, LOCALAPPDATA: base, CLAUDE_IN_ZEN_PIPE: path.join(base, 'h.sock'), CLAUDE_IN_ZEN_CLAUDE: fake, ...extraEnv };
  const proc = spawn(process.execPath, [path.join(HOST_DIR, 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const h = { proc, base, inbox: [], calls: [], waiters: [], tabSeq: 100, held: [] };
  let buf = Buffer.alloc(0);
  h.send = msg => {
    const body = Buffer.from(JSON.stringify(msg));
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
    proc.stdin.write(Buffer.concat([head, body]));
  };
  proc.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
      buf = buf.subarray(4 + len);
      if (msg.type === 'call') { h.calls.push(msg); const r = answer(h, msg); if (r) h.send(r); continue; }
      h.inbox.push(msg);
      h.waiters = h.waiters.filter(w => !w(msg));
    }
  });
  h.next = (pred, ms = 20000) => {
    const hit = h.inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for the helper')), ms);
      h.waiters.push(m => { if (!pred(m)) return false; clearTimeout(t); resolve(m); return true; });
    });
  };
  h.events = id => h.inbox.filter(m => m.type === 'chat_event' && m.id === id).map(m => m.event);
  h.armyEvents = id => h.events(id).filter(e => e.kind === 'army');
  h.ends = run => h.inbox.filter(m => m.type === 'army_end' && m.run === run);
  return h;
}

// The add-on's tool router: tabs get ids from 101 up; a click on ref "popup" opens a tab of its own.
function answer(h, msg) {
  const a = msg.args || {};
  const ok = result => ({ type: 'result', id: msg.id, ok: true, result });
  if (msg.tool === 'tab_open' && /\/slow/.test(a.url)) { h.held.push(msg); return null; }   // answered later by the test
  if (msg.tool === 'tab_open') { const id = ++h.tabSeq; return ok({ tab_id: id, url: a.url, title: `Tab ${id}` }); }
  if (msg.tool === 'get_page_text') return ok({ title: 'Page', url: `https://example.com/page${a.tab_id}`, text: 'Price: 10' });
  if (msg.tool === 'click' && a.ref === 'popup') return ok({ navigated: false, opened_tab: { tab_id: ++h.tabSeq, url: 'https://example.net/pop' } });
  return ok({ done: true, tab_id: a.tab_id });
}

// Connects to the helper's pipe with an army token and returns the first answer.
function hello(h, armyToken) {
  return new Promise(resolve => {
    const sock = net.connect(path.join(h.base, 'h.sock'));
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i !== -1) { sock.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
    sock.on('error', () => resolve({ type: 'error', error: 'socket error' }));
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'hello', token: fs.readFileSync(path.join(h.base, 'claude-in-zen', 'pipe-token'), 'utf8').trim(), client: 'Army worker w9', army: armyToken }) + '\n'));
  });
}

async function mainChecks() {
  const h = startHelper('a', { CLAUDE_IN_ZEN_ARMY_CALLS: '3' });
  try {
    h.send({ type: 'hello', version: 'test' });
    await h.next(m => m.type === 'hello');

    // A Quality turn: no army section, no army tools; the helper refuses army_start even from a lead-mode server.
    script('q', [{ tool: 'army_start', forceLead: true, args: { tasks: [{ goal: 'x', query: 'y' }] } }]);
    h.send({ type: 'chat', id: 'q1', text: 'LEAD:q', model: 'quality' });
    await h.next(m => m.type === 'chat_done' && m.id === 'q1');
    const q = lead('q');
    const qp = q.argv[q.argv.indexOf('--append-system-prompt') + 1];
    check('1. a Quality turn has no army section and no army tools', !/# Army mode/.test(qp) && !q.tools.includes('army_start') && !q.tools.includes('army_wait') && q.tools.includes('tabs_list'), q.tools.join(','));
    check('12. army_start during a Quality turn is refused', q.steps[0].isError && /^Army mode is off\./.test(q.steps[0].text), q.steps[0].text);

    // The army turn.
    const six = Array.from({ length: 6 }, (_, i) => ({ goal: `g${i}`, query: 'q' }));
    script('a1', [
      { tool: 'army_start', args: { tasks: six } },
      { tool: 'army_start', args: { tasks: [
        { goal: 'SCRIPT:s5 read the first page', start_url: 'https://example.com/a', report: 'the price' },
        { goal: 'SCRIPT:s7 open another tab', query: 'cheap shoes' },
        { goal: 'SCRIPT:s8 use up the budget', start_url: 'https://example.com/c' },
      ] } },
      { tool: 'army_start', args: { tasks: [{ goal: 'too soon', query: 'q' }] } },
      { tool: 'army_wait', args: { run_id: '$run', seconds: 30 }, untilDone: true },
      { tool: 'army_start', args: { tasks: [{ goal: 'SCRIPT:quick second round', start_url: 'https://example.com/d' }] } },
      { tool: 'army_wait', args: { run_id: '$run', seconds: 30 }, untilDone: true },
      { tool: 'army_start', args: { tasks: [{ goal: 'third', query: 'q' }] } },
    ]);
    script('s5', [
      { tool: 'get_page_text', args: {} },
      { raw: 'get_page_text', args: { tab_id: 1 } },
      { raw: 'tab_activate', args: { tab_id: 1 } },
      { report: 'The price is 10 (https://example.com/a).' },
    ]);
    script('s7', [
      { tool: 'tab_open', args: { url: 'https://example.org/x', active: true } },
      { tool: 'get_page_text', args: { tab_id: '$newtab' } },
      { report: 'The API has a rate limit of 100 calls a day.' },
    ]);
    script('s8', [1, 2, 3, 4].map(() => ({ tool: 'get_page_text', args: {} })));
    script('quick', []);
    h.send({ type: 'chat', id: 'a1', text: 'LEAD:a1', model: 'army' });
    const done = await h.next(m => m.type === 'chat_done' && m.id === 'a1', 60000);
    const L = lead('a1');
    const la = L.argv, lv = f => la[la.indexOf(f) + 1];
    const armyCfgFile = lv('--mcp-config');
    const armyCfg = JSON.parse(fs.readFileSync(armyCfgFile, 'utf8')).mcpServers['claude-in-zen'];
    check('1. army lead: Opus 5.5 at max effort, mcp-army.json in lead mode, the army prompt section',
      lv('--model') === 'claude-opus-5-5' && lv('--effort') === 'max' && path.basename(armyCfgFile) === 'mcp-army.json'
      && armyCfg.env.CLAUDE_IN_ZEN_ARMY_LEAD === '1' && /# Army mode \(on\)/.test(lv('--append-system-prompt')) && L.tools.includes('army_start') && L.tools.includes('army_wait'));
    check('the army turn ends ok', done.ok, done.error);
    const st = L.steps;
    check('12. six tasks are refused', st[0].isError && st[0].text === 'Give at most 5 tasks.', st[0].text);
    const started = JSON.parse(st[1].text);
    const r1 = started.run_id;
    check('army_start returns the run and its workers at once', r1 === 'r1' && started.workers.length === 3 && started.workers.every(w => w.tab_id > 100 && w.state === 'working')
      && started.workers[1].url === 'https://www.google.com/search?q=cheap%20shoes', st[1].text);
    check('army_start refused while the run is still going', st[2].isError && st[2].text === 'Run r1 is still going: call army_wait first.', st[2].text);
    const opens = h.calls.filter(c => c.tool === 'tab_open' && c.army && c.army.run === r1 && c.args.url !== 'https://example.org/x');
    check('2. one background tab per task, with its army context', opens.length === 3 && opens.every(c => c.args.active === false)
      && ['w1', 'w2', 'w3'].every(w => opens.some(c => c.army.worker === w)), JSON.stringify(opens.map(c => [c.args, c.army])));

    const ws = workersOf(/SCRIPT:(s5|s7|s8)/);
    const w1 = workersOf(/SCRIPT:s5/)[0], w2 = workersOf(/SCRIPT:s7/)[0], w3 = workersOf(/SCRIPT:s8/)[0];
    const wa = w1.argv, wv = f => wa[wa.indexOf(f) + 1];
    check('3. worker flags: Haiku high, no built-in tools, only the Zen tools, nothing prompted, no Bash',
      wv('--model') === 'claude-haiku-5-5' && wv('--effort') === 'high' && wa.includes('--tools') && wv('--tools') === '' && wa.includes('--strict-mcp-config')
      && wv('--allowedTools') === 'mcp__claude-in-zen' && wv('--permission-mode') === 'dontAsk' && !wa.join(' ').includes('Bash')
      && /^r\d+-settings\.json$/.test(path.basename(wv('--settings'))), JSON.stringify(wa.filter(x => x.length < 80)));
    check('3. worker tool server: its token, its name, no panel flag', ws.length === 3 && ws.every(w => /^[0-9a-f]{32}$/.test(w.env.CLAUDE_IN_ZEN_ARMY_TOKEN) && /^Army worker w\d$/.test(w.env.CLAUDE_IN_ZEN_CLIENT) && !('CLAUDE_IN_ZEN_PANEL' in w.env)));
    check('3. worker prompt names its first tab and what to report', /^Your task: SCRIPT:s5 read the first page\n\nStart in tab \d+ \(https:\/\/example\.com\/a\)\.\nReport: the price$/.test(w1.prompt), w1.prompt);
    const settings = w1.settings || { permissions: { deny: [] } };
    check('3. worker settings carry the guard deny rules', settings.permissions.deny.length > 10);
    check('3. worker settings switch off the account\'s plugins and claude.ai connectors', settings.disableClaudeAiConnectors === true
      && settings.enabledPlugins && Object.values(settings.enabledPlugins).every(v => v === false), JSON.stringify(Object.assign({}, settings, { permissions: undefined })));
    check('3. a run\'s settings file is gone once the run is over', !fs.existsSync(wv('--settings')));
    check('4. worker tools/list is exactly the worker tools', [...w1.tools].sort().join() === [...WORKER_TOOLS].sort().join(), w1.tools.join(','));

    const callsOf = w => h.calls.filter(c => c.army && c.army.run === r1 && c.army.worker === w);
    const w1tab = started.workers[0].tab_id;
    const g1 = callsOf('w1').filter(c => c.tool === 'get_page_text');
    check('5. a call without tab_id reaches Zen on the worker\'s first tab, with army context',
      g1.length === 1 && g1[0].args.tab_id === w1tab && g1[0].source === 'Army worker w1' && !w1.steps[0].isError, JSON.stringify(g1.map(c => c.args)));
    check('6. a call on the user\'s tab is refused and never forwarded', w1.steps[1].res.ok === false && /^Tab 1 is not one of your tabs \(yours: \d+\)\. Work only in your own tabs\.$/.test(w1.steps[1].res.error)
      && !h.calls.some(c => c.args && c.args.tab_id === 1), JSON.stringify(w1.steps[1].res));
    check('6. tab_activate is refused and never forwarded', w1.steps[2].res.ok === false && w1.steps[2].res.error === 'Workers never bring a tab to the front.'
      && !h.calls.some(c => c.tool === 'tab_activate'), JSON.stringify(w1.steps[2].res));
    const extra = callsOf('w2').filter(c => c.tool === 'tab_open' && c.args.url === 'https://example.org/x');
    const used = callsOf('w2').filter(c => c.tool === 'get_page_text');
    check('7. a worker\'s tab_open opens in the background and the new tab is usable', extra.length === 1 && extra[0].args.active === false
      && used.length === 1 && used[0].args.tab_id === JSON.parse(w2.steps[0].text).tab_id && !w2.steps[1].isError, JSON.stringify({ extra: extra.map(c => c.args), used: used.map(c => c.args), steps: w2.steps }));
    check('8. with 3 calls allowed, the 4th is refused with the budget message', w3.steps.slice(0, 3).every(s => !s.isError) && w3.steps[3].isError
      && /^Budget reached/.test(w3.steps[3].text) && callsOf('w3').filter(c => c.tool === 'get_page_text').length === 3, JSON.stringify(w3.steps));

    const waits = st.filter(s => s.tool === 'army_wait');
    const lastWait = waits.find(s => /Run r1/.test(s.text) && /All workers finished/.test(s.text));
    check('9. army_wait returns the reports as untrusted page content and says all finished', lastWait && !lastWait.isError
      && /<untrusted_page_content>\nRun r1: All workers finished\./.test(lastWait.text) && /## w1 · done · SCRIPT:s5/.test(lastWait.text)
      && /The price is 10/.test(lastWait.text) && /Sources: https:\/\/example\.com\/page/.test(lastWait.text), lastWait && lastWait.text);
    const wait1 = waits.filter(s => /Run r1/.test(s.text));
    const reportedOnce = ['w1', 'w2', 'w3'].every(w => wait1.filter(s => new RegExp(`## ${w} · `).test(s.text)).length === 1);
    check('9. each report is given once', reportedOnce, wait1.map(s => s.text).join('\n----\n'));
    check('a report that mentions a rate limit is still a report', /## w2 · done · .*\nThe API has a rate limit/.test(lastWait ? lastWait.text : ''), lastWait && lastWait.text);

    const ev = h.armyEvents('a1');
    const ev1 = ev.filter(e => e.run === r1), ev2 = ev.filter(e => e.run === 'r2');
    const last1 = ev1[ev1.length - 1];
    check('10. trail: the first army event has started, the last of the run has finished with workers done',
      ev[0] && ev[0].started === true && ev.filter(e => e.started).length === 1 && last1.finished === true && ev1.filter(e => e.finished).length === 1
      && last1.workers.length === 3 && last1.workers.every(w => w.state === 'done' && w.tab_id > 100 && typeof w.ms === 'number'), JSON.stringify(last1));
    check('10. trail: workers carry steps, hosts and sources', last1.workers[0].steps >= 1 && last1.workers[0].host === 'example.com' && last1.workers[0].sources.length >= 1, JSON.stringify(last1.workers[0]));
    check('10. trail: the second round is round 2 and not started', ev2.length >= 2 && ev2.every(e => e.round === 2 && !e.started) && ev2[ev2.length - 1].finished === true);
    check('11. army_end is sent for every worker', ['w1', 'w2', 'w3'].every(w => h.ends(r1).some(m => m.worker === w)) && h.ends('r2').some(m => m.worker === 'w1'));
    const third = st[st.length - 1];
    check('12. a third army_start in one message is refused', third.tool === 'army_start' && third.isError && third.text === 'This message already used 2 army runs. Answer with what you have.', third.text);
    const leftovers = fs.readdirSync(path.join(h.base, 'claude-in-zen', 'army'));
    check('worker tool-server configs and run settings are deleted when workers end', !leftovers.length, leftovers.join(','));
    const clientsMsgs = h.inbox.filter(m => m.type === 'clients' || Array.isArray(m.clients));
    check('workers stay out of the clients list', !clientsMsgs.some(m => (m.clients || []).some(n => /Army worker/.test(n))));

    const unknown = await hello(h, 'ab'.repeat(16));
    check('14. a hello with an unknown army token is refused', unknown.type === 'error' && unknown.error === 'unauthorized', JSON.stringify(unknown));
    const finished = await hello(h, w1.env.CLAUDE_IN_ZEN_ARMY_TOKEN);
    check('14. a hello with a finished worker\'s token is refused', finished.type === 'error' && finished.error === 'unauthorized', JSON.stringify(finished));

    // Cancel while a worker sleeps with a child of its own.
    script('a2', [{ tool: 'army_start', args: { tasks: [{ goal: 'SCRIPT:sleepy wait a long time', start_url: 'https://example.com/s' }] } },
      { tool: 'army_wait', args: { run_id: '$run', seconds: 60 } }]);
    script('sleepy', [{ child: true }, { sleep: 60000 }]);
    h.send({ type: 'chat', id: 'a2', text: 'LEAD:a2', model: 'army' });
    let sw = null;
    for (let i = 0; i < 100 && !(sw && sw.childPid); i++) { await sleep(100); sw = workersOf(/SCRIPT:sleepy/)[0]; }
    const run3 = (h.armyEvents('a2')[0] || {}).run;
    const t0 = Date.now();
    h.send({ type: 'chat_cancel', id: 'a2' });
    const cancelled = await h.next(m => m.type === 'chat_done' && m.id === 'a2', 5000);
    while (Date.now() - t0 < 3000 && sw && (alive(sw.pid) || alive(sw.childPid))) await sleep(100);
    check('13. Cancel kills the worker and the child it started within 3 s', sw && sw.childPid && !alive(sw.pid) && !alive(sw.childPid), sw && `pids ${sw.pid} ${sw.childPid}`);
    check('13. Cancel sends army_end and ends the chat not ok', h.ends(run3).length >= 1 && !cancelled.ok, JSON.stringify(cancelled));
    const ev3 = h.armyEvents('a2');
    const last3 = ev3[ev3.length - 1];
    check('13. Cancel: the last trail event is finished with the worker stopped', last3 && last3.finished && last3.workers[0].state === 'stopped', JSON.stringify(last3));
  } finally {
    try { h.proc.kill(); } catch {}
  }
}

// Stop while the first tabs are still opening, and the page loads one message may use.
async function raceChecks() {
  const h = startHelper('c', { CLAUDE_IN_ZEN_ARMY_PAGES: '6' });
  try {
    h.send({ type: 'hello', version: 'test' });
    await h.next(m => m.type === 'hello');
    script('noop', []);

    // Cancel lands while Zen is still opening the worker's first tab.
    script('c1', [{ tool: 'army_start', args: { tasks: [{ goal: 'SCRIPT:noop slow tab', start_url: 'https://example.com/slow' }] } }]);
    h.send({ type: 'chat', id: 'c1', text: 'LEAD:c1', model: 'army' });
    for (let i = 0; i < 100 && !h.held.length; i++) await sleep(50);
    const run = (h.armyEvents('c1')[0] || {}).run;
    h.send({ type: 'chat_cancel', id: 'c1' });
    await h.next(m => m.type === 'chat_done' && m.id === 'c1', 5000);
    const before = h.ends(run).length;
    const held = h.held.shift();
    if (held) h.send({ type: 'result', id: held.id, ok: true, result: { tab_id: 777, url: held.args.url, title: 'Slow' } });
    for (let i = 0; i < 40 && h.ends(run).length <= before; i++) await sleep(50);
    check('13. Stop while a first tab opens: army_end goes again once the tab is there, so it closes',
      !!held && before >= 1 && h.ends(run).length > before, `held ${!!held}, ends before ${before}, after ${h.ends(run).length}`);
    check('13. ...and no worker starts for that tab', !workersOf(/slow tab/).length);

    // The page loads of one message: the first run's 5 first tabs leave 1 of 6 here.
    const five = Array.from({ length: 5 }, (_, i) => ({ goal: `SCRIPT:noop part ${i + 1}`, start_url: `https://example.com/p${i + 1}` }));
    script('c2', [
      { tool: 'army_start', args: { tasks: five } },
      { tool: 'army_wait', args: { run_id: '$run', seconds: 20 }, untilDone: true },
      { tool: 'army_start', args: { tasks: five.slice(0, 2) } },
      { tool: 'army_start', args: { tasks: five.slice(0, 1) } },
      { tool: 'army_wait', args: { run_id: '$run', seconds: 20 }, untilDone: true },
    ]);
    h.send({ type: 'chat', id: 'c2', text: 'LEAD:c2', model: 'army' });
    await h.next(m => m.type === 'chat_done' && m.id === 'c2', 30000);
    const st = lead('c2').steps;
    check('15 page loads a message: a run that needs more than is left is refused, naming what is left',
      st[2] && st[2].isError && st[2].text === 'The army has 1 page load left for this message: send at most 1 worker, or answer with what you have.', st[2] && st[2].text);
    check('...and the refused call does not use up one of the two runs', st[3] && !st[3].isError && /"run_id": "r\d+"/.test(st[3].text), st[3] && st[3].text);
  } finally {
    try { h.proc.kill(); } catch {}
  }
}

// A worker that hangs is killed at the hard time; a usage limit and a crash are reported as failures.
async function timeoutChecks() {
  const h = startHelper('b', { CLAUDE_IN_ZEN_ARMY_HARD_MS: '2500' });
  try {
    h.send({ type: 'hello', version: 'test' });
    await h.next(m => m.type === 'hello');
    script('hang', [{ sleep: 60000 }]);
    script('lim', [{ error: 'Claude AI usage limit reached|1760000000' }]);
    script('crash', [{ exit: 3, stderr: 'first line\nboom happened' }]);
    script('linger', [{ lingerReport: 'Linger report: 42.' }]);
    script('b1', [{ tool: 'army_start', args: { tasks: [
      { goal: 'SCRIPT:hang forever', start_url: 'https://example.com/h' },
      { goal: 'SCRIPT:lim hit the limit', start_url: 'https://example.com/l' },
      { goal: 'SCRIPT:crash and burn', start_url: 'https://example.com/c' },
      { goal: 'SCRIPT:linger report then stay', start_url: 'https://example.com/g' },
    ] } }, { tool: 'army_wait', args: { run_id: '$run', seconds: 20 }, untilDone: true }]);
    h.send({ type: 'chat', id: 'b1', text: 'LEAD:b1', model: 'army' });
    await h.next(m => m.type === 'chat_done' && m.id === 'b1', 30000);
    const ev = h.armyEvents('b1');
    const last = ev[ev.length - 1] || { workers: [] };
    const by = id => last.workers.find(w => w.id === id) || {};
    const hang = workersOf(/SCRIPT:hang/)[0];
    check('hard time: a hanging worker is killed and failed "timed out", with army_end', by('w1').state === 'failed' && by('w1').error === 'timed out'
      && h.ends('r1').some(m => m.worker === 'w1') && hang && !alive(hang.pid), JSON.stringify(by('w1')));
    check('a usage limit fails the worker with the limit message', by('w2').state === 'failed' && by('w2').error === 'This account hit its usage limit.', JSON.stringify(by('w2')));
    check('an exit without a result fails with the last stderr line', by('w3').state === 'failed' && by('w3').error === 'boom happened', JSON.stringify(by('w3')));
    const linger = workersOf(/SCRIPT:linger/)[0];
    const waitText = (lead('b1').steps.filter(x => x.tool === 'army_wait').map(x => x.text).join('\n'));
    check('a worker that reports and then lingers is done with its report, and its process is ended', by('w4').state === 'done' && by('w4').ms < 2000
      && /Linger report: 42\./.test(waitText) && h.ends('r1').some(m => m.worker === 'w4') && linger && !alive(linger.pid), JSON.stringify(by('w4')));
  } finally {
    try { h.proc.kill(); } catch {}
  }
}

// The rules on their own (lib/armyguard.js), with the default limits.
function pureChecks() {
  const W = (o) => Object.assign({ id: 'w1', tabs: new Set([101]), mainTab: 101, calls: 0, navs: 0, extra: 0, steps: 0, sources: [], action: '', started: 1000, ended: false }, o);
  const now = 2000;
  let w = W();
  let r = checkCall(w, 'tab_activate', { tab_id: 101 }, now);
  check('rule: tab_activate refused', !r.ok && r.error === 'Workers never bring a tab to the front.');
  r = checkCall(w, 'javascript', {}, now);
  check('rule: a tool outside the list refused', !r.ok && r.error === "Workers can't use javascript. Work with the tools you have.");
  check('rule: workers never touch local pages or files', ['local_page_open', 'local_files', 'local_file_read', 'read_document', 'create_file']
    .every(t => !checkCall(W(), t, { path: '/x' }, now).ok));
  r = checkCall(w, 'tabs_list', {}, now);
  check('rule: tabs_list refused (not a worker tool)', !r.ok && /can't use tabs_list/.test(r.error));
  check('rule: refused calls do not count', w.calls === 0);
  r = checkCall(w, 'click', { ref: 'x' }, now);
  check('rule: missing tab_id becomes the first tab, and counts', r.ok && r.args.tab_id === 101 && w.calls === 1 && w.navs === 0);
  r = checkCall(w, 'click', { tab_id: '101' }, now);
  check('rule: a tab_id given as text is read as a number', r.ok && r.args.tab_id === 101);
  r = checkCall(w, 'fill', { tab_id: 7 }, now);
  check('rule: a foreign tab refused', !r.ok && r.error === 'Tab 7 is not one of your tabs (yours: 101). Work only in your own tabs.');
  const args = { tab_id: 101, url: 'https://a.example' };
  r = checkCall(w, 'navigate', args, now);
  check('rule: navigate counts a page load and returns a new object', r.ok && w.navs === 1 && r.args !== args);
  w = W({ navs: 10 });
  r = checkCall(w, 'navigate', { url: 'https://a.example' }, now);
  check('rule: navigate past the page-load limit refused', !r.ok && r.error === 'You have loaded 10 pages, the most allowed for one worker. Write your report.');
  r = checkCall(w, 'tab_open', { url: 'https://a.example' }, now);
  check('rule: tab_open past the page-load limit refused', !r.ok && /^You have loaded 10 pages/.test(r.error));
  w = W();
  r = checkCall(w, 'tab_open', { url: 'https://a.example', active: true, tab_id: 5 }, now);
  check('rule: tab_open is always in the background', r.ok && r.args.active === false && !('tab_id' in r.args) && w.navs === 1);
  r = checkCall(w, 'tab_open', {}, now);
  check('rule: tab_open needs a url', !r.ok && r.error === 'Give the url to open.');
  w = W({ tabs: new Set([101, 102, 103, 104]), extra: 3 });
  r = checkCall(w, 'tab_open', { url: 'https://a.example' }, now);
  check('rule: extra tabs used up', !r.ok && r.error === 'You already have 4 tabs, the most allowed. Use one of yours: 101, 102, 103, 104.', r.error);
  w = W({ tabs: new Set([101, 102, 103, 104]), extra: 0 });
  r = checkCall(w, 'tab_open', { url: 'https://a.example' }, now);
  check('rule: tabs the pages opened count toward the 4 tabs', !r.ok && /^You already have 4 tabs/.test(r.error));
  w = W({ budget: { pages: 14 } });
  r = checkCall(w, 'navigate', { url: 'https://a.example' }, now);
  check('rule: a page load counts for the whole message', r.ok && w.budget.pages === 15 && w.navs === 1);
  r = checkCall(w, 'tab_open', { url: 'https://b.example' }, now);
  check('rule: past 15 page loads in a message, every worker is refused', !r.ok && r.error === 'The army has loaded 15 pages for this message, the most allowed. Write your report with what you have.', r.error);
  r = checkCall(w, 'get_page_text', {}, now);
  check('rule: reading still works once the page loads are used up', r.ok);
  w = W({ navs: 6 });
  r = checkCall(w, 'navigate', { url: 'https://a.example' }, now);
  check('rule: 6 page loads per worker', !r.ok && /^You have loaded 6 pages/.test(r.error));
  w = W({ tabs: new Set([101, 102, 103, 104]), extra: 3 });
  r = checkCall(w, 'tab_close', { tab_id: 101 }, now);
  check('rule: the first tab cannot be closed', !r.ok && r.error === 'Tab 101 is your first tab: keep it open.');
  r = checkCall(w, 'tab_close', { tab_id: 9 }, now);
  check('rule: a foreign tab cannot be closed', !r.ok && /^Tab 9 is not one of your tabs/.test(r.error));
  r = checkCall(w, 'tab_close', {}, now);
  check('rule: tab_close needs a tab_id', !r.ok && /^Give the tab_id/.test(r.error));
  r = checkCall(w, 'tab_close', { tab_id: 102 }, now);
  check('rule: an extra tab can be closed', r.ok && r.args.tab_id === 102);
  w = W({ calls: 40 });
  r = checkCall(w, 'scroll', {}, now);
  check('rule: calls used up', !r.ok && r.error === 'Budget reached: stop using tools and write your report now.');
  w = W();
  r = checkCall(w, 'scroll', {}, 1000 + 150001);
  check('rule: soft time passed', !r.ok && /^Budget reached/.test(r.error));
  w = W({ ended: true });
  r = checkCall(w, 'scroll', {}, now);
  check('rule: a stopped worker is refused', !r.ok);

  w = W();
  noteResult(w, 'tab_open', { url: 'https://b.example/x', active: false }, { ok: true, result: { tab_id: 150, url: 'https://b.example/x' } });
  check('note: tab_open adds the tab and counts it as extra', w.tabs.has(150) && w.extra === 1 && w.sources.includes('https://b.example/x') && w.action === 'Opening a tab: b.example');
  noteResult(w, 'click', { tab_id: 101 }, { ok: true, result: { opened_tab: { tab_id: 151, url: 'https://c.example' } } });
  check('note: a tab the page opened belongs to the worker, not counted as extra', w.tabs.has(151) && w.extra === 1 && /^Clicking/.test(w.action));
  noteResult(w, 'press_key', { tab_id: 101 }, { ok: true, result: { opened_tab: { tab_id: 152 } } });
  check('note: press_key opened tabs count too', w.tabs.has(152) && w.tabs.size === 4);
  noteResult(w, 'type_text', { tab_id: 101 }, { ok: true, result: { opened_tab: { tab_id: 153 } } });
  check('note: a tab opened past the 4-tab limit is not the worker\'s (the add-on closes it)', !w.tabs.has(153) && w.tabs.size === 4);
  noteResult(w, 'tab_close', { tab_id: 150 }, { ok: true, result: { closed: 150 } });
  check('note: tab_close removes the tab', !w.tabs.has(150) && w.action === 'Closing a tab');
  noteResult(w, 'tab_open', { url: 'https://d.example' }, { ok: false, error: 'nope' });
  check('note: a failed tab_open adds nothing', w.tabs.size === 3 && w.extra === 1);
  w = W();
  noteResult(w, 'get_page_text', { tab_id: 101 }, { ok: true, result: { url: 'https://e.example/p', text: 'x' } });
  noteResult(w, 'get_page_text', { tab_id: 101 }, { ok: true, result: { url: 'https://e.example/p', text: 'x' } });
  check('note: sources are deduped and labelled', w.sources.length === 1 && w.action === 'Reading the page: e.example' && w.steps === 2);
  for (let i = 0; i < 12; i++) noteResult(w, 'navigate', { tab_id: 101 }, { ok: true, result: { url: `https://f.example/${i}` } });
  check('note: at most 8 sources', w.sources.length === 8);
  noteResult(w, 'navigate', { tab_id: 101 }, { ok: true, result: { url: 'about:blank' } });
  check('note: only http(s) pages are sources', !w.sources.includes('about:blank'));
}

(async () => {
  try {
    pureChecks();
    await mainChecks();
    await raceChecks();
    await timeoutChecks();
  } catch (e) {
    check('no unexpected errors', false, e.stack || e.message);
  } finally {
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
