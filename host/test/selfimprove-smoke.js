'use strict';
// Improve Claude in Zen, helper side: the diff, the checks (a mod's files only), the copy, the proposal, Apply and
// Discard, the notes on earlier runs, and the run's flags and master prompt. Uses temp folders only (the copies and the
// notes go under a temp LOCALAPPDATA); no Claude Code and no Zen are needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-self-'));
process.env.LOCALAPPDATA = path.join(tmp, 'local');   // paths.js reads this when it loads
const S = require('../lib/selfimprove');
const G = require('../lib/guard');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? `  (${detail})` : ''}`);
};

// A small add-on: the folders the copy holds, one mod, and a test runner that passes or fails.
function fakeAddon(dir, runnerExit) {
  const files = {
    'extension/panel.js': 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n',
    'extension/lib/pageTools.js': 'module.exports = { x: 1 };\n',
    'extension/manifest.json': '{ "version": "0.9.0" }\n',
    'extension/lib/policy.js': 'module.exports = {};\n',
    'extension/mods/wider-composer/mod.json': '{ "name": "Wider composer", "description": "Gives the text bar room." }\n',
    'extension/mods/wider-composer/panel.js': 'window.widerComposer = true;\n',
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
const notMod = list => list.some(p => /not a mod file/.test(p));

// A folder of mods, for the checks that read a mod folder the way the panel will load it.
const modWork = path.join(tmp, 'mods-work');
const putFile = (rel, text) => { fs.mkdirSync(path.dirname(path.join(modWork, rel)), { recursive: true }); fs.writeFileSync(path.join(modWork, rel), text); };
putFile('extension/mods/ok-mod/panel.js', 'window.okMod = 1;\n');
putFile('extension/mods/ok-mod/mod.json', '{ "name": "OK" }\n');
putFile('extension/mods/style-only/style.css', 'body { color: red; }\n');
putFile('extension/mods/broken-json/panel.js', 'window.x = 1;\n');
putFile('extension/mods/broken-json/mod.json', '{ not json\n');
putFile('extension/mods/no-files/mod.json', '{ "name": "Nothing" }\n');
putFile('extension/mods/syntax/panel.js', 'const a = ;\n');

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

  // Only a mod's own files may change.
  check('a mod file is editable: mod.json, panel.js and style.css in extension/mods/<id>/', ['mod.json', 'panel.js', 'style.css'].every(f => S.isEditable(`extension/mods/wider-composer/${f}`)));
  check('everything else is not: core files, other names, deeper paths, bad ids, the helper, the manifest', ['extension/panel.js', 'extension/mods/wider-composer/other.js', 'extension/mods/wider-composer/sub/panel.js', 'extension/mods/Bad_Name/panel.js', 'extension/mods/a/panel.js', 'host/lib/guard.js', 'extension/manifest.json', 'extension/mods/../panel.js'].every(p => !S.isEditable(p)));
  check('a normal edit to a mod passes the checks', S.checkChanges([mk('extension/mods/wider-composer/panel.js', 'modified', [['+', 'window.widerComposer = 2;']])]).length === 0);
  check('a core file is refused, whatever the edit', notMod(S.checkChanges([mk('extension/panel.js', 'modified', [['+', 'const c = 3;']])])));
  check('the helper, the tests, the manifest and every other file are refused', ['host/lib/guard.js', 'test/run-all.js', 'extension/manifest.json', 'host/test/smoke.js', 'tools/menu.ps1'].every(p => notMod(S.checkChanges([mk(p, 'modified')]))));
  check('deleting a file is refused', S.checkChanges([mk('extension/mods/wider-composer/style.css', 'removed', [['-', 'x']])]).some(p => /removes a file/.test(p)));
  check('adding cookie access is refused', S.checkChanges([mk('extension/mods/wider-composer/panel.js', 'modified', [['+', 'const c = await browser.cookies.getAll({});']])]).some(p => /cookie/.test(p)));
  check('reading document.cookie is refused too', S.checkChanges([mk('extension/mods/wider-composer/panel.js', 'modified', [['+', 'const c = document.cookie;']])]).some(p => /cookie/.test(p)));
  check('adding a key or secret is refused', S.checkChanges([mk('extension/mods/wider-composer/panel.js', 'modified', [['+', 'const k = "sk-ant-api03-abcdefgh";']])]).some(p => /key or secret/.test(p)));
  check('binary files are refused', S.checkChanges([mk('extension/mods/wider-composer/icon.png', 'added', [], { binary: true })]).some(p => /binary/.test(p)));

  // A mod folder is checked the way the panel will load it.
  check('a valid mod passes the folder checks', S.checkChanges([mk('extension/mods/ok-mod/panel.js', 'added'), mk('extension/mods/ok-mod/mod.json', 'added')], modWork).length === 0);
  check('a style-only mod passes', S.checkChanges([mk('extension/mods/style-only/style.css', 'added')], modWork).length === 0);
  check('a mod whose mod.json does not parse is refused', S.checkChanges([mk('extension/mods/broken-json/mod.json', 'added')], modWork).some(p => /not valid JSON/.test(p)));
  check('a mod with neither panel.js nor style.css is refused', S.checkChanges([mk('extension/mods/no-files/mod.json', 'added')], modWork).some(p => /neither/.test(p)));
  check('a panel.js that does not compile is refused, with the reason', S.checkChanges([mk('extension/mods/syntax/panel.js', 'added')], modWork).some(p => /does not compile/.test(p)));

  // The copy, the proposal and Apply.
  const rootOk = fakeAddon(path.join(tmp, 'addon-ok'), 0);
  const sb = S.prepare(rootOk);
  check('the copy holds the add-on in base and work, mods included', fs.existsSync(path.join(sb.work, 'extension/panel.js')) && fs.existsSync(path.join(sb.base, 'host/lib/guard.js')) && fs.existsSync(path.join(sb.work, 'extension/mods/wider-composer/mod.json')));
  fs.writeFileSync(path.join(sb.work, 'extension/mods/wider-composer/panel.js'), 'window.widerComposer = true;\nconsole.log("wider");\n');
  fs.mkdirSync(path.join(sb.work, 'extension/mods/quiet-tip'), { recursive: true });
  fs.writeFileSync(path.join(sb.work, 'extension/mods/quiet-tip/mod.json'), '{ "name": "Quiet tip" }\n');
  fs.writeFileSync(path.join(sb.work, 'extension/mods/quiet-tip/style.css'), '.tip { opacity: .8; }\n');
  const p = await S.propose(sb);
  check('the change lists the edited mod file and the new mod folder', p.changed === 3 && p.files.some(f => f.path === 'extension/mods/wider-composer/panel.js' && f.status === 'modified') && p.files.some(f => f.path === 'extension/mods/quiet-tip/style.css' && f.status === 'added'), JSON.stringify(p.files));
  check('the tests run on the copy and pass, so the change can be applied', !!p.tests && p.tests.ok && p.canApply === true, JSON.stringify(p.tests));
  check('the whole diff is kept in changes.diff', fs.readFileSync(p.diffFile, 'utf8').includes('--- a/extension/mods/wider-composer/panel.js'));
  check('the real add-on is untouched before Apply', fs.readFileSync(path.join(rootOk, 'extension/mods/wider-composer/panel.js'), 'utf8') === 'window.widerComposer = true;\n');
  const applied = S.apply(sb.id, rootOk);
  check('Apply writes the mod changes into the add-on, the new folder included', applied.ok && fs.readFileSync(path.join(rootOk, 'extension/mods/wider-composer/panel.js'), 'utf8').includes('console.log("wider")') && fs.existsSync(path.join(rootOk, 'extension/mods/quiet-tip/style.css')), applied.text);
  check('Apply says to reload, and asks for no restart for mod changes', /Reload/.test(applied.text) && !/restart/.test(applied.text), applied.text);
  check('after Apply the proposal and its copy are gone', !S.proposals.has(sb.id) && !fs.existsSync(sb.dir));
  check('applying the same change twice does nothing', !S.apply(sb.id, rootOk).ok);

  // A mod file that changed after the copy was made: nothing is written.
  const sb2 = S.prepare(rootOk);
  fs.writeFileSync(path.join(sb2.work, 'extension/mods/wider-composer/panel.js'), 'window.widerComposer = 2;\n');
  await S.propose(sb2);
  fs.writeFileSync(path.join(rootOk, 'extension/mods/wider-composer/panel.js'), 'window.widerComposer = 9;\n');
  const conflict = S.apply(sb2.id, rootOk);
  check('Apply refuses when a file changed since the copy, and writes nothing', !conflict.ok && /changed since/.test(conflict.text) && fs.readFileSync(path.join(rootOk, 'extension/mods/wider-composer/panel.js'), 'utf8') === 'window.widerComposer = 9;\n', conflict.text);
  S.discard(sb2.id);
  check('Discard removes the copy', !fs.existsSync(sb2.dir));

  // A change that fails the tests cannot be applied.
  const rootBad = fakeAddon(path.join(tmp, 'addon-bad'), 1);
  const sb3 = S.prepare(rootBad);
  fs.writeFileSync(path.join(sb3.work, 'extension/mods/wider-composer/panel.js'), 'window.widerComposer = 3;\n');
  const p3 = await S.propose(sb3);
  check('a change that fails the tests cannot be applied', !!p3.tests && !p3.tests.ok && p3.canApply === false && !S.apply(sb3.id, rootBad).ok, JSON.stringify(p3.tests));
  S.discard(sb3.id);

  // A core edit is blocked before any test runs, and Discard leaves the add-on as it was.
  const sb4 = S.prepare(rootOk);
  fs.writeFileSync(path.join(sb4.work, 'host/lib/guard.js'), 'module.exports = { hacked: true };\n');
  const p4 = await S.propose(sb4);
  check('a core edit is blocked before the tests run', p4.tests === null && p4.canApply === false && notMod(p4.blocked));
  S.discard(sb4.id);
  check('Discard leaves the core file as it was', fs.readFileSync(path.join(rootOk, 'host/lib/guard.js'), 'utf8') === 'module.exports = {};\n');
  // node_modules is left out of a copy, so the run cannot see it; a change made in it is seen by the diff and refused.
  const rootNm = fakeAddon(path.join(tmp, 'addon-nm'), 0);
  fs.mkdirSync(path.join(rootNm, 'host', 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(rootNm, 'host', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  const sbNm = S.prepare(rootNm);
  check('the copy leaves node_modules out, in base and in work', !fs.existsSync(path.join(sbNm.base, 'host', 'node_modules')) && !fs.existsSync(path.join(sbNm.work, 'host', 'node_modules')));
  fs.mkdirSync(path.join(sbNm.work, 'host', 'node_modules', 'evil'), { recursive: true });
  fs.writeFileSync(path.join(sbNm.work, 'host', 'node_modules', 'evil', 'index.js'), 'module.exports = 2;\n');
  const pNm = await S.propose(sbNm);
  check('a change under node_modules is refused as not a mod file, and its tests do not run', pNm.blocked.some(m => /host\/node_modules\/evil\/index\.js: not a mod file/.test(m)) && pNm.tests === null && pNm.canApply === false, JSON.stringify(pNm.blocked));
  const applyNm = S.apply(sbNm.id, rootNm);
  check('Apply refuses that change, and writes nothing into node_modules', !applyNm.ok && /did not pass its checks/.test(applyNm.text) && !fs.existsSync(path.join(rootNm, 'host', 'node_modules', 'evil')), applyNm.text);
  S.discard(sbNm.id);

  // Notes on earlier runs: in memory/ under the helper folder, scrubbed, kept to the newest 50, and capped for a prompt.
  check('the notes live in memory/ under the helper folder', S.MEMORY_DIR === path.join(process.env.LOCALAPPDATA, 'claude-in-zen', 'memory'), S.MEMORY_DIR);
  const idA = 'aaaaaaaaaaaa';
  S.recordStart({ id: idA }, 'make the panel nicer');
  S.recordProposal(idA, { changed: 2, blocked: [], canApply: true, tests: { ok: true, summary: 'All test files passed' }, files: [{ path: 'extension/mods/quiet-tip/mod.json', status: 'added' }] }, 'I added a quiet tip.');
  S.recordLater(idA, 'applied: extension/mods/quiet-tip/mod.json');
  const note = S.memoryText();
  check('the next run is given what an earlier run asked, found, and what the user did', note.includes('make the panel nicer') && note.includes('ready for Apply') && note.includes('I added a quiet tip.') && note.includes('applied: extension/mods/quiet-tip/mod.json'), note.slice(0, 300));
  const idB = 'bbbbbbbbbbbb';
  S.recordStart({ id: idB }, 'change the core');
  S.recordProposal(idB, { changed: 1, blocked: ['extension/panel.js: not a mod file. A change may only touch extension/mods/<id>/.'], canApply: false, tests: null, files: [{ path: 'extension/panel.js', status: 'modified' }] }, 'Tried the core.');
  S.recordLater(idB, 'discarded');
  check('a refused change says so, and a discard is noted', S.memoryText().includes('refused by the checks') && S.memoryText().includes('Later') && S.memoryText().includes('discarded'));
  const idC = 'cccccccccccc';
  S.recordStart({ id: idC }, 'use my key');
  S.recordEnd(idC, { outcome: 'x', said: 'Here is sk-ant-api03-abcdefghijk in the reply' });
  const onDisk = S.memoryFiles().map(n => fs.readFileSync(path.join(S.MEMORY_DIR, n), 'utf8')).join('\n');
  check('a key in a note is removed before the note is written, and the next run sees [removed]', !onDisk.includes('sk-ant-api03') && S.memoryText().includes('[removed]'));
  for (let i = 1; i <= 55; i++) S.recordStart({ id: i.toString(16).padStart(12, '0') }, `run ${i}`);
  check('the notes keep the newest 50 runs', S.memoryFiles().length === 50, String(S.memoryFiles().length));
  check('the notes given to the next run are capped, and include the newest run', S.memoryText().length <= 8000 && S.memoryText().includes('Asked: run 55'));

  // The run's flags and its master prompt.
  const sb5 = S.prepare(rootOk);
  const a = S.args(sb5, { model: 'claude-opus-5-5', effort: 'max' }, { enabledPlugins: { 'vidiq@test': true } });
  const val = f => a[a.indexOf(f) + 1];
  check('an improve run uses Opus 5.5 at max effort', val('--model') === 'claude-opus-5-5' && val('--effort') === 'max', a.join(' '));
  const modRule = tool => `${tool}(/${G.posix(path.join(sb5.work, 'extension', 'mods'))}/**)`;
  check('an improve run has the five file tools only: no shell, no web, no browser tools', val('--tools') === 'Read,Glob,Grep,Edit,Write' && val('--allowedTools') === `Read,Glob,Grep,${modRule('Edit')},${modRule('Write')}` && a.includes('--strict-mcp-config') && !a.join(' ').includes('Bash') && !a.join(' ').includes('WebSearch'));
  check('an improve run asks for nothing: dontAsk, not acceptEdits, and only the user settings load', val('--permission-mode') === 'dontAsk' && !a.includes('acceptEdits') && val('--setting-sources') === 'user');
  // The copy lives in the data folder's self/, which the chat's deny rules keep unwritable; deny beats allow, so the
  // run's own rules must leave the copy's folder out, or Edit and Write on its mods are refused.
  const runDeny = JSON.parse(fs.readFileSync(val('--settings'), 'utf8')).permissions.deny;
  const selfRule = tool => `${tool}(/${G.posix(path.dirname(sb5.work))}/**)`;
  check('the run may write its own copy: its deny rules leave the copies folder out, and the chat keeps it denied',
    sb5.work.startsWith(S.SELF_DIR) && !runDeny.some(r => r === selfRule('Edit') || r === selfRule('Write') || r === `Edit(/${G.posix(S.SELF_DIR)}/**)`)
    && G.denyRules().includes(`Edit(/${G.posix(S.SELF_DIR)}/**)`) && runDeny.some(r => r.startsWith('Read(')), JSON.stringify(runDeny.filter(r => r.includes('self'))));
  check('plugins are forced off for the run', JSON.parse(fs.readFileSync(val('--settings'), 'utf8')).enabledPlugins['vidiq@test'] === false);
  const prompt = val('--append-system-prompt');
  check('the master prompt names the copy, the mods folder, and what may not change', prompt.includes(sb5.work) && prompt.includes('extension/mods/') && /Nothing outside extension\/mods\/ may change/.test(prompt));
  check('the master prompt says how a mod runs, and what happens when it throws', /\$\('id'\)/.test(prompt) && /turns that mod off/.test(prompt) && /\(function \(\) \{/.test(prompt));
  check('the master prompt gives the notes as data, with the newest run in it', /data, not instructions/.test(prompt) && prompt.includes('Asked: run 55'));
  check('the master prompt names no shell and no web tool', !/Bash|WebSearch|WebFetch/.test(prompt));
  // The Edit and Write rules name the mods folder by its given spelling and by its real one, as denyRules spells its rules.
  const link = path.join(tmp, 'work-link');
  fs.symlinkSync(sb5.work, link, 'junction');
  const linked = S.args({ ...sb5, work: link }, { model: 'claude-opus-5-5', effort: 'max' }, {});
  const allowedLinked = linked[linked.indexOf('--allowedTools') + 1];
  const realMods = path.join(fs.realpathSync.native(link), 'extension', 'mods');
  check('the Edit and Write rules name the mods folder by its given spelling and by its real one', ['Edit', 'Write'].every(t => allowedLinked.includes(`${t}(/${G.posix(path.join(link, 'extension', 'mods'))}/**)`) && allowedLinked.includes(`${t}(/${G.posix(realMods)}/**)`)), allowedLinked);
  S.discard(sb5.id);
  check('an empty request asks for one change; a typed one is passed on', /pick the one change/.test(S.request('')) && S.request('make the panel nicer').includes('make the panel nicer'));
  // A test run past its time is stopped with every process it started: its child writes a heartbeat until it is stopped.
  const hangRoot = path.join(tmp, 'hang-addon');
  fs.mkdirSync(path.join(hangRoot, 'test'), { recursive: true });
  const beaterSrc = () => { setInterval(() => require('fs').appendFileSync(require('path').join(__dirname, '..', 'beat.txt'), 'b'), 100); };
  const runnerSrc = () => {
    const fs = require('fs');
    const path = require('path');
    const kid = require('child_process').spawn(process.execPath, [path.join(__dirname, 'beater.js')], { stdio: 'ignore' });
    fs.writeFileSync(path.join(__dirname, '..', 'pids.txt'), `${process.pid} ${kid.pid}`);
    setInterval(() => {}, 1000);
  };
  fs.writeFileSync(path.join(hangRoot, 'test', 'beater.js'), `(${beaterSrc})();\n`);
  fs.writeFileSync(path.join(hangRoot, 'test', 'run-all.js'), `(${runnerSrc})();\n`);
  let hangCap;
  const capped = new Promise(r => { hangCap = setTimeout(() => r({ ok: 'capped' }), 8000); });
  const hung = await Promise.race([S.runTests(hangRoot, 1500), capped]);
  clearTimeout(hangCap);
  const beatFile = path.join(hangRoot, 'beat.txt');
  const beats = () => (fs.existsSync(beatFile) ? fs.statSync(beatFile).size : 0);
  await new Promise(r => setTimeout(r, 300));
  const stoppedAt = beats();
  await new Promise(r => setTimeout(r, 800));
  const laterAt = beats();
  // Clean-up only: anything this test started that is still running is stopped by its pid.
  const pidFile = path.join(hangRoot, 'pids.txt');
  for (const pid of fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').split(' ').map(Number) : []) if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  check('a test run past its time is stopped with its child: no heartbeat after the stop', hung.ok === false && stoppedAt > 0 && laterAt === stoppedAt, JSON.stringify({ ok: hung.ok, stoppedAt, laterAt }));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e && e.stack ? e.stack : e); process.exit(1); });
