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
  for (const f of ['claude-in-zen-host.js', 'zen-mcp.js', 'webfetch-hook.js', 'install.ps1', 'pick-folder.ps1', 'confirm.ps1']) copy(path.join(root, 'host', f), path.join(s, 'host', f));
  for (const f of fs.readdirSync(path.join(root, 'host', 'lib')).filter(f => f.endsWith('.js'))) copy(path.join(root, 'host', 'lib', f), path.join(s, 'host', 'lib', f));
  for (const f of ['Set up Claudefox.bat', 'START HERE.txt']) copy(path.join(root, 'friends', f), path.join(s, f));
  copy(path.join(root, 'tools', 'Sign in Claude Code.bat'), path.join(s, 'tools', 'Sign in Claude Code.bat'));
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
  check('the friends add-on links to its GitHub page and the update file Firefox checks', m.homepage_url === 'https://github.com/F-F-Bukharin/Claudefox'
    && m.browser_specific_settings.gecko.update_url === 'https://github.com/F-F-Bukharin/Claudefox/releases/latest/download/updates.json'
    && m.browser_specific_settings.gecko.id === 'claude-in-zen@f.local', JSON.stringify([m.homepage_url, m.browser_specific_settings.gecko.update_url]));
  check('the empty chat asks "What should Claude do in Firefox?"', panel.includes('What should Claude do in Firefox?') && !panel.includes('What should I do in Zen?') && /<title>Claudefox<\/title>/.test(panel));
  const left = walk(s).filter(f => fs.readFileSync(f, 'latin1').includes('Claude in Zen')).map(f => path.relative(s, f));
  check('no "Claude in Zen" is left anywhere in the copy', left.length === 0, left.join(', '));
  const bat = path.join(s, 'Set up Claudefox.bat');
  const batText = fs.readFileSync(bat, 'latin1');
  check('the setup finds Firefox and opens about:debugging, or about:addons for a signed build, with claudefox.xpi copied', /Mozilla Firefox\\firefox\.exe/.test(batText)
    && batText.includes('set "PAGE=about:debugging#/runtime/this-firefox"') && /if exist "%~dp0SIGNED" set "PAGE=about:addons"/.test(batText)
    && /for %%I in \("%~dp0claudefox\.xpi"\) do .*\| clip/.test(batText) && !/zen/i.test(batText));
  // In cmd, a ")" printed inside a ( ... ) block ends the block early: parentheses in messages stay outside blocks.
  const inBlock = []; let depth = 0;
  for (const line of batText.split('\r\n')) {
    if (depth && /^\s*echo .*[()]/.test(line)) inBlock.push(line.trim());
    if (/\($/.test(line.trim())) depth++;
    if (/^\s*\)/.test(line)) depth--;
  }
  check('the setup prints no parentheses inside an if block', inBlock.length === 0, inBlock.join(' | '));
  const startHere = fs.readFileSync(path.join(s, 'START HERE.txt'), 'latin1');
  check('START HERE is the Firefox one: Claudefox, about:addons and no about:debugging, claudefox.xpi, no Zen', /^Claudefox - setup for friends/.test(startHere) && startHere.includes('about:addons')
    && !startHere.includes('about:debugging') && startHere.includes('claudefox.xpi') && !/zen/i.test(startHere));
  check('panel texts friends read say Firefox', /already open in Firefox\./.test(panel) && /Firefox remembers it after that/.test(panel) && />Using Firefox now</.test(panel)
    && /The panel opens in the sidebar\./.test(panel) && !/title bar above the panel/.test(panel)
    && fs.readFileSync(path.join(s, 'extension', 'background.js'), 'utf8').includes("'Firefox opened: the agent is on.'"));
  // The panel's own texts live in the two language files now (E11); the friends' copies carry the Firefox wording.
  const frLang = {};
  for (const l of ['en', 'pt_BR']) {
    try { frLang[l] = JSON.parse(fs.readFileSync(path.join(s, 'extension', '_locales', l, 'messages.json'), 'utf8')); } catch (e) { frLang[l] = null; }
  }
  const msg = (l, k) => (frLang[l] && frLang[l][k] && frLang[l][k].message) || '';
  check('both branded language files still parse as JSON', !!frLang.en && !!frLang.pt_BR);
  check('the panel itself titles the empty chat "What should Claude do in Firefox?"', msg('en', 'ui_emptyTitle') === 'What should Claude do in Firefox?'
    && msg('en', 'main_signInHint').includes('then press Sign in. Firefox remembers it after that.')
    && msg('en', 'main_unsafeOn').includes('until you press Stop or restart Firefox.')
    && msg('en', 'main_acctDiffers').includes('the claude.ai account signed in to Firefox.')
    && !Object.values(frLang.en || {}).some(v => v.message.includes('What should I do in Zen?')));
  check('the Portuguese file says Firefox too: no C5 "Zen" text is left, and the empty chat asks "O que o Claude deve fazer no Firefox?"', msg('pt_BR', 'ui_emptyTitle') === 'O que o Claude deve fazer no Firefox?'
    && msg('pt_BR', 'ui_signedOutText').includes('já aberta no Firefox.') && msg('pt_BR', 'ui_signedOutText').includes('O Firefox se lembra disso depois')
    && msg('pt_BR', 'ui_usingZenNow') === 'Usando o Firefox agora' && msg('pt_BR', 'ui_panelPlace').startsWith('O painel abre na barra lateral. ')
    && !/Zen/.test(msg('pt_BR', 'ui_panelPlaceEnd')) && msg('pt_BR', 'main_unsafeOn').includes('ou reiniciar o Firefox.')
    && msg('pt_BR', 'main_acctDiffers').includes('conectada no Firefox.') && msg('pt_BR', 'main_signInHint').includes('O Firefox se lembra disso depois.')
    && !/\bZen\b/.test(['ui_emptyTitle', 'ui_signedOutText', 'ui_usingZenNow', 'ui_panelPlace', 'ui_panelPlaceEnd', 'main_signInHint', 'main_unsafeOn', 'main_acctDiffers'].map(k => msg('pt_BR', k)).join(' ')));
  const mcp = fs.readFileSync(path.join(s, 'host', 'zen-mcp.js'), 'utf8'), args = fs.readFileSync(path.join(s, 'host', 'lib', 'chatargs.js'), 'utf8');
  check('Claude is told it works in Firefox, and its errors say Firefox', mcp.includes("real Firefox browser") && !mcp.includes('real Zen browser') && args.includes('which field to fill in Firefox.')
    && fs.readFileSync(path.join(s, 'host', 'lib', 'toolSchemas.js'), 'utf8').includes('in a new tab, in front') && !/Zen did not answer|No answer from Zen|No Zen tab/.test(walk(s).filter(f => /\.js$/.test(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n')));
  check('the helper\'s windows say Claudefox', /Claudefox: switch on something that runs programs\?/.test(fs.readFileSync(path.join(s, 'host', 'lib', 'plugins.js'), 'utf8')));
  check('inside names stay: the helper\'s registry name and the data folder', /NATIVE_HOST: 'claude_in_zen'/.test(fs.readFileSync(path.join(s, 'extension', 'lib', 'policy.js'), 'utf8'))
    && /\$name\s+= 'claude_in_zen'/.test(fs.readFileSync(path.join(s, 'host', 'install.ps1'), 'latin1')) && /path\.join\(LOCAL, 'claude-in-zen'\)/.test(fs.readFileSync(path.join(s, 'host', 'lib', 'paths.js'), 'utf8')));
  check('a file without the old name keeps every byte', fs.readFileSync(path.join(s, 'extension', 'lib', 'state.js')).equals(fs.readFileSync(path.join(root, 'extension', 'lib', 'state.js'))));
  check('Windows files keep their CRLF line endings', [batText, startHere, fs.readFileSync(path.join(s, 'host', 'install.ps1'), 'latin1')].every(b => b.includes('\r\n') && !/[^\r]\n/.test(b)));
  check('the source and this PC\'s install stay Claude in Zen', JSON.parse(read('extension/manifest.json')).name === 'Claude in Zen' && read('extension/panel.html').includes('What should I do in Zen?')
    && fs.existsSync(path.join(root, 'Set up Claude in Zen.bat')) && read('START HERE.txt').startsWith('Claude in Zen'));
  const own = JSON.parse(read('extension/manifest.json'));
  check('this PC\'s own build has no GitHub homepage or update address', !own.homepage_url && !own.browser_specific_settings.gecko.update_url);
} finally { fs.rmSync(s, { recursive: true, force: true }); }

// A rule that stops matching (someone changed the text) stops the build, naming the rule.
const s2 = stage();
try {
  const p = path.join(s2, 'extension', 'panel.html');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('What should I do in Zen?', 'What now?'));
  const r = run(s2);
  check('a rule with no match fails the build and says which', r.status === 1 && /no match for "What should I do in Zen\?" in extension\/panel\.html/.test(r.stderr), r.stderr);
} finally { fs.rmSync(s2, { recursive: true, force: true }); }

// Without tools/release.json the friends build stops: an add-on signed without its update address could never update.
const s3 = stage();
const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-brand-tools-'));
try {
  fs.copyFileSync(path.join(root, 'tools', 'brand.js'), path.join(lone, 'brand.js'));
  const r = spawnSync(process.execPath, [path.join(lone, 'brand.js'), s3], { encoding: 'utf8' });
  check('without tools/release.json the friends build stops and says why', r.status === 1 && /tools\/release\.json/.test(r.stderr), r.stderr);
} finally { fs.rmSync(s3, { recursive: true, force: true }); fs.rmSync(lone, { recursive: true, force: true }); }

// The PowerShell side (no PowerShell here): the friends build brands its copy and packs that copy; the two builds
// never pick up each other's signed file.
const friends = read('tools/build-friends.ps1');
const tools = read('tools/xpi-tools.ps1');
const stageFn = tools.slice(tools.indexOf('function New-ClaudefoxStage'), tools.indexOf('function New-FolderZip'));
check('the friends zip and signing share one clean, branded copy (New-ClaudefoxStage), which stops when branding fails', /New-ClaudefoxStage \$root \$stage/.test(friends)
  && /& node \(Join-Path \$Root 'tools\\brand\.js'\) \$Stage/.test(stageFn) && /if \(\$LASTEXITCODE -ne 0\) \{ throw/.test(stageFn)
  && /extension\\mods'\) -Directory/.test(stageFn) && /extension\\output'\) -Exclude 'README\.txt'/.test(stageFn));
check('build-friends packs the branded copy as claudefox.xpi into Claudefox-v<version>.zip', /build-xpi\.ps1'\) -Source \(Join-Path \$stage 'extension'\) -Out \$xpi/.test(friends)
  && /'claudefox\.xpi'/.test(friends) && /"Claudefox-v\$v\.zip"/.test(friends) && /Remove-Item \(Join-Path \$stage 'extension'\) -Recurse -Force/.test(friends));
check('friends get the Firefox setup and START HERE, without Zen\'s profile settings', /'Set up Claudefox\.bat', 'START HERE\.txt'\) \{ Copy-Item \(Join-Path \$Root "friends\\\$f"\)/.test(stageFn)
  && !/zen-profile|Apply Zen settings/.test(stageFn + friends) && /Set-Content -Path \(Join-Path \$stage 'SIGNED'\)/.test(friends) && /'confirm\.ps1'/.test(stageFn));
const sign = read('tools/sign-claudefox.ps1'), signBat = read('tools/Sign add-on.bat');
check('signing uploads only the clean Claudefox copy, unlisted, and has a dry run', /New-ClaudefoxStage \$root \$stage/.test(sign) && /\$src = Join-Path \$stage 'extension'/.test(sign)
  && /Push-Location \$src/.test(sign) && /web-ext@8 sign --channel=unlisted --artifacts-dir \$out/.test(sign) && /param\(\[switch\]\$DryRun\)/.test(sign)
  && /sign-claudefox\.ps1/.test(signBat) && !/cd \/d "%~dp0\.\.\\extension"/.test(signBat));
check('signing finds keys set after its window opened (the account\'s user variables)', /\[Environment\]::GetEnvironmentVariable\(\$n, 'User'\)/.test(sign)
  && sign.indexOf("GetEnvironmentVariable($n, 'User')") < sign.indexOf('if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET)'));
check('signing never prints the API keys', !/Write-Host[^\r\n]*\$env:WEB_EXT/.test(sign) && !/echo[^\r\n]*%WEB_EXT/i.test(signBat));
check('the zip has forward-slash paths (New-FolderZip, not Compress-Archive)', /New-FolderZip \$stage \$zip/.test(friends) && !/Compress-Archive/.test(friends)
  && /\$rel = \$top \+ '\/' \+ \$_\.FullName\.Substring\(\$Folder\.Length \+ 1\)\.Replace\('\\', '\/'\)/.test(read('tools/xpi-tools.ps1')));
check('signed builds are matched by name: Claudefox for friends, Claude in Zen for this PC', /Find-SignedXpi \$root \$v 'Claudefox'/.test(friends)
  && /Find-SignedXpi \$root \$version 'Claude in Zen'/.test(read('tools/install-xpi.ps1')) && /\$m\.name -eq \$Name/.test(read('tools/xpi-tools.ps1')));
check('build-xpi packs another folder when asked, and this PC\'s build by default', /param\(\[string\]\$Source, \[string\]\$Out\)/.test(read('tools/build-xpi.ps1'))
  && /else \{ Join-Path \$root 'build\\claude-in-zen\.xpi' \}/.test(read('tools/build-xpi.ps1')));
check('the changed PowerShell keeps CRLF', ['tools/build-friends.ps1', 'tools/build-xpi.ps1', 'tools/xpi-tools.ps1', 'tools/install-xpi.ps1'].every(f => { const t = read(f); return t.includes('\r\n') && !/[^\r]\n/.test(t); }));

// Releases (PowerShell, read here): the signed Claudefox of this version with its update address checked, updates.json
// with the asset's link and hash, and the public clone refreshed without touching its own files.
const has = f => fs.existsSync(path.join(root, f));
const rel = has('tools/prepare-release.ps1') ? read('tools/prepare-release.ps1') : '';
const relBat = has('tools/Prepare release.bat') ? read('tools/Prepare release.bat') : '';
check('the release step takes the signed Claudefox of this version and checks its update address', /Find-SignedXpi \$root \$v 'Claudefox'/.test(rel)
  && /\.browser_specific_settings\.gecko\.update_url -ne \$updates/.test(rel) && /releases\/latest\/download\/updates\.json/.test(rel));
check('updates.json links the release asset with its sha256, written without a BOM', /releases\/download\/v\$v\/\$name/.test(rel)
  && /"update_hash": "sha256:\$hash"/.test(rel) && /Get-FileHash .*-Algorithm SHA256/.test(rel) && /New-Object Text\.UTF8Encoding \$false/.test(rel));
check('the public clone gets the branded build and keeps its README, LICENSE, .gitattributes and .git', /New-ClaudefoxStage \$root \$stage/.test(rel)
  && /robocopy .*\/MIR/.test(rel) && /\/XD \.git/.test(rel) && /\/XF README\.md LICENSE \.gitattributes/.test(rel));
check('the release files keep CRLF and the .bat runs the script', rel !== '' && relBat !== '' && [rel, relBat].every(t => t.includes('\r\n') && !/[^\r]\n/.test(t)) && /prepare-release\.ps1/.test(relBat));

check('the friends build ships the WebFetch hook (page safety, A3)', /'webfetch-hook\.js'/.test(stageFn));

console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
