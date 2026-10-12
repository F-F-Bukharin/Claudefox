'use strict';
// Hardening checks for the native messaging channel (host/lib/nm.js) and the Claude Code path override (host/lib/claudecode.js).
// A message from the add-on over 64 MiB is refused: the add-on is told at once, and the message's bytes are read off the
// pipe and dropped, never kept. A reply over 1 MiB is not thrown away: the add-on gets a short error with the same id.
// The CLAUDE_IN_ZEN_CLAUDE override counts only with CLAUDE_IN_ZEN_TEST=1 (host/lib/paths.js).
// No Zen, no Windows and no Claude Code needed: the channel runs on in-memory streams, and the program the override
// names is a file that is never run.
//   node test/harden-native.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const MB = 1024 * 1024;
const LIMIT_IN = 64 * MB;   // the spec's limit for one message from the add-on (B11)
let passed = 0, failed = 0;
const check = (name, ok, extra) => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  ' + extra : ''}`);
};

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-harden-native-')));
process.env.LOCALAPPDATA = path.join(tmp, 'local');   // log.js and paths.js read it when they load
const { NativeChannel, MAX_IN } = require('../host/lib/nm');
const log = require('../host/lib/log');
const P = require('../host/lib/paths');

const tick = () => new Promise(resolve => setImmediate(resolve));
// The 4-byte little-endian length that starts a frame.
const head = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
// A whole frame: the length, then the JSON of obj.
const json = obj => { const body = Buffer.from(JSON.stringify(obj), 'utf8'); return Buffer.concat([head(body.length), body]); };
// The frames in some bytes, parsed. A frame that runs past the end is an error.
function frames(buf) {
  const out = [];
  for (let i = 0; i < buf.length;) {
    const n = buf.readUInt32LE(i);
    if (i + 4 + n > buf.length) throw new Error('a frame runs past the end');
    out.push(JSON.parse(buf.subarray(i + 4, i + 4 + n).toString('utf8')));
    i += 4 + n;
  }
  return out;
}
// A channel on an input the test writes to, and an output whose bytes the test reads back.
function channel() {
  const input = new PassThrough(), output = new PassThrough();
  const written = [];
  output.on('data', c => written.push(c));
  const ch = new NativeChannel(input, output);
  const raw = () => Buffer.concat(written);
  return { input, ch, raw, sent: () => frames(raw()) };
}

async function main() {
  // The warnings go to a log file in the temp folder, so the test can read them back.
  log.open('harden-native.log');
  const logFile = path.join(P.LOG_DIR, 'harden-native.log');

  // ---- B11 input: a message over 64 MiB is refused, and its bytes are dropped as they arrive
  {
    const { input, ch, sent } = channel();
    const got = [];
    let badCount = 0;   // counted, not kept: a wrong implementation must not fill memory with errors
    ch.on('message', m => got.push(m));
    ch.on('bad', () => { badCount++; });
    check('the input limit is exported as 64 MiB', MAX_IN === LIMIT_IN, String(MAX_IN));
    let maxSize = 0, maxChunks = 0;
    const seen = () => { maxSize = Math.max(maxSize, ch.size); maxChunks = Math.max(maxChunks, ch.chunks.length); };
    input.write(head(LIMIT_IN + 1)); await tick(); seen();   // a header that announces 64 MiB + 1 bytes
    const piece = Buffer.alloc(MB);
    for (let i = 0; i < 64; i++) { input.write(piece); await tick(); seen(); }   // the body, in 1 MiB chunks
    // The last byte of the body and then a normal ping, in one write: the ping must still arrive.
    input.write(Buffer.concat([Buffer.alloc(1), json({ type: 'ping' })])); await tick(); seen();
    const out = sent();
    check('the over-size message is not delivered, and the ping after it is', got.length === 1 && got[0].type === 'ping', JSON.stringify(got));
    check('the refused body is not parsed either', badCount === 0, `${badCount} unreadable`);
    check('the add-on gets one host_error that says the message was too large', out.length === 1 && out[0].type === 'host_error'
      && out[0].error === 'A message was too large (65 MB, limit 64 MB).', JSON.stringify(out));
    check('the channel never held more than a few MB of the body', maxSize <= 2 * MB && maxChunks <= 4, `held ${maxSize} bytes in ${maxChunks} chunks`);
    input.end();
  }

  // ---- B11 input: exactly 64 MiB is not over the limit, so the channel waits for that body and refuses nothing
  {
    const { input, ch, sent } = channel();
    input.write(head(LIMIT_IN)); await tick();
    check('a header of exactly 64 MiB is accepted: the channel waits for the body', sent().length === 0 && ch.need === LIMIT_IN);
    input.end();
  }

  // ---- B11 input: normal messages keep their framing, an unreadable body is 'bad', and the end is passed on
  {
    const { input, ch } = channel();
    const got = [];
    let badCount = 0, ended = false;
    ch.on('message', m => got.push(m));
    ch.on('bad', () => { badCount++; });
    ch.on('end', () => { ended = true; });
    const junk = Buffer.concat([head(5), Buffer.from('{nope', 'utf8')]);
    const all = Buffer.concat([json({ type: 'a' }), junk, json({ type: 'b', text: 'x' })]);
    // The bytes arrive in four writes, cut inside a header and inside a body.
    for (const [from, to] of [[0, 2], [2, 18], [18, 40], [40]]) { input.write(all.subarray(from, to)); await tick(); }
    input.end(); await tick();
    check('two readable messages arrive in order, however the bytes are split', got.length === 2 && got[0].type === 'a' && got[1].type === 'b' && got[1].text === 'x', JSON.stringify(got));
    check('an unreadable body is reported as bad, once', badCount === 1, `${badCount} bad`);
    check('the end of the input is passed on', ended);
  }

  // ---- B11 output: a reply over 1 MiB is not thrown away: the add-on gets a short error with the same id
  {
    const { ch, sent } = channel();
    // The JSON of this reply is a little over 2 MiB, which rounds up to 3 MB.
    let threw = null;
    let returned;
    try { returned = ch.send({ type: 'chat_event', id: 'c1', text: 'x'.repeat(2 * MB) }); } catch (e) { threw = e; }
    await tick();
    const out = sent();
    check('an over-size reply does not throw', threw === null, threw && threw.message);
    check('send() answers false for an over-size reply, so the helper knows the message itself did not go', returned === false, String(returned));
    check('the add-on gets the reply-too-large error for that id, with the size rounded up to 3 MB', out.length === 1
      && out[0].type === 'error' && out[0].id === 'c1' && out[0].error === 'The reply was too large to send (3 MB).', JSON.stringify(out).slice(0, 200));
  }

  // ---- B11 output: a normal reply is written as before, and a reply of exactly 1 MiB is still sent
  {
    const { ch, raw } = channel();
    const sentOk = ch.send({ type: 'ping' });
    await tick();
    check('send() answers true for a normal reply', sentOk === true, String(sentOk));
    check('a normal reply is written as before: the length, then the JSON', raw().equals(json({ type: 'ping' })));
    const edge = { type: 'x', text: 'y'.repeat(MB - Buffer.byteLength(JSON.stringify({ type: 'x', text: '' }))) };
    const at = channel();
    at.ch.send(edge);
    await tick();
    check('a reply of exactly 1 MiB is sent, not replaced', at.raw().length === 4 + MB && (at.sent()[0] || {}).text === edge.text);
  }

  // ---- both refusals are written to the log as warnings
  const logged = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('the refused input is logged as a warning', /warn\s+message from the add-on too large \(65 MB, limit 64 MB\)/.test(logged), logged.slice(0, 200));
  check('the over-size reply is logged as a warning that names its type', /warn\s+reply too large to send \(3 MB\): chat_event/.test(logged));

  // ---- B9: the Claude Code path override counts only with CLAUDE_IN_ZEN_TEST=1 (host/lib/claudecode.js)
  // The override names a file that exists but is never run: findClaude only checks that it is there.
  const fakeClaude = path.join(tmp, 'fake-claude');
  fs.writeFileSync(fakeClaude, '');
  // The child has no Claude Code where findClaude looks (an empty home folder and an empty PATH folder), so the only
  // way it can find a program is through the override.
  const home = path.join(tmp, 'home'), bin = path.join(tmp, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const code = [
    `const { createClaudeCode } = require(${JSON.stringify(path.join(root, 'host', 'lib', 'claudecode.js'))});`,
    `process.stdout.write(String(createClaudeCode({ accountDir: () => '', activeId: () => '', sendAddon: () => {} }).findClaude()));`,
  ].join('');
  // Runs findClaude() in a child process and returns what it printed ("null" when it finds nothing).
  const findWith = extra => {
    const env = {};
    // This process's environment, minus the variables set here (any casing: Windows calls the path variable Path).
    for (const [k, v] of Object.entries(process.env)) {
      if (!/^(path|home|userprofile|localappdata|claude_in_zen_test|claude_in_zen_claude)$/i.test(k)) env[k] = v;
    }
    const r = spawnSync(process.execPath, ['-e', code], {
      env: { ...env, HOME: home, USERPROFILE: home, PATH: bin, LOCALAPPDATA: path.join(tmp, 'local-child'), CLAUDE_IN_ZEN_CLAUDE: fakeClaude, ...extra },
      encoding: 'utf8', timeout: 20000,
    });
    return r.status === 0 ? r.stdout : `(exit ${r.status}) ${r.stderr}`;
  };
  const unset = findWith({});
  const on = findWith({ CLAUDE_IN_ZEN_TEST: '1' });
  const zero = findWith({ CLAUDE_IN_ZEN_TEST: '0' });
  check('without CLAUDE_IN_ZEN_TEST the override is ignored, and findClaude finds nothing', unset === 'null', unset);
  check('with CLAUDE_IN_ZEN_TEST=1 the override is the program found', on === fakeClaude, on);
  check('with CLAUDE_IN_ZEN_TEST=0 the override is ignored too', zero === 'null', zero);
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
  process.exitCode = failed ? 1 : 0;
}, e => { console.log(`FAIL ${e.stack || e}`); process.exitCode = 1; });
