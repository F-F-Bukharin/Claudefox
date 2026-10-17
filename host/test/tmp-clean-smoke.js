'use strict';
// chat-smoke leaves no temp folders: it runs in a child process with TMPDIR set to a fresh empty folder, and that folder is
// empty again when the run is over, whether chat-smoke passes or not. chat-smoke is POSIX only, so this skips on Windows too.
//   node host/test/tmp-clean-smoke.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  tmp-clean-smoke runs on Linux/macOS only, like chat-smoke'); process.exit(0); }

const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-tmpclean-'));   // this test's own temp folder, removed at the end
let run, left = [];
try {
  run = spawnSync(process.execPath, [path.join(__dirname, 'chat-smoke.js')], { env: { ...process.env, TMPDIR: fresh }, encoding: 'utf8', timeout: 110000 });
  left = fs.readdirSync(fresh);
} finally {
  fs.rmSync(fresh, { recursive: true, force: true });
}
// An empty folder also comes out of a run that never got going, so the check also needs chat-smoke's own last line.
check('chat-smoke ran to its end', run.status !== null && /checks passed|check\(s\) failed/.test(run.stdout || ''), `exit ${run.status}`);
check('chat-smoke leaves its TMPDIR folder empty', left.length === 0, left.join(', '));

const passed = results.filter(Boolean).length;
console.log(passed === results.length ? `\nAll ${results.length} checks passed` : `\n${results.length - passed} check(s) failed`);
process.exit(passed === results.length ? 0 : 1);
