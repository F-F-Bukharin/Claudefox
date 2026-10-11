'use strict';
// Watch tool helper checks, one section per task of the watch-tool plan: args and python (Tasks 3, 4), run (Task 5).   node host/test/watch-smoke.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
const deepEqual = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };

const { checkSource, checkQuestion, checkTime, buildArgv, buildEnv } = require('../lib/watchvideo');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-watch-'));
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
  const env = buildEnv({ PATH: '/bin', HOME: '/h', GEMINI_API_KEY: 'k', WATCH_ENGINE: 'gemini', MY_API_KEY: 'y', PYTHONPATH: '/p', CLAUDE_IN_ZEN_ARMY_TOKEN: 't' });
  check('the child gets PATH, HOME and UTF-8 only: no keys, no WATCH_ settings, no PYTHONPATH',
    env.PATH === '/bin' && env.PYTHONUTF8 === '1' && !('GEMINI_API_KEY' in env) && !('WATCH_ENGINE' in env)
    && !('MY_API_KEY' in env) && !('PYTHONPATH' in env) && !('CLAUDE_IN_ZEN_ARMY_TOKEN' in env));
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
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-run-'));
  try {
    const runs = createWatchRuns({ killTree });
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

pythonSection().then(runSection).then(() => {
  console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
});
