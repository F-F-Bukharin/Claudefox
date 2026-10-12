'use strict';
// Smoke test for the helper. It plays the add-on (native messaging on the helper's stdin/stdout)
// and a local client on the pipe. Uses a throwaway data folder and pipe name.
//   node host/test/smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-smoke-'));
const pipe = process.platform === 'win32'
  ? `\\\\.\\pipe\\claude-in-zen-smoke-${process.pid}`
  : path.join(tmp, 'smoke.sock');
const env = { ...process.env, LOCALAPPDATA: tmp, CLAUDE_IN_ZEN_PIPE: pipe, CLAUDE_IN_ZEN_TEST: '1' };
const { onLines, sendLine } = require('../lib/lines');

const results = [];
const check = (name, ok, extra) => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const child = spawn(process.execPath, [path.join(__dirname, '..', 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });

// Framed reader for the helper's stdout.
const inbox = [];
let waiters = [];
let buf = Buffer.alloc(0);
child.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    inbox.push(msg);
    waiters = waiters.filter(w => !w(msg));
  }
});
function toHost(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  child.stdin.write(Buffer.concat([head, body]));
}
function fromHost(pred, ms = 3000) {
  const hit = inbox.find(pred);
  if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for helper message')), ms);
    waiters.push(m => { if (!pred(m)) return false; clearTimeout(t); inbox.splice(inbox.indexOf(m), 1); resolve(m); return true; });
  });
}

function client(tokenValue, name) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    const msgs = [];
    let waiting = [];
    onLines(sock, m => { msgs.push(m); waiting = waiting.filter(w => !w(m)); });
    sock.on('error', reject);
    sock.on('connect', () => {
      sendLine(sock, { type: 'hello', token: tokenValue, client: name });
      resolve({
        sock,
        next(pred, ms = 3000) {
          const hit = msgs.find(pred);
          if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit); }
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timeout waiting for pipe message')), ms);
            waiting.push(m => { if (!pred(m)) return false; clearTimeout(t); msgs.splice(msgs.indexOf(m), 1); res(m); return true; });
          });
        },
      });
    });
  });
}

(async () => {
  try {
    toHost({ type: 'hello', version: 'smoke' });
    const hello = await fromHost(m => m.type === 'hello');
    check('helper answers hello', hello.version, `v${hello.version}`);

    const tokenFile = path.join(tmp, 'claude-in-zen', 'pipe-token');
    for (let i = 0; i < 50 && !fs.existsSync(tokenFile); i++) await sleep(50);
    const token = fs.readFileSync(tokenFile, 'utf8');
    check('token file written', token.length === 64);
    await sleep(200);

    const bad = await client('wrong-token', 'intruder');
    const denied = await bad.next(m => m.type === 'error');
    check('wrong token refused', denied.error === 'unauthorized');

    const c = await client(token, 'smoke');
    const ok = await c.next(m => m.type === 'hello_ok');
    check('right token accepted', ok.version);
    const announce = await fromHost(m => m.type === 'clients');
    check('add-on told about the client', announce.clients.includes('smoke'));

    sendLine(c.sock, { type: 'call', id: 'a1', tool: 'tabs_list', args: { x: 1 } });
    const call = await fromHost(m => m.type === 'call');
    check('call relayed to add-on', call.tool === 'tabs_list' && call.source === 'smoke' && call.args.x === 1);
    toHost({ type: 'result', id: call.id, ok: true, result: [{ id: 7, title: 'Tab' }] });
    const res = await c.next(m => m.type === 'result' && m.id === 'a1');
    check('result relayed to client', res.ok && res.result[0].id === 7);

    sendLine(c.sock, { type: 'call', id: 'big', tool: 'screenshot', args: {} });
    const call2 = await fromHost(m => m.type === 'call' && m.tool === 'screenshot');
    const big = 'x'.repeat(3 * 1024 * 1024);
    toHost({ type: 'result', id: call2.id, ok: true, result: { data: big } });
    const res2 = await c.next(m => m.id === 'big', 8000);
    check('3 MB result intact', res2.result.data.length === big.length);

    sendLine(c.sock, { type: 'call', id: 'slow', tool: 'wait_for', args: {}, timeout_ms: 1000 });
    await fromHost(m => m.type === 'call' && m.tool === 'wait_for');
    const t0 = Date.now();
    const res3 = await c.next(m => m.id === 'slow', 4000);
    check('unanswered call times out', !res3.ok && /did not answer/.test(res3.error), `${Date.now() - t0} ms`);

    const closed = new Promise(r => c.sock.on('close', r));
    const exited = new Promise(r => child.on('exit', r));
    const t1 = Date.now();
    child.stdin.end();
    await Promise.race([Promise.all([closed, exited]), sleep(3000)]);
    check('Stop (stdin closed) ends helper and pipe', Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
    check('token file removed', !fs.existsSync(tokenFile));
  } catch (e) {
    check('no unexpected errors', false, e.message);
  } finally {
    try { child.kill(); } catch {}
    const failed = results.filter(r => !r[1]).length;
    console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  }
})();
