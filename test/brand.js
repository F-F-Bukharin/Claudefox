'use strict';
// The friends build is branded Claudefox (tools/brand.js); this PC's install and the source stay Claude in Zen.
// Stages the files the way tools/build-friends.ps1 does, brands them, and checks the result.   node test/brand.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'latin1');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.statSync(from).isDirectory()) for (const n of fs.readdirSync(from)) copy(path.join(from, n), path.join(to, n));
  else fs.copyFileSync(from, to);
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
// What build-friends.ps1 puts in its stage before it brands it (local mods and saved files left out).
function stage() {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-brand-'));
  copy(path.join(root, 'extension'), path.join(s, 'extension'));
  for (const sub of ['mods', 'output']) {
    const d = path.join(s, 'extension', sub);
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d)) if (n !== 'README.txt') fs.rmSync(path.join(d, n), { recursive: true, force: true });
  }
  for (const f of ['claude-in-zen-host.js', 'zen-mcp.js', 'install.ps1', 'pick-folder.ps1', 'confirm.ps1']) copy(path.join(root, 'host', f), path.join(s, 'host', f));
  for (const f of fs.readdirSync(path.join(root, 'host', 'lib')).filter(f => f.endsWith('.js'))) copy(path.join(root, 'host', 'lib', f), path.join(s, 'host', 'lib', f));
  copy(path.join(root, 'zen-profile'), path.join(s, 'zen-profile'));
  for (const f of ['Set up Claude in Zen.bat', 'START HERE.txt']) copy(path.join(root, f), path.join(s, f));
  for (const f of ['Apply Zen settings.bat', 'Sign in Claude Code.bat']) copy(path.join(root, 'tools', f), path.join(s, 'tools', f));
  return s;
}
const run = dir => spawnSync(process.execPath, [path.join(root, 'tools', 'brand.js'), dir], { encoding: 'utf8' });

const s = stage();
try {
  const r = run(s);
  check('brand.js brands the staged copy', r.status === 0 && /Branded .* as Claudefox/.test(r.stdout), r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(s, 'extension', 'manifest.json'), 'utf8'));
  check('the add-on is called Claudefox, for Firefox, with its id unchanged', m.name === 'Claudefox' && /pages in Firefox\. Not affiliated with or endorsed by Anthropic or Mozilla\./.test(m.description)
    && m.browser_specific_settings.gecko.id === 'claude-in-zen@f.local' && m.sidebar_action.default_title === 'Claudefox', JSON.stringify({ name: m.name, description: m.description }));
  const panel = fs.readFileSync(path.join(s, 'extension', 'panel.html'), 'utf8');
  check('the empty chat asks "What should Claude do in Firefox?"', panel.includes('What should Claude do in Firefox?') && !panel.includes('What should I do in Zen?') && /<title>Claudefox<\/title>/.test(panel));
  const left = walk(s).filter(f => fs.readFileSync(f, 'latin1').includes('Claude in Zen')).map(f => path.relative(s, f));
  check('no "Claude in Zen" is left anywhere in the copy', left.length === 0, left.join(', '));
  const bat = path.join(s, 'Set up Claudefox.bat');
  check('the setup file is "Set up Claudefox.bat" and looks for claudefox.xpi', fs.existsSync(bat) && !fs.existsSync(path.join(s, 'Set up Claude in Zen.bat'))
    && fs.readFileSync(bat, 'latin1').includes('claudefox.xpi') && !fs.readFileSync(bat, 'latin1').includes('claude-in-zen.xpi'));
  check('START HERE names Claudefox and claudefox.xpi', /^Claudefox - setup for friends/.test(fs.readFileSync(path.join(s, 'START HERE.txt'), 'latin1')) && fs.readFileSync(path.join(s, 'START HERE.txt'), 'latin1').includes('claudefox.xpi'));
  check('the helper\'s windows say Claudefox', /Claudefox: switch on something that runs programs\?/.test(fs.readFileSync(path.join(s, 'host', 'lib', 'toolbox.js'), 'utf8')));
  check('inside names stay: the helper\'s registry name and the data folder', /NATIVE_HOST: 'claude_in_zen'/.test(fs.readFileSync(path.join(s, 'extension', 'lib', 'policy.js'), 'utf8'))
    && /\$name\s+= 'claude_in_zen'/.test(fs.readFileSync(path.join(s, 'host', 'install.ps1'), 'latin1')) && /path\.join\(LOCAL, 'claude-in-zen'\)/.test(fs.readFileSync(path.join(s, 'host', 'lib', 'paths.js'), 'utf8')));
  check('a file without the old name keeps every byte', fs.readFileSync(path.join(s, 'extension', 'lib', 'state.js')).equals(fs.readFileSync(path.join(root, 'extension', 'lib', 'state.js'))));
  const b = fs.readFileSync(bat, 'latin1');
  check('Windows files keep their CRLF line endings', b.includes('\r\n') && !/[^\r]\n/.test(b));
  check('the source and this PC\'s install stay Claude in Zen', JSON.parse(read('extension/manifest.json')).name === 'Claude in Zen' && read('extension/panel.html').includes('What should I do in Zen?')
    && fs.existsSync(path.join(root, 'Set up Claude in Zen.bat')));
} finally { fs.rmSync(s, { recursive: true, force: true }); }

// A rule that stops matching (someone changed the text) stops the build, naming the rule.
const s2 = stage();
try {
  const p = path.join(s2, 'extension', 'panel.html');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('What should I do in Zen?', 'What now?'));
  const r = run(s2);
  check('a rule with no match fails the build and says which', r.status === 1 && /no match for "What should I do in Zen\?" in extension\/panel\.html/.test(r.stderr), r.stderr);
} finally { fs.rmSync(s2, { recursive: true, force: true }); }

// The PowerShell side (no PowerShell here): the friends build brands its copy and packs that copy; the two builds
// never pick up each other's signed file.
const friends = read('tools/build-friends.ps1');
check('build-friends brands its copy with brand.js and stops when that fails', /& node \(Join-Path \$PSScriptRoot 'brand\.js'\) \$stage/.test(friends) && /if \(\$LASTEXITCODE -ne 0\) \{ throw/.test(friends));
check('build-friends packs the branded copy as claudefox.xpi into Claudefox-v<version>.zip', /build-xpi\.ps1'\) -Source \(Join-Path \$stage 'extension'\) -Out \$xpi/.test(friends)
  && /'claudefox\.xpi'/.test(friends) && /"Claudefox-v\$v\.zip"/.test(friends) && /Remove-Item \(Join-Path \$stage 'extension'\) -Recurse -Force/.test(friends));
check('signed builds are matched by name: Claudefox for friends, Claude in Zen for this PC', /Find-SignedXpi \$root \$v 'Claudefox'/.test(friends)
  && /Find-SignedXpi \$root \$version 'Claude in Zen'/.test(read('tools/install-xpi.ps1')) && /\$m\.name -eq \$Name/.test(read('tools/xpi-tools.ps1')));
check('build-xpi packs another folder when asked, and this PC\'s build by default', /param\(\[string\]\$Source, \[string\]\$Out\)/.test(read('tools/build-xpi.ps1'))
  && /else \{ Join-Path \$root 'build\\claude-in-zen\.xpi' \}/.test(read('tools/build-xpi.ps1')));
check('the changed PowerShell keeps CRLF', ['tools/build-friends.ps1', 'tools/build-xpi.ps1', 'tools/xpi-tools.ps1', 'tools/install-xpi.ps1'].every(f => { const t = read(f); return t.includes('\r\n') && !/[^\r]\n/.test(t); }));

console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
