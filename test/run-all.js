'use strict';
// Runs every test and prints one summary line each.   node test/run-all.js
// The two DOM tests need jsdom (npm i --no-save jsdom) and skip without it; chat-smoke skips on Windows.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const TESTS = [
  'host/test/smoke.js', 'host/test/mcp-smoke.js', 'host/test/chat-smoke.js', 'host/test/selfimprove-smoke.js', 'host/test/mods-smoke.js', 'host/test/output-smoke.js',
  'test/addon-smoke.js', 'test/dom-page-tools.js', 'test/dom-panel.js', 'test/dom-mods.js', 'test/docx.js',
  'test/menu-static.js', 'test/wall-ink.js',
];
let failed = 0;
for (const t of TESTS) {
  const r = spawnSync(process.execPath, [path.join(root, t)], { encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const last = out.filter(l => l.trim()).pop() || '(no output)';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${t.padEnd(26)} ${last.trim()}`);
  if (!ok) console.log(out.filter(l => /FAIL/.test(l)).map(l => '        ' + l).join('\n'));
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nAll test files passed');
process.exit(failed ? 1 : 0);
