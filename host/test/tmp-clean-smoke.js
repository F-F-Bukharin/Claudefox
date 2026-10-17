'use strict';
// No test here leaves temp folders or files behind. Each test runs in its own child process, one after another, with TMPDIR
// set to a fresh empty folder, and that folder is empty again when the test is over, whether the test passes, fails, throws
// or is stopped. A test that SKIPs on this platform counts as clean. POSIX only, like chat-smoke.
//   node host/test/tmp-clean-smoke.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  tmp-clean-smoke runs on Linux/macOS only, like chat-smoke'); process.exit(0); }

const root = path.join(__dirname, '..', '..');
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

// The tests after chat-smoke.js, each checked the same way.
const TESTS = [
  'host/test/smoke.js', 'host/test/mcp-smoke.js', 'host/test/session-smoke.js', 'host/test/output-smoke.js',
  'host/test/usage-smoke.js', 'host/test/effort-smoke.js', 'host/test/scheduled-smoke.js', 'host/test/watch-smoke.js',
  'test/injection-live.js', 'test/harden-turns.js',
];

// Runs one test file with TMPDIR set to a fresh empty folder. Returns the run, what is left in that folder and the seconds.
function runWithFreshTmp(file, extraEnv) {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-tmpclean-'));   // this run's own folder, removed at the end
  try {
    const t0 = Date.now();
    const run = spawnSync(process.execPath, [path.join(root, file)], { env: { ...process.env, ...extraEnv, TMPDIR: fresh }, encoding: 'utf8', timeout: 150000 });
    const secs = Math.round((Date.now() - t0) / 1000);
    const left = fs.existsSync(fresh) ? fs.readdirSync(fresh) : ['(the folder itself was removed)'];
    return { run, left, secs };
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
}
const howItEnded = r => (r.run.status !== null ? `exit ${r.run.status}` : `stopped by ${r.run.signal || 'the timeout'}`);

// injection-live.js looks for the real Claude Code (on PATH too) and would run it, so it gets a stub instead: one that reads
// its input to the end (the test writes its prompt there) and exits with an error at once.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-tmpclean-stub-'));   // removed at the end
try {
  const stub = path.join(stubDir, 'claude');
  fs.writeFileSync(stub, '#!/bin/sh\ncat > /dev/null\nexit 1\n', { mode: 0o755 });

  const chat = runWithFreshTmp('host/test/chat-smoke.js', {});
  // An empty folder also comes out of a run that never got going, so the check also needs chat-smoke's own last line.
  check('chat-smoke ran to its end', chat.run.status !== null && /checks passed|check\(s\) failed/.test(chat.run.stdout || ''), howItEnded(chat));
  check('chat-smoke leaves its TMPDIR folder empty', chat.left.length === 0, chat.left.join(', '));

  for (const file of TESTS) {
    const r = runWithFreshTmp(file, file === 'test/injection-live.js' ? { CLAUDEFOX_CLAUDE: stub } : {});
    check(`${file} runs to its end`, r.run.status !== null, `${howItEnded(r)}, ${r.secs} s`);
    check(`${file} leaves its TMPDIR folder empty`, r.left.length === 0, r.left.join(', '));
  }
} finally {
  fs.rmSync(stubDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(passed === results.length ? `\nAll ${results.length} checks passed` : `\n${results.length - passed} check(s) failed`);
process.exit(passed === results.length ? 0 : 1);
