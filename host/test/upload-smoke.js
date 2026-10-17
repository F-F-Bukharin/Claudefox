'use strict';
// Uploads from the helper side (lib/upload.js): a file the user allowed is sent to the add-on as a card call, then parts, then
// the attach call; every message stays under 1 MB (Zen limits messages from the host to 1 MB). A path outside the allowed
// folders, a file over 25 MB and a secret file are refused before anything is sent. The add-on is a fake callAddon.
//   node host/test/upload-smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadFile, MAX_UPLOAD_BYTES } = require('../lib/upload');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const MB = 1024 * 1024;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfxup-'));   // a temp folder of this test, removed at the end
const granted = path.join(dir, 'granted'), other = path.join(dir, 'other');
fs.mkdirSync(granted); fs.mkdirSync(other);
fs.writeFileSync(path.join(granted, 'hello.txt'), 'hello world');
fs.writeFileSync(path.join(other, 'outside.txt'), 'x');
fs.writeFileSync(path.join(granted, '.env'), 'TOKEN=1');
const big = path.join(granted, 'big.bin');
{ const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 25 * MB + 1); fs.closeSync(fd); }
const twoMb = path.join(granted, 'two.bin');
fs.writeFileSync(twoMb, Buffer.alloc(Math.round(2.5 * MB), 7));

// A fake add-on: the card answer comes from `answer`; parts and the attach step always succeed.
function fakeAddon(answer) {
  const calls = [];
  const callAddon = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'upload_attach' && args.ask) return answer === 'deny' ? { ok: false, error: 'The user did not allow this upload.' } : { ok: true, result: { accepted: true, site: 'example.com' } };
    if (tool === 'upload_part') return { ok: true, result: { received: args.index } };
    if (tool === 'upload_attach') return { ok: true, result: { attached: 'hello.txt', site: 'example.com' } };
    return { ok: false, error: `unknown tool ${tool}` };
  };
  return { calls, callAddon };
}
const deps = callAddon => ({ folders: () => [granted], callAddon });
const refusal = p => p.then(() => null, e => e.message);
const pick = (f, file) => uploadFile({ path: file, selector: '#up' }, deps(f.callAddon));

(async () => {
  try {
    const a = fakeAddon('allow');
    const outside = await refusal(pick(a, path.join(other, 'outside.txt')));
    ok('a path outside the allowed folders is refused before anything is sent', /Not allowed/.test(outside || '') && a.calls.length === 0, outside);
    const huge = await refusal(pick(a, big));
    ok('a file over 25 MB is refused before anything is sent', /25 MB/.test(huge || '') && a.calls.length === 0, huge);
    const secret = await refusal(pick(a, path.join(granted, '.env')));
    ok('a secret file is refused by guard before anything is sent', /Not allowed/.test(secret || '') && a.calls.length === 0, secret);
    const d = fakeAddon('deny');
    const denied = await refusal(pick(d, path.join(granted, 'hello.txt')));
    ok('a card the user refuses ends the upload with the add-on message, with no parts sent',
      denied === 'The user did not allow this upload.' && !d.calls.some(c => c.tool === 'upload_part'), denied);
    const g = fakeAddon('allow');
    const out = await pick(g, path.join(granted, 'hello.txt'));
    const first = g.calls[0];
    ok('the card call carries the name, the type and the size', first.tool === 'upload_attach' && first.args.ask === true
      && first.args.name === 'hello.txt' && first.args.type === 'text/plain' && first.args.size === 11, JSON.stringify(first && first.args));
    const parts = g.calls.filter(c => c.tool === 'upload_part');
    ok('the bytes go as base64, in order, in the parts', parts.map(c => c.args.data).join('') === Buffer.from('hello world').toString('base64'));
    const last = g.calls[g.calls.length - 1];
    ok('the attach step comes last and the result names the file', last.tool === 'upload_attach' && last.args.attach === true && /hello\.txt/.test(out), out);
    const m = fakeAddon('allow');
    await pick(m, twoMb);
    const sizes = m.calls.map(c => JSON.stringify(c.args).length);
    ok('every message to the add-on is under 1 MB, and a 2.5 MB file takes more than one part',
      sizes.every(n => n < MB) && m.calls.filter(c => c.tool === 'upload_part').length > 1, String(Math.max(...sizes)));
    ok('the parts join back to the file', m.calls.filter(c => c.tool === 'upload_part').map(c => c.args.data).join('') === fs.readFileSync(twoMb).toString('base64'));
    ok('the upload limit is 25 MB', MAX_UPLOAD_BYTES === 25 * MB);
  } catch (e) {
    ok('the smoke run did not crash', false, String(e.message || e).split('\n')[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
