'use strict';
// Runs every test and prints one summary line each.   node test/run-all.js
// The two DOM tests need jsdom (npm i --no-save jsdom) and skip without it; chat-smoke skips on Windows.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const TESTS = [
  'host/test/smoke.js', 'host/test/mcp-smoke.js', 'host/test/chat-smoke.js', 'host/test/session-smoke.js', 'host/test/selfimprove-smoke.js', 'host/test/mods-smoke.js', 'host/test/output-smoke.js', 'host/test/army-smoke.js', 'host/test/local-smoke.js',
  'test/addon-smoke.js', 'test/watch-startup.js', 'test/army-addon.js', 'test/local-addon.js', 'test/dom-page-tools.js', 'test/dom-panel.js', 'test/dom-fillform.js', 'test/dom-mods.js', 'test/dom-watch.js', 'test/dom-bar.js', 'test/dom-sites.js', 'test/docx.js',
  'test/dom-accounts.js',
  'test/dom-menus.js',
  'test/dom-usage.js',
  'test/dom-a11y.js',
  'test/dom-classify.js',
  'test/dom-query.js',
  'test/dom-inject.js',
  'test/dom-render.js', 'test/dom-history.js', 'test/dom-windows.js',
  'test/menu-static.js', 'test/wall-ink.js', 'test/brand.js', 'test/shared-code.js', 'test/injection-page.js', 'test/hardening.js', 'test/harden-confirm.js', 'test/harden-turns.js', 'test/harden-native.js',
  'test/watch-static.js', 'test/site-gate.js', 'test/site-wiring.js', 'host/test/watch-engine-smoke.js', 'host/test/watch-smoke.js',
  'host/test/scope-smoke.js',
  'host/test/trusted-smoke.js',
  'host/test/usage-smoke.js',
  'host/test/effort-smoke.js',
  'host/test/download-smoke.js',
  'host/test/downloadgate-smoke.js', 'test/dom-download.js',
  'test/dom-macros.js', 'test/dom-tabs.js',
  'host/test/scheduled-smoke.js',
  'test/dom-upload.js', 'host/test/upload-smoke.js',
  'test/i18n.js', 'host/test/confirm-lang-smoke.js', 'test/i18n-bg.js', 'test/i18n-stream.js',
  'test/i18n-chat.js',
];
// A test that cannot run here (no jsdom, or a POSIX-only test on Windows) prints SKIP and exits 0: it counts as
// skipped, never as passed.
let failed = 0, skipped = 0;
for (const t of TESTS) {
  const r = spawnSync(process.execPath, [path.join(root, t)], { encoding: 'utf8', timeout: 120000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n');
  const lines = out.filter(l => l.trim());
  const last = lines[lines.length - 1] || '(no output)';
  const ok = r.status === 0;
  const skip = ok && /^SKIP\b/.test(lines[0] || '');
  if (!ok) failed++;
  if (skip) skipped++;
  console.log(`${!ok ? 'FAIL' : skip ? 'skip' : 'ok  '}  ${t.padEnd(26)} ${last.trim()}`);
  if (!ok) console.log(out.filter(l => /FAIL/.test(l)).map(l => '        ' + l).join('\n'));
}
const ran = TESTS.length - skipped - failed;
console.log(failed ? `\n${failed} test file(s) failed` : `\n${ran} test file(s) passed${skipped ? `, ${skipped} skipped (they did not run here)` : ''}`);
process.exit(failed ? 1 : 0);
