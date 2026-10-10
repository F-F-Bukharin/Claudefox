'use strict';
// Improve Claude in Zen, helper side: the diff, the checks, the copy, the proposal, Apply and Discard. Uses temp
// folders only (the copies go under a temp LOCALAPPDATA); no Claude Code and no Zen are needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-self-'));
process.env.LOCALAPPDATA = path.join(tmp, 'local');   // paths.js reads this when it loads
const S = require('../lib/selfimprove');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? `  (${detail})` : ''}`);
};

// A small add-on: the folders the copy holds, and a test runner that passes or fails.
function fakeAddon(dir, runnerExit) {
  const files = {
    'extension/panel.js': 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n',
    'extension/lib/tools.js': 'module.exports = { x: 1 };\n',
    'extension/manifest.json': '{ "version": "0.9.0" }\n',
    'extension/lib/policy.js': 'module.exports = {};\n',
    'host/claude-in-zen-host.js': 'module.exports = 1;\n',
    'host/lib/guard.js': 'module.exports = {};\n',
    'host/lib/extra.js': 'module.exports = "extra";\n',
    'test/run-all.js': `console.log('fake tests');\nconsole.log(${runnerExit ? "'1 test file(s) failed'" : "'All test files passed'"});\nprocess.exit(${runnerExit});\n`,
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const mk = (p, status, ops, extra) => Object.assign({ path: p, status, binary: false, size: 10, added: 0, removed: 0, ops: ops || [], diff: '' }, extra || {});

(async () => {
  // Diff: rebuilds both sides exactly, on random small inputs.
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let rebuilt = true;
  for (let t = 0; t < 300 && rebuilt; t++) {
    const a = Array.from({ length: Math.floor(rnd() * 12) }, () => String(Math.floor(rnd() * 4)));
    const b = Array.from({ length: Math.floor(rnd() * 12) }, () => String(Math.floor(rnd() * 4)));
    const ops = S.lineDiff(a, b);
    rebuilt = ops.filter(o => o[0] !== '+').map(o => o[1]).join('|') === a.join('|')
      && ops.filter(o => o[0] !== '-').map(o => o[1]).join('|') === b.join('|');
  }
  check('the line diff rebuilds both sides on 300 random pairs', rebuilt);
  const one = S.lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
  check('a changed middle line is one removal and one addition', one.filter(o => o[0] === '-').length === 1 && one.filter(o => o[0] === '+').length === 1 && one.filter(o => o[0] === ' ').length === 2);
  const u = S.unified('extension/new.js', 'added', S.lineDiff([], ['one', 'two']));
  check('an added file diffs against /dev/null with the right hunk header', u.startsWith('--- /dev/null\n+++ b/extension/new.js') && u.includes('@@ -0,0 +1,2 @@') && u.includes('+one'), u);

  // Checks: what may and may not be applied.
  check('a normal edit in extension/ passes the checks', S.checkChanges([mk('extension/panel.js', 'modified', [['+', 'const c = 3;']])]).length === 0);
  check('protected files are refused', S.checkChanges([mk('host/lib/guard.js', 'modified')]).some(p => /protected/.test(p))
    && S.checkChanges([mk('test/run-all.js', 'modified')]).some(p => /protected/.test(p))
    && S.checkChanges([mk('extension/manifest.json', 'modified')]).some(p => /protected/.test(p))
    && S.checkChanges([mk('host/test/smoke.js', 'modified')]).some(p => /protected/.test(p)));
  check('files outside extension/ and host/ are refused', S.checkChanges([mk('tools/menu.ps1', 'added')]).some(p => /outside/.test(p)));
  check('deleting a file is refused', S.checkChanges([mk('extension/lib/tools.js', 'removed', [['-', 'x']])]).some(p => /removes a file/.test(p)));
  check('adding cookie access is refused', S.checkChanges([mk('extension/lib/tools.js', 'modified', [['+', 'const c = await browser.cookies.getAll({});']])]).some(p => /cookie/.test(p)));
  check('reading document.cookie is refused too', S.checkChanges([mk('extension/panel.js', 'modified', [['+', 'const c = document.cookie;']])]).some(p => /cookie/.test(p)));
  check('adding a key or secret is refused', S.checkChanges([mk('host/lib/extra.js', 'modified', [['+', 'const k = "sk-ant-api03-abcdefgh";']])]).some(p => /key or secret/.test(p)));
  check('binary files are refused', S.checkChanges([mk('extension/icons/a.png', 'added', [], { binary: true })]).some(p => /binary/.test(p)));

  // The copy, the proposal and Apply.
  const rootOk = fakeAddon(path.join(tmp, 'addon-ok'), 0);
  const sb = S.prepare(rootOk);
  check('the copy holds the add-on in base and work', fs.existsSync(path.join(sb.work, 'extension/panel.js')) && fs.existsSync(path.join(sb.base, 'host/lib/guard.js')));
  fs.writeFileSync(path.join(sb.work, 'extension/panel.js'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b, "hi");\n');
  fs.writeFileSync(path.join(sb.work, 'host/lib/new-helper.js'), 'module.exports = 42;\n');
  const p = await S.propose(sb);
  check('the change lists the edited and the new file', p.changed === 2 && p.files.some(f => f.path === 'extension/panel.js' && f.status === 'modified') && p.files.some(f => f.path === 'host/lib/new-helper.js' && f.status === 'added'), JSON.stringify(p.files));
  check('the tests run on the copy and pass, so the change can be applied', !!p.tests && p.tests.ok && p.canApply === true, JSON.stringify(p.tests));
  check('the whole diff is kept in changes.diff', fs.readFileSync(p.diffFile, 'utf8').includes('--- a/extension/panel.js'));
  check('the real add-on is untouched before Apply', fs.readFileSync(path.join(rootOk, 'extension/panel.js'), 'utf8').includes('console.log(a + b);'));
  const applied = S.apply(sb.id, rootOk);
  check('Apply writes the change into the add-on', applied.ok && fs.readFileSync(path.join(rootOk, 'extension/panel.js'), 'utf8').includes('"hi"') && fs.existsSync(path.join(rootOk, 'host/lib/new-helper.js')), applied.text);
  check('Apply says to reload, and that helper changes need Zen restarted', /Reload/.test(applied.text) && /restarted/.test(applied.text), applied.text);
  check('after Apply the proposal and its copy are gone', !S.proposals.has(sb.id) && !fs.existsSync(sb.dir));
  check('applying the same change twice does nothing', !S.apply(sb.id, rootOk).ok);

  // A file that changed after the copy was made: nothing is written.
  const sb2 = S.prepare(rootOk);
  fs.writeFileSync(path.join(sb2.work, 'extension/lib/tools.js'), 'module.exports = { x: 2 };\n');
  await S.propose(sb2);
  fs.writeFileSync(path.join(rootOk, 'extension/lib/tools.js'), 'module.exports = { x: 9 };\n');
  const conflict = S.apply(sb2.id, rootOk);
  check('Apply refuses when a file changed since the copy, and writes nothing', !conflict.ok && /changed since/.test(conflict.text) && fs.readFileSync(path.join(rootOk, 'extension/lib/tools.js'), 'utf8') === 'module.exports = { x: 9 };\n', conflict.text);
  S.discard(sb2.id);
  check('Discard removes the copy', !fs.existsSync(sb2.dir));

  // A change that fails the tests cannot be applied.
  const rootBad = fakeAddon(path.join(tmp, 'addon-bad'), 1);
  const sb3 = S.prepare(rootBad);
  fs.writeFileSync(path.join(sb3.work, 'extension/lib/tools.js'), 'module.exports = { x: 3 };\n');
  const p3 = await S.propose(sb3);
  check('a change that fails the tests cannot be applied', !!p3.tests && !p3.tests.ok && p3.canApply === false && !S.apply(sb3.id, rootBad).ok, JSON.stringify(p3.tests));
  S.discard(sb3.id);

  // A protected edit is blocked before any test runs, and Discard leaves the add-on as it was.
  const sb4 = S.prepare(rootOk);
  fs.writeFileSync(path.join(sb4.work, 'host/lib/guard.js'), 'module.exports = { hacked: true };\n');
  const p4 = await S.propose(sb4);
  check('a protected edit is blocked before the tests run', p4.tests === null && p4.canApply === false && p4.blocked.some(b => /protected/.test(b)));
  S.discard(sb4.id);
  check('Discard leaves the protected file as it was', fs.readFileSync(path.join(rootOk, 'host/lib/guard.js'), 'utf8') === 'module.exports = {};\n');

  // The run's flags.
  const sb5 = S.prepare(rootOk);
  const a = S.args(sb5, { model: 'claude-opus-5-5', effort: 'max' }, { enabledPlugins: { 'vidiq@test': true } });
  const val = f => a[a.indexOf(f) + 1];
  check('an improve run uses Opus 5.5 at max effort', val('--model') === 'claude-opus-5-5' && val('--effort') === 'max', a.join(' '));
  check('an improve run has the five file tools only: no shell, no web, no browser tools', val('--tools') === 'Read,Glob,Grep,Edit,Write' && val('--allowedTools') === 'Read,Glob,Grep,Edit,Write' && a.includes('--strict-mcp-config') && !a.join(' ').includes('Bash') && !a.join(' ').includes('WebSearch'));
  check('plugins are forced off for the run', JSON.parse(fs.readFileSync(val('--settings'), 'utf8')).enabledPlugins['vidiq@test'] === false);
  check('the system prompt names the copy and the off-limits files', val('--append-system-prompt').includes(sb5.work) && val('--append-system-prompt').includes('host/lib/guard.js'));
  S.discard(sb5.id);
  check('an empty request asks for one change; a typed one is passed on', /pick the one change/.test(S.request('')) && S.request('make the panel nicer').includes('make the panel nicer'));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e && e.stack ? e.stack : e); process.exit(1); });
