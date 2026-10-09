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
    check('only the Zen tool server', a.includes('--strict-mcp-config') && val('--allowedTools') === 'mcp__claude-in-zen');
    check('no built-in tools when file tools are off', val('--tools') === '' && !a.includes('--add-dir') && val('--permission-mode') === 'dontAsk');
    check('API key not passed to Claude Code', rec.apiKey === null);
    check('runs on the add-on profile', rec.config === path.join(tmp, 'claude-in-zen', 'claude'));
    check('Speed is Haiku 5.5 on high by default', val('--model') === 'claude-haiku-5-5' && val('--effort') === 'high');
    check('chat prompt has no ask-before rule', /no confirmation step/.test(val('--append-system-prompt')));

    toHelper({ type: 'chat', id: 'c2', text: 'again', resume: done.sessionId, files: 'read', folder });
    await next(m => m.type === 'chat_done' && m.id === 'c2', 15000);
    const b = JSON.parse(fs.readFileSync(record, 'utf8')).argv;
    check('resume passes the session id', b[b.indexOf('--resume') + 1] === done.sessionId);
    check('read-only file tools', b[b.indexOf('--tools') + 1] === 'Read,Glob,Grep' && b[b.indexOf('--add-dir') + 1] === folder && b[b.indexOf('--permission-mode') + 1] === 'dontAsk');

    toHelper({ type: 'chat', id: 'c3', text: 'edit', files: 'write', folder, model: 'quality' });
    await next(m => m.type === 'chat_done' && m.id === 'c3', 15000);
    const c = JSON.parse(fs.readFileSync(record, 'utf8')).argv;
    check('Quality is Opus 5.5 on high', c[c.indexOf('--model') + 1] === 'claude-opus-5-5' && c[c.indexOf('--effort') + 1] === 'high');
    check('read-write file tools, never Bash', c[c.indexOf('--tools') + 1] === 'Read,Glob,Grep,Edit,Write' && c[c.indexOf('--permission-mode') + 1] === 'acceptEdits' && !c.join(' ').includes('Bash'));

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

    toHelper({ type: 'chat', id: 'c8', text: 'SLEEP' });
    await sleep(800);
    const exited = new Promise(r => helper.on('exit', r));
    const t1 = Date.now();
    helper.stdin.end();   // what Stop does
    await Promise.race([exited, sleep(3000)]);
    check('Stop ends the helper while a turn runs', Date.now() - t1 < 2000, `${Date.now() - t1} ms`);
  } catch (e) {
    check('no unexpected errors', false, e.message);
  } finally {
    try { helper.kill(); } catch {}
    const failed = results.filter(r => !r).length;
    console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  }
})();
