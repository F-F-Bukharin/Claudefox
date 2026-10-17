'use strict';
// Watch tool helper checks, one section per task of the watch-tool plan: args and python (Tasks 3, 4), run (Task 5), result (Task 6), gate and handler (Task 7), surface (Task 8).   node host/test/watch-smoke.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// The temp folders this test makes are removed however it ends (passing, failed checks, an exception or an early exit), and
// the processes it starts (watch runs, the tool server) are stopped first, so nothing writes into the folders meanwhile.
const madeDirs = [], procs = [], stops = [];
process.on('exit', () => {
  for (const stop of stops.splice(0)) { try { stop(); } catch {} }
  for (const c of procs.splice(0)) { try { c.kill('SIGKILL'); } catch {} }
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));   // Ctrl-C or a kill cleans up too
const makeDir = prefix => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); madeDirs.push(d); return d; };
// The data folder goes to a temp folder before any helper module loads (paths are read at require time): a watch run
// is listed in children.json, which must never land in the real data folder.
process.env.LOCALAPPDATA = makeDir('cfx-watch-data-');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
const deepEqual = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };

const { checkSource, checkQuestion, checkTime, buildArgv, buildEnv } = require('../lib/watchvideo');

const tmp = makeDir('cfx-watch-');
try {
  // section args
  const videoFile = path.join(tmp, 'clip.mp4');
  fs.writeFileSync(videoFile, Buffer.alloc(1024));
  check('argument list is fixed, the question uses the = form and the source comes after --', deepEqual(
    buildArgv({ script: '/x/watch.py', source: 'https://example.com/v', question: '-what is it?', start: '1:30', end: null, runDir: '/r' }),
    ['/x/watch.py', '--detail', 'efficient', '--max-frames', '24', '--resolution', '512', '--no-whisper',
      '--out-dir', '/r', '--question=-what is it?', '--start', '1:30', '--', 'https://example.com/v']));
  check('a dash-prefixed source is refused', checkSource('-rf', () => '').ok === false);
  check('an https URL is accepted as a URL', checkSource('https://example.com/v?x=1', () => '').kind === 'url');
  check('a URL over 2048 characters is refused', checkSource('https://' + 'a'.repeat(2050), () => '').ok === false);
  check('a file outside the allowed folders is refused with the Local folders hint', /Local folders/.test(checkSource(videoFile, () => '').error));
  check('a video inside an allowed folder is accepted', checkSource(videoFile, real => path.dirname(real)).kind === 'file');
  check('a question over 500 characters is refused', checkQuestion('x'.repeat(501)).ok === false);
  check('a time with a dash is refused', checkTime('-5') === null && checkTime('1:30') === '1:30');
  const env = buildEnv({ PATH: '/bin', HOME: '/h', GEMINI_API_KEY: 'k', WATCH_ENGINE: 'gemini', MY_API_KEY: 'y', PYTHONPATH: '/p', CLAUDEFOX_ARMY_TOKEN: 't' });
  check('the child gets PATH, HOME and UTF-8 only: no keys, no WATCH_ settings, no PYTHONPATH',
    env.PATH === '/bin' && env.PYTHONUTF8 === '1' && !('GEMINI_API_KEY' in env) && !('WATCH_ENGINE' in env)
    && !('MY_API_KEY' in env) && !('PYTHONPATH' in env) && !('CLAUDEFOX_ARMY_TOKEN' in env));
  check('no argument can carry a cookie option', !buildArgv({ script: 's', source: 'https://a.b', runDir: '/r' }).some(a => /cookie/i.test(a)));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// section python
async function pythonSection() {
  const { findPython } = require('../lib/watchvideo');
  const fakeProbe = table => async exe => table[exe] || { code: 9009, stdout: '' };
  check('py -3 is chosen when it reports 3.12', deepEqual(await findPython(fakeProbe({ py: { code: 0, stdout: '3.12\n' } })), { exe: 'py', args: ['-3'] }));
  check('a 3.9 python is skipped for a 3.10 python3', deepEqual(await findPython(fakeProbe({ python: { code: 0, stdout: '3.9' }, python3: { code: 0, stdout: '3.10' } })), { exe: 'python3', args: [] }));
  check('the Windows Store stub (exit 0, no version) is skipped', (await findPython(fakeProbe({ python: { code: 0, stdout: '' } }))).error !== undefined);
  check('nothing installed gives one plain message', /Python 3\.10 or newer was not found/.test((await findPython(fakeProbe({}))).error));
}

// section run (Task 5): child process lifecycle
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return false;
}
async function goneWithin(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let gone = false;
    try { process.kill(pid, 0); } catch (e) { gone = e.code === 'ESRCH'; }
    // A killed child can stay a zombie until its parent reaps it; a zombie has exited.
    if (!gone && fs.existsSync(`/proc/${pid}/stat`)) gone = /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (gone) return true;
    await sleep(50);
  }
  return false;
}
async function runSection() {
  const { createWatchRuns, makeRunDir, removeRunDir } = require('../lib/watchrun');
  const { killTree } = require('../lib/army');
  const t = makeDir('cfx-run-');
  try {
    const runs = createWatchRuns({ killTree });
    stops.push(() => runs.stopAll(true));
    const node = code => ({ exe: process.execPath, args: ['-e', code], cwd: t, env: process.env });
    check('the deadline ends a run and marks it timed out', (await runs.run({ ...node('setInterval(() => {}, 1000)'), deadlineMs: 300 })).timedOut === true);
    // The child starts a grandchild, records its pid, then waits. Stop must take both.
    const pidFile = path.join(t, 'pid.txt');
    const tree = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.env.PIDFILE,String(c.pid));setInterval(()=>{},1000)";
    const pending = runs.run({ exe: process.execPath, args: ['-e', tree], cwd: t, env: { ...process.env, PIDFILE: pidFile }, deadlineMs: 20000 });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0);
    runs.stopAll(true);
    const result = await pending;
    check('Stop marks the run stopped', result.stopped === true);
    check('the grandchild is gone too', await goneWithin(Number(fs.readFileSync(pidFile, 'utf8')), 3000));
    const dir = makeRunDir(path.join(t, 'watch'));
    check('a run folder is created under the base folder', fs.existsSync(dir) && path.basename(dir).startsWith('run-'));
    removeRunDir(dir);
    check('a run folder is removed, and removing a missing one does not throw', !fs.existsSync(dir) && (removeRunDir(dir), true));
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// section result (Task 6): report assembly
async function resultSection() {
  const { assembleResult } = require('../lib/watchvideo');
  const t = makeDir('cfx-result-');
  try {
    const work = path.join(t, 'run-1', 'watch-x', 'frames');
    fs.mkdirSync(work, { recursive: true });
    const lines = [];
    for (let i = 1; i <= 26; i++) {
      const name = `frame_${String(i).padStart(4, '0')}.jpg`;
      if (i !== 3) fs.writeFileSync(path.join(work, name), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      lines.push(`- \`${path.join(work, name)}\` (t=00:${String(i).padStart(2, '0')}, reason=keyframe)`);
    }
    const report = ['# watch: video report', '', '## Frames', '', ...lines, '', '## Transcript', '', '_No transcript._'].join('\n');
    const read = p => (fs.existsSync(p) ? fs.readFileSync(p) : null);
    const runDir = path.join(t, 'run-1');
    const r = assembleResult({ stdout: report, stderr: '', code: 0, runDir, readFile: read });
    check('frames come back as JPEG images, at most 24, and the missing one is counted', r.frames.length === 23 && r.frames[0].mimeType === 'image/jpeg'
      && /could not be read/.test(r.text) && /beyond 24/.test(r.text));
    const outside = assembleResult({ stdout: '## Frames\n- `/etc/passwd` (t=00:00, reason=x)', stderr: '', code: 0, runDir, readFile: read });
    check('a path outside the run folder is never read', outside.frames.length === 0);
    const big = assembleResult({ stdout: 'a'.repeat(70 * 1024), stderr: '', code: 0, runDir, readFile: read });
    check('a report over 60 KB is cut and says so', Buffer.byteLength(big.text) <= 60 * 1024 + 60 && /cut at 60 KB/.test(big.text));
    const failed = assembleResult({ stdout: '', stderr: 'boom', code: 3, runDir, readFile: read });
    check('a failed run says so and returns no frames', failed.text.startsWith('watch failed (exit code 3)') && failed.frames.length === 0);
    const notJpeg = assembleResult({ stdout: '## Frames\n- `' + path.join(work, 'frame_0001.jpg') + '` (t=00:01, reason=x)', stderr: '', code: 0, runDir, readFile: () => Buffer.from('PNG') });
    check('a file that does not start with FF D8 FF is not returned as a frame', notJpeg.frames.length === 0);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// section gate (Task 7): the permission card. A fake clock drives the cooldown; the waits are short real timers.
async function gateSection() {
  const { createWatchGate, DENIED, NO_PANEL, BUSY } = require('../lib/watchgate');
  check('gate: the three texts are the spec\'s', DENIED === 'The user said no to watching videos for now.'
    && NO_PANEL === 'Open the Claude panel to answer whether Claude may watch videos.'
    && BUSY === 'The user is already answering a question about watching videos. Wait for that answer.');
  const rigFor = (over = {}) => {
    const rig = { t: 0, shows: [], hides: [], enabled: [], windows: 0, window: async () => true };
    rig.gate = createWatchGate({
      showCard: (id, source) => rig.shows.push({ id, source }),
      hideCard: id => rig.hides.push(id),
      confirmWindow: () => { rig.windows++; return rig.window(); },
      setEnabled: on => rig.enabled.push(on),
      now: () => rig.t, cardTimeoutMs: 80, panelWaitMs: 40, cooldownMs: 1000, ...over,
    });
    return rig;
  };
  const lastId = rig => rig.shows[rig.shows.length - 1].id;

  // Allow, then Yes in the window: watching goes on once, and the card showed the source once
  {
    const r = rigFor();
    const p = r.gate.ask('clip.mp4');
    r.gate.shown(lastId(r)); r.gate.answer(lastId(r), true);
    const res = await p;
    check('gate: Allow then Yes resolves ok', deepEqual(res, { ok: true }));
    check('gate: Yes switches watching on once', deepEqual(r.enabled, [true]));
    check('gate: the card showed the source once', r.shows.length === 1 && r.shows[0].source === 'clip.mp4');
  }
  // Deny: DENIED, then the 60-second wait (no card), then a card again
  {
    const r = rigFor();
    const p = r.gate.ask('a.mp4');
    r.gate.shown(lastId(r)); r.gate.answer(lastId(r), false);
    check('gate: Deny resolves DENIED', (await p).message === DENIED);
    check('gate: a second ask in the wait returns DENIED at once', (await r.gate.ask('a.mp4')).message === DENIED);
    check('gate: no card is posted during the wait', r.shows.length === 1);
    r.t += 1001;
    const p2 = r.gate.ask('a.mp4');
    check('gate: after the wait a card posts again', r.shows.length === 2);
    r.gate.cancel(); await p2;
  }
  // No panel: NO_PANEL, the card is hidden, and no wait starts
  {
    const r = rigFor();
    const res = await r.gate.ask('b.mp4');
    check('gate: no panel gives NO_PANEL and hides the card', res.message === NO_PANEL && r.hides.length === 1 && r.hides[0] === r.shows[0].id);
    const p = r.gate.ask('b.mp4');
    check('gate: NO_PANEL starts no wait: the next card posts at once', r.shows.length === 2);
    r.gate.cancel(); await p;
  }
  // No answer within the card wait counts as No, and that No starts the wait
  {
    const r = rigFor();
    const p = r.gate.ask('c.mp4');
    r.gate.shown(lastId(r));
    check('gate: no answer within the card wait counts as No', (await p).message === DENIED);
    check('gate: that No starts the wait', (await r.gate.ask('c.mp4')).message === DENIED && r.shows.length === 1);
  }
  // Allow, then No in the window: DENIED, nothing switched on, the wait starts
  {
    const r = rigFor();
    r.window = async () => false;
    const p = r.gate.ask('d.mp4');
    r.gate.shown(lastId(r)); r.gate.answer(lastId(r), true);
    check('gate: Allow then No in the window is DENIED', (await p).message === DENIED);
    check('gate: that No switches nothing on', r.enabled.length === 0);
    check('gate: that No starts the wait', (await r.gate.ask('d.mp4')).message === DENIED && r.shows.length === 1);
  }
  // cancel while the card waits: DENIED, hidden, no wait
  {
    const r = rigFor();
    const p = r.gate.ask('e.mp4');
    const id = lastId(r);
    r.gate.shown(id); r.gate.cancel();
    check('gate: cancel while the card waits resolves DENIED', (await p).message === DENIED);
    check('gate: cancel hides the card', r.hides.includes(id));
    const p2 = r.gate.ask('e.mp4');
    check('gate: cancel starts no wait: the next card posts at once', r.shows.length === 2);
    r.gate.cancel(); await p2;
  }
  // cancel while the window is open: a later Yes is ignored
  {
    const r = rigFor();
    let resolveWindow;
    r.window = () => new Promise(resolve => { resolveWindow = resolve; });
    const p = r.gate.ask('f.mp4');
    r.gate.shown(lastId(r)); r.gate.answer(lastId(r), true);
    r.gate.cancel();
    resolveWindow(true);
    const res = await p;
    check('gate: a Yes after cancel is ignored: DENIED, and nothing switched on', res.ok === false && res.message === DENIED && r.enabled.length === 0);
  }
  // a second ask while a card is open is BUSY and posts nothing
  {
    const r = rigFor();
    const p = r.gate.ask('g.mp4');
    check('gate: a second ask while a card is open is BUSY', (await r.gate.ask('g.mp4')).message === BUSY && r.shows.length === 1);
    r.gate.cancel(); await p;
  }
  // answers for an id that is not the open card are ignored: the card waits, then times out as No
  {
    const r = rigFor();
    const p = r.gate.ask('h.mp4');
    const id = lastId(r);
    r.gate.shown('998'); r.gate.shown(id); r.gate.answer('999', true);
    const res = await p;
    check('gate: a stale id is ignored and the card times out as No', res.message === DENIED && r.windows === 0 && r.enabled.length === 0);
  }
}

// section handler (Task 7): the permission step in watchVideo; a stub script stands in for watch.py and writes one frame
async function handlerSection() {
  const { watchVideo } = require('../lib/watchvideo');
  const { createWatchRuns } = require('../lib/watchrun');
  const { killTree } = require('../lib/army');
  const { DENIED } = require('../lib/watchgate');
  const t = makeDir('cfx-handler-');
  try {
    const stub = path.join(t, 'stub-watch.js');
    fs.writeFileSync(stub, [
      "const fs = require('fs'), path = require('path');",
      "const a = process.argv.slice(2), out = a[a.indexOf('--out-dir') + 1];",
      "const dir = path.join(out, 'watch-x', 'frames');",
      "fs.mkdirSync(dir, { recursive: true });",
      "const f = path.join(dir, 'frame_0001.jpg');",
      "fs.writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));",
      "process.stdout.write('## Frames\\n- `' + f + '` (t=00:01, reason=x)\\n');",
    ].join('\n'));
    const base = path.join(t, 'watch');
    const runs = createWatchRuns({ killTree });
    stops.push(() => runs.stopAll(true));
    const pyOk = async () => ({ exe: process.execPath, args: [] });
    const deps = (over = {}) => ({ enabled: false, permission: { ask: async () => ({ ok: true }) }, folderOf: () => '', baseDir: base,
      scriptPath: stub, getPython: pyOk, runs, deadlineMs: 20000, ...over });
    const URL_SRC = 'https://example.com/clip';
    let asks = 0;
    const counting = v => ({ ask: async () => { asks++; return v; } });

    // with watching on, nothing is asked; the frame comes back and the run folder is removed
    const r1 = await watchVideo({ source: URL_SRC }, deps({ enabled: true, permission: counting({ ok: true }) }));
    check('handler: with watching on, the frame comes back and nothing is asked', r1.frames.length === 1 && r1.frames[0].mimeType === 'image/jpeg' && asks === 0);
    check('handler: the run folder is removed afterwards', fs.readdirSync(base).length === 0);

    // with watching off, an allowed question runs the video
    const r2 = await watchVideo({ source: URL_SRC }, deps({ permission: counting({ ok: true }) }));
    check('handler: with watching off and Allow, the video runs once', asks === 1 && r2.frames.length === 1);

    // a No throws the user's text and runs nothing
    let runCalls = 0;
    const countingRuns = { run: async o => { runCalls++; return runs.run(o); } };
    let threw = null;
    try { await watchVideo({ source: URL_SRC }, deps({ permission: { ask: async () => ({ ok: false, message: DENIED }) }, runs: countingRuns })); } catch (e) { threw = e; }
    check('handler: a No throws the user-said-no text and runs nothing', !!threw && threw.message === DENIED && runCalls === 0);

    // a refused source stops before the question
    asks = 0; threw = null;
    try { await watchVideo({ source: '-rf' }, deps({ permission: counting({ ok: true }) })); } catch (e) { threw = e; }
    check('handler: a dash-prefixed source is refused before any question', !!threw && /cannot start with a dash/.test(threw.message) && asks === 0);

    // a missing Python stops before the question
    asks = 0; threw = null;
    try { await watchVideo({ source: URL_SRC }, deps({ permission: counting({ ok: true }), getPython: async () => { throw new Error('Python 3.10 or newer was not found.'); } })); } catch (e) { threw = e; }
    check('handler: a missing Python stops before any question', !!threw && /Python 3\.10/.test(threw.message) && asks === 0);

    // Stop, and the deadline
    const stopped = await watchVideo({ source: URL_SRC }, deps({ enabled: true, runs: { run: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, stopped: true }) } }));
    check('handler: a stopped run says Stopped. and returns no frames', stopped.text === 'Stopped.' && stopped.frames.length === 0);
    const late = await watchVideo({ source: URL_SRC }, deps({ enabled: true, runs: { run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true, stopped: false }) } }));
    check('handler: a run past the deadline says it was stopped', late.text === 'The video took longer than 10 minutes, so it was stopped.' && late.frames.length === 0);
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// section surface (Task 8): the tool entry, untrusted wrapping, frame images, the tool server switch and the chat line.
// The tool server runs as a child process here, since its stdin and stdout carry MCP; its log goes to a temporary folder.
function listedTools(extraEnv, base) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LOCALAPPDATA: base };
    for (const k of ['CLAUDEFOX_WATCH', 'CLAUDEFOX_PANEL', 'CLAUDEFOX_ARMY_TOKEN', 'CLAUDEFOX_ARMY_LEAD']) delete env[k];
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'claudefox-mcp.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    procs.push(child);
    const timer = setTimeout(() => { child.kill(); reject(new Error('the tool server did not answer tools/list')); }, 8000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m = null;
        try { m = JSON.parse(line); } catch { continue; }
        if (m && m.id === 2) { clearTimeout(timer); child.kill(); resolve(((m.result && m.result.tools) || []).map(t => t.name)); }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
}

async function surfaceSection() {
  const { TOOLS, PAGE_CONTENT } = require('../lib/toolSchemas');
  const { WORKER_TOOLS, checkCall } = require('../lib/armyguard');
  const { chatPrompt } = require('../lib/chatargs');
  const { format } = require('../claudefox-mcp');   // loads without starting the tool server: its startup runs only as the main module
  const base = makeDir('cfx-surface-');
  try {
    const listed = env => listedTools(env, base).catch(() => []);
    const t = TOOLS.find(x => x.name === 'watch_video');
    check('watch_video is a watch-only, read-only entry with a 15-minute limit, and its content is untrusted', !!t && t.watchOnly === true && t.readOnly === true && t.timeoutMs >= 900000 && PAGE_CONTENT.has('watch_video'));
    check('army workers never get it', !WORKER_TOOLS.includes('watch_video') && checkCall({}, 'watch_video', { source: 'https://a.b' }, Date.now()).ok === false);
    const c = format('watch_video', { ok: true, result: { text: 'Report', frames: [{ mimeType: 'image/jpeg', data: 'AAAA' }] } }).content;
    check('frames come back as image blocks after the wrapped text', c.length === 2 && c[0].text.includes('<untrusted_page_content>') && c[0].text.includes('Report')
      && c[1].type === 'image' && c[1].data === 'AAAA' && c[1].mimeType === 'image/jpeg');
    check('the prompt has the watch line only when o.watch is set, and calls the content untrusted evidence', chatPrompt([], { watch: true }).includes('untrusted evidence')
      && !chatPrompt([], {}).includes('watch_video') && chatPrompt([], {}) === chatPrompt([], { watch: false }));
    const on = await listed({ CLAUDEFOX_WATCH: '1' });
    const off = await listed({});
    check('the tool server lists watch_video only while CLAUDEFOX_WATCH is 1', on.includes('watch_video') && !off.includes('watch_video'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

pythonSection().then(runSection).then(resultSection).then(gateSection).then(handlerSection).then(surfaceSection).then(() => {
  console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
});
