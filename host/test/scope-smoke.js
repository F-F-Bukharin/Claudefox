'use strict';
// WebFetch scope (A3): the site table and the decision (lib/sites.js), the chat settings that carry the WebFetch hook
// (lib/chatargs.js), the hook script against a fake helper pipe (webfetch-hook.js), and the real helper with a fake
// Claude: a pipe check, the add-on's scope and local_read messages, a stream Read, and the hook's client off the list.
// The helper part needs Linux or macOS (the fake Claude is a script with a shebang).   node host/test/scope-smoke.js
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-scope-'));
// Everything the helper and the hook read or write lives under tmp: the data folder (LOCALAPPDATA) and the test pipes.
process.env.LOCALAPPDATA = tmp;
process.env.CLAUDEFOX_TEST = '1';
const S = require('../lib/sites');
const A = require('../lib/chatargs');
const P = require('../lib/paths');

const hookPath = path.join(__dirname, '..', 'webfetch-hook.js');
const NO_CHECK = 'Claudefox could not check this address, so WebFetch is blocked.';
const OFF = 'WebFetch is off for the rest of this message because Claude read a local file.';
const NOT_SITE = site => `${site} is not one of this chat's sites. Ask the user to allow it in the panel first.`;

let passed = 0;
const failed = [];
const check = (name, ok, detail) => { if (ok) passed++; else failed.push(name + (detail ? ` (${detail})` : '')); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let helper = null, fake = null;

// 1. The site table (lib/sites.js): the rows of the contracts, and the trailing dot.
const rows = [
  ['siteOf drops www and lower-cases', S.siteOf('https://www.YouTube.com/watch?v=1'), 'youtube.com'],
  ['siteOf keeps a subdomain', S.siteOf('http://m.youtube.com/'), 'm.youtube.com'],
  ['siteOf keeps an IPv4 address', S.siteOf('http://127.0.0.1:8080/x'), '127.0.0.1'],
  ['siteOf keeps localhost', S.siteOf('http://localhost:3000/'), 'localhost'],
  ['siteOf keeps an IPv6 address in brackets', S.siteOf('https://[::1]:8443/'), '[::1]'],
  ['siteOf is empty for file:', S.siteOf('file:///C:/x'), ''],
  ['siteOf is empty for about:', S.siteOf('about:blank'), ''],
  ['siteOf is empty for text that is no URL', S.siteOf('not a url'), ''],
  ['siteOf drops one trailing dot', S.siteOf('https://example.com./x'), 'example.com'],
  ['siteOf drops only one www.', S.siteOf('https://www.www.example.com/'), 'www.example.com'],
  ['match: a subdomain of a listed site', S.match(['youtube.com'], 'm.youtube.com'), true],
  ['match: the site itself', S.match(['youtube.com'], 'youtube.com'), true],
  ['match: a look-alike is no match', S.match(['youtube.com'], 'notyoutube.com'), false],
  ['match: a subdomain entry does not cover its parent', S.match(['m.youtube.com'], 'youtube.com'), false],
  ['match: an IP matches only exactly', S.match(['0.1'], '127.0.0.1'), false],
  ['match: the same IP', S.match(['127.0.0.1'], '127.0.0.1'), true],
  ['match: localhost', S.match(['localhost'], 'localhost'), true],
  ['match: localhost does not cover a name under it', S.match(['localhost'], 'x.localhost'), false],
  ['match: an empty list matches nothing', S.match([], 'a.com'), false],
];
for (const [name, got, want] of rows) check(name, same(got, want), `got ${JSON.stringify(got)}`);

// 1b. The decision (lib/sites.js decide): allowed only with no local read and a listed site, or trust.
const turn = (sites, localRead) => ({ sites, localRead: !!localRead });
const r1 = S.decide(turn(['youtube.com']), 'https://www.youtube.com/x', false);
check('decide: a listed site is allowed', r1.allowed === true, JSON.stringify(r1));
check('decide: a subdomain of a listed site is allowed', S.decide(turn(['youtube.com']), 'https://m.youtube.com/x', false).allowed === true);
const r2 = S.decide(turn(['youtube.com']), 'https://notyoutube.com/', false);
check('decide: another site is refused with the panel reason', r2.allowed === false && r2.reason === NOT_SITE('notyoutube.com'), JSON.stringify(r2));
check('decide: trusted reaches any site', S.decide(turn([]), 'https://other.example/', true).allowed === true);
const r3 = S.decide(turn(['youtube.com'], true), 'https://youtube.com/', false);
check('decide: after a local read WebFetch is off, with its reason', r3.allowed === false && r3.reason === OFF, JSON.stringify(r3));
check('decide: a local read beats trusted', S.decide(turn([], true), 'https://a.example/', true).reason === OFF);
const r4 = S.decide(null, 'https://youtube.com/', false);
check('decide: no running turn is refused as could-not-check', r4.allowed === false && r4.reason === NO_CHECK, JSON.stringify(r4));
const r5 = S.decide(turn([]), 'file:///C:/x', true);
check('decide: a non-http address is refused even when trusted', r5.allowed === false && r5.reason === NO_CHECK, JSON.stringify(r5));

// 2. The chat settings carry the hook beside the hooks already there, run by the helper's own Node.
const settingsFile = path.join(tmp, 'chat-settings.json');
const tb = { strict: true, settings: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] } }, allowTools: [], skills: false, extras: [] };
A.chatArgs({ mode: null, folder: '' }, '', { model: 'claude-haiku-5-5', effort: 'high' }, { tb, settingsFile, mcpConfig: path.join(tmp, 'mcp.json') });
const written = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const pre = (written.hooks && written.hooks.PreToolUse) || [];
check('chat settings: the WebFetch hook runs process.execPath on the hook script, beside the existing hooks',
  same(pre, [{ matcher: 'Bash', hooks: [] }, { matcher: 'WebFetch', hooks: [{ type: 'command', command: `"${process.execPath}" "${hookPath}"` }] }]), JSON.stringify(pre));
check('chat settings: the guard deny rules stay', Array.isArray(written.permissions && written.permissions.deny));

// 3. The hook script against a fake helper pipe: the token, the reply, and every refusal exits 2 with one stderr line.
let silent = false;
const seen = [];
async function hookTests() {
  const hookPipe = process.platform === 'win32' ? `\\\\.\\pipe\\cfx-scope-${process.pid}` : path.join(tmp, 'hook.sock');   // Windows: a named pipe
  const TOKEN = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(P.TOKEN_FILE), { recursive: true });
  fs.writeFileSync(P.TOKEN_FILE, TOKEN);
  const answer = m => (String(m.url || '').startsWith('https://ok.example/')
    ? { allowed: true, reason: '' } : { allowed: false, reason: NOT_SITE('no.example') });
  fake = net.createServer(sock => {
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.type === 'hello') {
          seen.push(m);
          sock.write(JSON.stringify(m.token === TOKEN ? { type: 'hello_ok' } : { type: 'error', error: 'unauthorized' }) + '\n');
        } else if (m.type === 'webfetch_check') {
          seen.push(m);
          if (!silent) sock.write(JSON.stringify(Object.assign({ type: 'webfetch_result' }, answer(m))) + '\n');
        }
      }
    });
  });
  await new Promise(r => fake.listen(hookPipe, r));
  const runHook = (input, env) => new Promise(resolve => {
    const child = spawn(process.execPath, [hookPath], { env: { ...process.env, CLAUDEFOX_PIPE: hookPipe, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stdin.on('error', () => {});
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, err }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });

  const ok = await runHook({ session_id: 'S1', tool_input: { url: 'https://ok.example/a' } });
  check('hook: an allowed address exits 0 with nothing on stderr', ok.code === 0 && ok.err === '', JSON.stringify(ok));
  check('hook: a hello with the token and the hook name, then the session and the address',
    seen.some(m => m.type === 'hello' && m.token === TOKEN && m.client === 'webfetch-hook')
    && seen.some(m => m.type === 'webfetch_check' && m.session === 'S1' && m.url === 'https://ok.example/a'));
  const no = await runHook({ session_id: 'S1', tool_input: { url: 'https://no.example/' } });
  check('hook: a refused address exits 2 with the reason as one stderr line', no.code === 2 && no.err === NOT_SITE('no.example') + '\n', JSON.stringify(no));
  const bad = await runHook('{not json');
  check('hook: bad input exits 2 with the could-not-check line', bad.code === 2 && bad.err === NO_CHECK + '\n', JSON.stringify(bad));
  const gone = await runHook({ session_id: 'S1', tool_input: { url: 'https://ok.example/' } }, { CLAUDEFOX_PIPE: path.join(tmp, 'none.sock') });
  check('hook: no helper running exits 2 with the could-not-check line', gone.code === 2 && gone.err === NO_CHECK + '\n', JSON.stringify(gone));
  silent = true;
  const t0 = Date.now();
  const hung = await runHook({ session_id: 'S1', tool_input: { url: 'https://ok.example/' } });
  silent = false;
  check('hook: a helper that never answers blocks the call within 5 s',
    hung.code === 2 && hung.err === NO_CHECK + '\n' && Date.now() - t0 < 7000, `${Date.now() - t0} ms ${JSON.stringify(hung)}`);
}

// 4. The real helper with a fake Claude (Linux and macOS only: the fake Claude is a script with a shebang).
let helperRan = false;
async function helperTests() {
  if (process.platform === 'win32') return;
  const realPipe = path.join(tmp, 'helper.sock');
  const SID = '11111111-2222-3333-4444-555555555555';
  const fakeClaude = path.join(tmp, 'claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
'use strict';
// Print mode: reads the prompt, streams a session id, a local Read when the prompt says "read", then a WebSearch that
// the test waits for. It stays up until the helper stops it. Other calls (mcp, plugin) answer at once.
if (!process.argv.includes('-p')) { process.stdout.write('[]\\n'); process.exit(0); }
if (process.argv.includes('--input-format')) { process.stderr.write("error: unknown option '--input-format'\\n"); process.exit(1); }   // this fake takes one prompt per process: the helper falls back to that
let prompt = '';
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  const out = (type, content) => process.stdout.write(JSON.stringify({ type, session_id: '${SID}', message: { content } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: '${SID}' }) + '\\n');
  if (prompt.includes('read')) out('assistant', [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/tmp/x' } }]);
  out('assistant', [{ type: 'tool_use', id: 'w1', name: 'WebSearch', input: { query: 'x' } }]);
  setInterval(() => {}, 1000);
});
`, { mode: 0o755 });
  const env = { ...process.env, LOCALAPPDATA: tmp, CLAUDEFOX_PIPE: realPipe, CLAUDEFOX_TEST: '1', CLAUDEFOX_CLAUDE: fakeClaude };
  delete env.ANTHROPIC_API_KEY;
  helper = spawn(process.execPath, [path.join(__dirname, '..', 'claudefox-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  helper.stdin.on('error', () => {});
  const inbox = [];
  const waiters = [];
  let hbuf = Buffer.alloc(0);
  helper.stdout.on('data', chunk => {
    hbuf = Buffer.concat([hbuf, chunk]);
    while (hbuf.length >= 4 && hbuf.length >= 4 + hbuf.readUInt32LE(0)) {
      const len = hbuf.readUInt32LE(0);
      const msg = JSON.parse(hbuf.subarray(4, 4 + len).toString());
      hbuf = hbuf.subarray(4 + len);
      inbox.push(msg);
      for (const w of waiters.splice(0)) if (!w(msg)) waiters.push(w);
    }
  });
  const toHelper = msg => {
    const body = Buffer.from(JSON.stringify(msg));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    helper.stdin.write(Buffer.concat([head, body]));
  };
  const waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const hit = inbox.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error('no such message from the helper')), ms);
    waiters.push(m => { if (!pred(m)) return false; clearTimeout(timer); resolve(m); return true; });
  });
  // The helper handles native messages in order, so the pong after a message means that message is in place.
  let seq = 0;
  const sync = async () => { const t = `s${++seq}`; toHelper({ type: 'ping', t }); await waitFor(m => m.type === 'pong' && m.t === t); };
  const pipeCall = (msg, replyType) => new Promise((resolve, reject) => {
    const sock = net.connect(realPipe);
    let buf = '';
    let sent = false;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('the helper did not reply')); }, 5000);
    sock.on('error', e => { clearTimeout(timer); reject(e); });
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'hello', token: fs.readFileSync(P.TOKEN_FILE, 'utf8').trim(), client: 'webfetch-hook' }) + '\n'));
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.type === 'hello_ok' && !sent) { sent = true; sock.write(JSON.stringify(msg) + '\n'); }
        else if (m.type === replyType) { clearTimeout(timer); sock.destroy(); resolve(m); }
        else if (m.type === 'error') { clearTimeout(timer); sock.destroy(); reject(new Error(m.error)); }
      }
    });
  });
  const ask = (session, url) => pipeCall({ type: 'webfetch_check', session, url }, 'webfetch_result');
  await sleep(800);   // the helper starts its pipe and writes its token
  toHelper({ type: 'chat', id: 'w1', text: 'hello there', sites: ['youtube.com'], trusted: false });
  await waitFor(m => m.type === 'chat_event' && m.id === 'w1' && m.event.kind === 'tool' && m.event.name === 'WebSearch');
  const a1 = await ask(SID, 'https://www.youtube.com/x');
  check('helper: a listed site of the running chat is allowed through the pipe', a1.allowed === true, JSON.stringify(a1));
  const a2 = await ask(SID, 'https://other.example/');
  check('helper: another site is refused with the panel reason', a2.allowed === false && a2.reason === NOT_SITE('other.example'), JSON.stringify(a2));
  const a3 = await ask('not-this-session', 'https://www.youtube.com/x');
  check('helper: another session has no running turn: could-not-check', a3.allowed === false && a3.reason === NO_CHECK, JSON.stringify(a3));
  toHelper({ type: 'scope', id: 'w1', sites: ['other.example'], trusted: true });
  await sync();
  const b1 = await ask(SID, 'https://other.example/x');
  check('helper: the add-on scope sets the sites', b1.allowed === true, JSON.stringify(b1));
  const b2 = await ask(SID, 'https://youtube.com/');
  check('helper: a site dropped from the scope is refused', b2.allowed === false, JSON.stringify(b2));
  const b3 = await ask(SID, 'https://nope.example/');
  check('helper: trusted from the add-on alone does not allow a site', b3.allowed === false && b3.reason === NOT_SITE('nope.example'), JSON.stringify(b3));
  toHelper({ type: 'local_read', id: 'w1' });
  await sync();
  const c1 = await ask(SID, 'https://other.example/x');
  check('helper: a local_read from the add-on turns WebFetch off for the turn', c1.allowed === false && c1.reason === OFF, JSON.stringify(c1));
  const st = await pipeCall({ type: 'status', id: 'st' }, 'status');
  check('helper: the hook client stays off the clients list', Array.isArray(st.clients) && !st.clients.includes('webfetch-hook'), JSON.stringify(st.clients));
  toHelper({ type: 'chat_cancel', id: 'w1' });
  await waitFor(m => m.type === 'chat_done' && m.id === 'w1');
  toHelper({ type: 'chat', id: 'w2', text: 'read it', sites: ['youtube.com'], trusted: false });
  await waitFor(m => m.type === 'chat_event' && m.id === 'w2' && m.event.kind === 'tool' && m.event.name === 'WebSearch');
  const d1 = await ask(SID, 'https://www.youtube.com/x');
  check('helper: a Read in the stream turns WebFetch off, even for a listed site', d1.allowed === false && d1.reason === OFF, JSON.stringify(d1));
  toHelper({ type: 'chat_cancel', id: 'w2' });
  await waitFor(m => m.type === 'chat_done' && m.id === 'w2');
  helperRan = true;
}

(async () => {
  try {
    await hookTests();
    await helperTests();
  } catch (e) {
    check('scope-smoke ran to the end', false, e.stack || e.message);
  } finally {
    // The helper still writes its log and data folder for a moment after the kill, so the temp folder goes only once it
    // has exited (5 s at most), and rmSync retries a folder that something wrote into while it was being emptied.
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const exited = new Promise(r => helper.once('exit', r));
      helper.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    if (fake) fake.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (failed.length) {
    for (const f of failed) console.log(`FAIL  ${f}`);
    console.log(`${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`scope-smoke: ${passed} checks passed${helperRan ? '' : ' (helper part skipped on Windows)'}`);
  process.exit(0);
})();
