'use strict';
// Watch tool helper checks, one section per task of the watch-tool plan. So far: args (Task 3).   node host/test/watch-smoke.js
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
console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
process.exit(failed ? 1 : 0);
