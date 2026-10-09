'use strict';
// Chat path test with a fake Claude Code: add-on -> helper -> "claude -p" -> tool server -> pipe -> helper -> add-on.
// The fake claude starts the real tool server from the helper's mcp.json and calls tabs_list through it.
// POSIX only (the fake claude is a script with a shebang).   node host/test/chat-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  chat-smoke runs on Linux/macOS only'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-chat-'));
const pipe = path.join(tmp, 'chat.sock');
const fake = path.join(tmp, 'claude');
const record = path.join(tmp, 'argv.json');
const folder = path.join(tmp, 'notes');
fs.mkdirSync(folder);

fs.writeFileSync(fake, `#!${process.execPath}
'use strict';
const fs = require('fs'); const { spawn } = require('child_process');
const argv = process.argv.slice(2);
if (argv[0] === 'auth') {
  // One fake sign-in per profile folder (CLAUDE_CONFIG_DIR), like real Claude Code.
  const dir = process.env.CLAUDE_CONFIG_DIR || '';
  const f = require('path').join(dir, 'fake-login.json');
  fs.appendFileSync(${JSON.stringify(record)} + '.auth', argv[1] + ' ' + dir + '\\n');
  if (argv[1] === 'login') {
    let email = 'new@example.com';
    try { email = fs.readFileSync(${JSON.stringify(record)} + '.next-email', 'utf8').trim(); } catch {}
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ email }));
  }
  if (argv[1] === 'logout') { try { fs.unlinkSync(f); } catch {} }
  if (argv[1] === 'status') {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    process.stdout.write(JSON.stringify(st ? { loggedIn: true, authMethod: 'claude.ai', email: st.email, subscriptionType: 'pro' } : { loggedIn: false, authMethod: 'none' }));
    process.exit(st ? 0 : 1);
  }
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(record)} + '.pid', String(process.pid));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', async () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, prompt, cwd: process.cwd(),
    apiKey: process.env.ANTHROPIC_API_KEY || null, config: process.env.CLAUDE_CONFIG_DIR || null }));
  const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
  const sid = '11111111-2222-3333-4444-555555555555';
  out({ type: 'system', subtype: 'init', session_id: sid });
  if (prompt === 'SLEEP') return setTimeout(() => {}, 60000);
  if (prompt === 'LIMIT') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1760000000', session_id: sid }); return; }
  process.stdout.write('not json, should be ignored\\n');
  // call the real tool server, the way Claude Code would
  const cfg = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers['claude-in-zen'];
  const mcp = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; const waits = {};
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) !== -1) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (waits[m.id]) waits[m.id](m); } });
  const rpc = (id, method, params) => new Promise(r => { waits[id] = r; mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); });
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me look. ' } }, session_id: sid });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__claude-in-zen__tabs_list', input: {} }] }, session_id: sid });
  const r = await rpc(2, 'tools/call', { name: 'tabs_list', arguments: {} });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: !!r.result.isError, content: r.result.content }] }, session_id: sid });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'You have 1 tab.' } }, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Let me look. You have 1 tab.', session_id: sid });
  mcp.stdin.end();
});
`, { mode: 0o755 });

const env = { ...process.env, LOCALAPPDATA: tmp, CLAUDE_IN_ZEN_PIPE: pipe, CLAUDE_IN_ZEN_CLAUDE: fake, ANTHROPIC_API_KEY: 'sk-should-not-leak' };
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const helper = spawn(process.execPath, [path.join(__dirname, '..', 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const inbox = []; let waiters = []; let hbuf = Buffer.alloc(0);
const calls = [];
function toHelper(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  helper.stdin.write(Buffer.concat([head, body]));
}
helper.stdout.on('data', chunk => {
  hbuf = Buffer.concat([hbuf, chunk]);
  while (hbuf.length >= 4) {
    const len = hbuf.readUInt32LE(0);
    if (hbuf.length < 4 + len) break;
    const msg = JSON.parse(hbuf.subarray(4, 4 + len).toString());
    hbuf = hbuf.subarray(4 + len);
    if (msg.type === 'call') {   // play the add-on's tool router
      calls.push(msg);
      toHelper({ type: 'result', id: msg.id, ok: true, result: [{ id: 1, title: 'Docs', url: 'https://example.com', active: true }] });
      continue;
    }
    inbox.push(msg);
    waiters = waiters.filter(w => !w(msg));
  }
});
function next(pred, ms = 8000) {
  const hit = inbox.find(pred);
  if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for helper')), ms);
    waiters.push(m => { if (!pred(m)) return false; clearTimeout(t); inbox.splice(inbox.indexOf(m), 1); resolve(m); return true; });
  });
}
const eventsFor = id => inbox.filter(m => m.type === 'chat_event' && m.id === id).map(m => m.event);

(async () => {
  try {
    toHelper({ type: 'hello', version: 'test' });
    await next(m => m.type === 'hello');
    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'claude-in-zen', 'mcp.json'), 'utf8'));
    check('mcp.json points at the tool server', /zen-mcp\.js$/.test(cfg.mcpServers['claude-in-zen'].args[0]));

    toHelper({ type: 'chat', id: 'c1', text: 'how many tabs?', resume: '' });
    const done = await next(m => m.type === 'chat_done' && m.id === 'c1', 15000);
    const ev = eventsFor('c1');
    const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
    check('turn finishes ok', done.ok, done.error);
    check('session id comes back', done.sessionId === '11111111-2222-3333-4444-555555555555');
    check('prompt sent on stdin', rec.prompt === 'how many tabs?');
    check('streamed text in order', ev.filter(e => e.kind === 'text').map(e => e.text).join('') === 'Let me look. You have 1 tab.');
    check('tool call shown with short name', ev.some(e => e.kind === 'tool' && e.name === 'tabs_list'));
    check('tool round trip reached the add-on', calls.some(c => c.tool === 'tabs_list' && c.source === 'Claude in Zen panel'));
    check('tool result shown', ev.some(e => e.kind === 'tool_result' && !e.error && /example\.com/.test(e.text)));
    const a = rec.argv;
    const val = f => a[a.indexOf(f) + 1];
    check('print mode with streaming', a.includes('-p') && val('--output-format') === 'stream-json' && a.includes('--include-partial-messages'));
    check('only the Zen tool server, web tools allowed', a.includes('--strict-mcp-config') && val('--allowedTools') === 'mcp__claude-in-zen,WebSearch,WebFetch');
    check('file tools off: just Read and the web tools', val('--tools') === 'Read,WebSearch,WebFetch' && !a.includes('--add-dir') && val('--permission-mode') === 'dontAsk');
    check('prompt keeps who-is-who and posting rules', /# Who is who/.test(val('--append-system-prompt')) && /song lyrics/.test(val('--append-system-prompt')));
    check('API key not passed to Claude Code', rec.apiKey === null);
    check('runs on the add-on profile', rec.config === path.join(tmp, 'claude-in-zen', 'claude'));
    check('Speed is Haiku 5.5 on high by default', val('--model') === 'claude-haiku-5-5' && val('--effort') === 'high');
    check('chat prompt has no ask-before rule', /no confirmation step/.test(val('--append-system-prompt')));

    toHelper({ type: 'chat', id: 'c2', text: 'again', resume: done.sessionId, files: 'read', folder });
    await next(m => m.type === 'chat_done' && m.id === 'c2', 15000);
    const b = JSON.parse(fs.readFileSync(record, 'utf8')).argv;
    check('resume passes the session id', b[b.indexOf('--resume') + 1] === done.sessionId);
    check('read-only file tools', b[b.indexOf('--tools') + 1] === 'Read,Glob,Grep,WebSearch,WebFetch' && b[b.indexOf('--add-dir') + 1] === folder && b[b.indexOf('--permission-mode') + 1] === 'dontAsk');

    toHelper({ type: 'chat', id: 'c3', text: 'edit', files: 'write', folder, model: 'quality' });
    await next(m => m.type === 'chat_done' && m.id === 'c3', 15000);
    const c = JSON.parse(fs.readFileSync(record, 'utf8')).argv;
    check('Quality is Opus 5.5 on high', c[c.indexOf('--model') + 1] === 'claude-opus-5-5' && c[c.indexOf('--effort') + 1] === 'high');
    check('read-write file tools, never Bash', c[c.indexOf('--tools') + 1] === 'Read,Glob,Grep,Edit,Write,WebSearch,WebFetch' && c[c.indexOf('--permission-mode') + 1] === 'acceptEdits' && !c.join(' ').includes('Bash'));

    toHelper({ type: 'chat', id: 'c3b', text: 'plus', model: 'speedplus' });
    await next(m => m.type === 'chat_done' && m.id === 'c3b', 15000);
    const sp = JSON.parse(fs.readFileSync(record, 'utf8')).argv;
    check('reply says which model and effort ran', eventsFor('c3b').some(e => e.kind === 'meta' && e.model === 'claude-haiku-5-5' && e.effort === 'max'));
    check('Speed Plus is Haiku 5.5 on max', sp[sp.indexOf('--model') + 1] === 'claude-haiku-5-5' && sp[sp.indexOf('--effort') + 1] === 'max');

    toHelper({ type: 'chat', id: 'c4', text: 'x', files: 'read', folder: path.join(tmp, 'missing') });
    const bad = await next(m => m.type === 'chat_done' && m.id === 'c4');
    check('missing folder refused before starting', !bad.ok && /not found/.test(bad.error));

    toHelper({ type: 'chat', id: 'c5', text: 'LIMIT' });
    const lim = await next(m => m.type === 'chat_done' && m.id === 'c5', 15000);
    check('usage limit flagged', !lim.ok && lim.limit === true, lim.error);

    toHelper({ type: 'chat', id: 'c6', text: 'SLEEP' });
    await sleep(800);
    toHelper({ type: 'chat', id: 'c7', text: 'second' });
    const busy = await next(m => m.type === 'chat_done' && m.id === 'c7');
    check('one turn at a time', !busy.ok && /still answering/.test(busy.error));
    const t0 = Date.now();
    toHelper({ type: 'chat_cancel', id: 'c6' });
    const cancelled = await next(m => m.type === 'chat_done' && m.id === 'c6', 4000);
    check('cancel ends the turn', !cancelled.ok && /Cancelled/.test(cancelled.error), `${Date.now() - t0} ms`);

    // Accounts: one Claude Code profile per account, Google-style.
    const mainDir = path.join(tmp, 'claude-in-zen', 'claude');
    toHelper({ type: 'accounts' });
    let list = await next(m => m.type === 'accounts', 8000);
    check('accounts: main profile listed, signed out, active', list.accounts.length === 1 && list.accounts[0].id === 'main' && !list.accounts[0].loggedIn && list.accounts[0].active);
    fs.writeFileSync(record + '.next-email', 'one@example.com');
    toHelper({ type: 'account_add' });
    const started = await next(m => m.type === 'account_result' && m.action === 'login_started', 8000);
    const added = await next(m => m.type === 'account_result' && m.action === 'login', 15000);
    const newId = added.id;
    check('add account: sign-in window, then the new account is active', started.isNew && added.ok && added.email === 'one@example.com' && /^a[0-9a-z]+$/.test(newId));
    list = await next(m => m.type === 'accounts' && m.accounts.some(a => a.id === newId), 8000);
    check('accounts list puts the active account first', list.accounts[0].id === newId && list.accounts[0].active && list.accounts[0].loggedIn && list.accounts.length === 2);
    const newDir = path.join(tmp, 'claude-in-zen', 'accounts', newId);
    toHelper({ type: 'chat', id: 'acc1', text: 'hi from the new account' });
    await next(m => m.type === 'chat_done' && m.id === 'acc1', 15000);
    check('chat turns run on the active account profile', JSON.parse(fs.readFileSync(record, 'utf8')).config === newDir);
    toHelper({ type: 'account_add' });
    await next(m => m.type === 'account_result' && m.action === 'login_started', 8000);
    const again = await next(m => m.type === 'account_result' && m.action === 'login', 15000);
    const dirsAfter = fs.readdirSync(path.join(tmp, 'claude-in-zen', 'accounts'));
    check('adding the same account twice keeps one and switches to it', again.ok && again.already && again.id === newId && dirsAfter.length === 1, dirsAfter.join(','));
    toHelper({ type: 'account_use', id: 'main' });
    const used = await next(m => m.type === 'account_result' && m.action === 'use', 8000);
    const stMain = await next(m => m.type === 'claude_status' && m.accountId === 'main', 8000);
    check('switching back to main needs no sign-in', used.ok && stMain.accountId === 'main' && !stMain.loggedIn, JSON.stringify({ used, stMain }));
    toHelper({ type: 'account_remove', id: 'main' });
    const refuse = await next(m => m.type === 'account_result' && m.action === 'remove', 8000);
    check('the active account cannot be removed while others exist', !refuse.ok && /Switch to another/.test(refuse.error));
    toHelper({ type: 'account_remove', id: newId });
    const removed = await next(m => m.type === 'account_result' && m.action === 'remove', 8000);
    const authLog = fs.readFileSync(record + '.auth', 'utf8');
    check('removing an account logs it out and deletes its profile', removed.ok && !fs.existsSync(newDir) && authLog.includes('logout ' + newDir));
    check('main profile was never logged out by switching', !authLog.includes('logout ' + mainDir));

    toHelper({ type: 'chat', id: 'c8', text: 'SLEEP' });
    await sleep(800);
    const exited = new Promise(r => helper.on('exit', r));
    const t1 = Date.now();
    helper.stdin.end();   // what Stop does
    await Promise.race([exited, sleep(3000)]);
    check('Stop ends the helper while a turn runs', Date.now() - t1 < 2000, `${Date.now() - t1} ms`);
    await sleep(300);
    const pid = Number(fs.readFileSync(record + '.pid', 'utf8'));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    check('Stop kills the running Claude Code process', !alive, `pid ${pid}`);
  } catch (e) {
    check('no unexpected errors', false, e.message);
  } finally {
    try { helper.kill(); } catch {}
    const failed = results.filter(r => !r).length;
    console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  }
})();
