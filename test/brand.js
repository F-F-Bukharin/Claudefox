'use strict';
// The source and this PC's install say Claudefox, and Zen where they mean the browser. The friends build (tools/brand.js)
// turns that Zen into Firefox. Stages the files the way tools/build-friends.ps1 does, brands them, checks the result, and runs the branded copy's suite.
// The last section (D3) checks the rename itself: no old name is left outside a short allowlist, the migration in
// host/install.ps1, and the helper's registration.   node test/brand.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'latin1');
// The old names, built from parts so this file does not contain them itself (the D3 section below scans this file too).
const OLD_WORD = sep => ['claude', 'in', 'zen'].join(sep);       // OLD_WORD('_') is the old registration, OLD_WORD('-') the old data folder
const OLD_NAME = ['Claude', 'in', 'Zen'].join(' ');              // the old product name
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
// tools\ and friends\ are repo folders: a friends copy (the zip, or the copy the friends suite below runs) has neither, so
// this file SKIPs there. The inner run of the friends suite sets CLAUDEFOX_FRIENDS_INNER, which keeps it from staging again.
if (!fs.existsSync(path.join(root, 'tools', 'brand.js'))) { console.log('SKIP  tools\\ and friends\\ are not in a friends copy'); process.exit(0); }

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.statSync(from).isDirectory()) {
    for (const n of fs.readdirSync(from)) if (n !== '__pycache__' && !n.endsWith('.pyc')) copy(path.join(from, n), path.join(to, n));   // Python's caches never travel
  } else fs.copyFileSync(from, to);
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
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-brand-'));
  copy(path.join(root, 'extension'), path.join(s, 'extension'));
  for (const sub of ['mods', 'output']) {
    const d = path.join(s, 'extension', sub);
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d)) if (n !== 'README.txt') fs.rmSync(path.join(d, n), { recursive: true, force: true });
  }
  for (const f of ['claudefox-host.js', 'claudefox-mcp.js', 'webfetch-hook.js', 'install.ps1', 'pick-folder.ps1', 'confirm.ps1']) copy(path.join(root, 'host', f), path.join(s, 'host', f));
  for (const f of fs.readdirSync(path.join(root, 'host', 'lib')).filter(f => f.endsWith('.js'))) copy(path.join(root, 'host', 'lib', f), path.join(s, 'host', 'lib', f));
  for (const f of ['Set up Claudefox.bat', 'START HERE.txt']) copy(path.join(root, 'friends', f), path.join(s, f));
  copy(path.join(root, 'tools', 'Sign in Claude Code.bat'), path.join(s, 'tools', 'Sign in Claude Code.bat'));
  // The tests come along: Improve runs them on the copy.
  copy(path.join(root, 'test'), path.join(s, 'test'));
  copy(path.join(root, 'host', 'test'), path.join(s, 'host', 'test'));
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
  const left = walk(s).filter(f => fs.readFileSync(f, 'latin1').includes(OLD_NAME)).map(f => path.relative(s, f));
  check(`no "${OLD_NAME}" is left anywhere in the copy`, left.length === 0, left.join(', '));
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
  const mcp = fs.readFileSync(path.join(s, 'host', 'claudefox-mcp.js'), 'utf8'), args = fs.readFileSync(path.join(s, 'host', 'lib', 'chatargs.js'), 'utf8');
  check('Claude is told it works in Firefox, and its errors say Firefox', mcp.includes("real Firefox browser") && !mcp.includes('real Zen browser') && args.includes('which field to fill in Firefox.')
    && fs.readFileSync(path.join(s, 'host', 'lib', 'toolSchemas.js'), 'utf8').includes('in a new tab, in front') && !/Zen did not answer|No answer from Zen|No Zen tab/.test(walk(s).filter(f => /\.js$/.test(f) && !/(^|[\\/])test[\\/]/.test(path.relative(s, f))).map(f => fs.readFileSync(f, 'utf8')).join('\n')));
  check('the helper\'s windows say Claudefox', /Claudefox: switch on something that runs programs\?/.test(fs.readFileSync(path.join(s, 'host', 'lib', 'confirmtexts.js'), 'utf8')));
  check('inside names in the friends copy: the helper\'s registry name, the old name for the fallback, the data folder, and the add-on id', /NATIVE_HOST: 'claudefox'/.test(fs.readFileSync(path.join(s, 'extension', 'lib', 'policy.js'), 'utf8'))
    && fs.readFileSync(path.join(s, 'extension', 'lib', 'policy.js'), 'utf8').includes(`NATIVE_HOST_OLD: '${OLD_WORD('_')}'`)
    && /\$name\s+= 'claudefox'/.test(fs.readFileSync(path.join(s, 'host', 'install.ps1'), 'latin1')) && /path\.join\(LOCAL, 'claudefox'\)/.test(fs.readFileSync(path.join(s, 'host', 'lib', 'paths.js'), 'utf8'))
    && m.browser_specific_settings.gecko.id === 'claude-in-zen@f.local');
  check('a file without the old name keeps every byte', fs.readFileSync(path.join(s, 'extension', 'lib', 'i18n.js')).equals(fs.readFileSync(path.join(root, 'extension', 'lib', 'i18n.js'))));
  check('Windows files keep their CRLF line endings', [batText, startHere, fs.readFileSync(path.join(s, 'host', 'install.ps1'), 'latin1')].every(b => b.includes('\r\n') && !/[^\r]\n/.test(b)));
  check('the source and this PC\'s install say Claudefox, and Zen where they mean the browser', JSON.parse(read('extension/manifest.json')).name === 'Claudefox' && read('extension/panel.html').includes('What should I do in Zen?')
    && fs.existsSync(path.join(root, 'Set up Claudefox.bat')) && read('START HERE.txt').startsWith('Claudefox'));
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
const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-brand-tools-'));
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
  && /'claudefox\.xpi'/.test(friends) && /"Claudefox-v\$v\.zip"/.test(friends));
check('build-friends keeps the staged extension\\ folder after packing, so the zip carries the add-on\'s source (Improve copies it)',
  !/Remove-Item \(Join-Path \$stage 'extension'\)/.test(friends) && /New-FolderZip \$stage \$zip/.test(friends));
check('the friends stage carries the tests, test\\ and host\\test\\ (Improve runs them on a friend\'s copy)', /Copy-Item \(Join-Path \$Root 'test'\) \(Join-Path \$Stage 'test'\) -Recurse/.test(stageFn)
  && /Copy-Item \(Join-Path \$Root 'host\\test'\) \(Join-Path \$Stage 'host\\test'\) -Recurse/.test(stageFn));
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
check('signed builds are matched by their add-on name, Claudefox, in both the friends build and this PC\'s install', /Find-SignedXpi \$root \$v 'Claudefox'/.test(friends)
  && /Find-SignedXpi \$root \$version 'Claudefox'/.test(read('tools/install-xpi.ps1')) && /\$m\.name -eq \$Name/.test(read('tools/xpi-tools.ps1')));
check('build-xpi packs another folder when asked, and this PC\'s build by default', /param\(\[string\]\$Source, \[string\]\$Out\)/.test(read('tools/build-xpi.ps1'))
  && /else \{ Join-Path \$root 'build\\claudefox\.xpi' \}/.test(read('tools/build-xpi.ps1')));
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

// ---------------------------------------------------------------- D3 · the rename to Claudefox
// No old name is left in the add-on, the helper, the scripts, the tests or the docs people read, except what must stay:
// the add-on id (and the widget id Firefox makes from it), the four localStorage keys saved on people's PCs, the
// migration's own old names (host/install.ps1), and the fallback's old helper name (extension/lib/policy.js).
const ADDON_ID = ['claude', 'in', 'zen@f.local'].join('-');
const ADDON_WIDGET = ['claude', 'in', 'zen_f_local'].join('-');                        // Firefox's name for the add-on's sidebar, made from its id
const KEPT_KEYS = ['lang', 'theme', 'wall', 'mods-loading'].map(k => 'c' + 'iz-' + k);   // localStorage keys already saved; a new name would lose them
const OLD_ANY = new RegExp(['c' + 'iz', 'claude[-_ ]in[-_ ]zen', ['zen', 'mcp'].join('-')].join('|'), 'i');
const oldWord = new RegExp(`${OLD_WORD('[-_]')}(-host\\.bat|\\.json)?`, 'g');
const ALLOWED = {   // file -> what may still be said there, as a pattern
  'host/install.ps1': oldWord,                    // the migration from the old folder and registration
  'extension/lib/policy.js': oldWord,             // NATIVE_HOST_OLD, the helper the add-on falls back to
  'test/addon-smoke.js': oldWord,                 // the fallback checks
  'README.md': oldWord,                           // says what the setup moves and removes
  'zen-profile/apply.ps1': new RegExp(OLD_NAME + ' (BEGIN|END)|' + OLD_NAME + ' BEGIN/END', 'g'),   // the marker lines already in people's Zen profile files
};
const SCANNED = ['extension', 'host', 'tools', 'test', 'friends', 'zen-profile'];   // build\ holds only made files (git ignores them), old builds included: just its README counts
const scanFiles = [];
const gather = rel => {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git' && e.name !== '__pycache__') gather(r); } else if (!e.name.endsWith('.pyc')) scanFiles.push(r);
  }
};
SCANNED.forEach(gather);
if (fs.existsSync(path.join(root, 'build', 'README.txt'))) scanFiles.push('build/README.txt');
for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isFile()) scanFiles.push(e.name);
const offenders = [];
for (const rel of scanFiles) {
  if (OLD_ANY.test(rel)) { offenders.push(`${rel} (its name)`); continue; }
  if (/\.(png|xpi|zip|ico|woff2?)$/i.test(rel)) continue;
  let text = fs.readFileSync(path.join(root, rel), 'latin1');
  for (const keep of [ADDON_ID, ADDON_WIDGET, ...KEPT_KEYS]) text = text.split(keep).join('');
  if (ALLOWED[rel]) text = text.replace(ALLOWED[rel], '');
  const hit = OLD_ANY.exec(text);
  if (hit) offenders.push(`${rel}: ${hit[0]}`);
}
check('D3: no old name (the old identifier prefixes, environment prefix, registration, data folder, product name and tool-server file) is left outside the allowlist', offenders.length === 0, offenders.slice(0, 8).join(' | '));
check('D3: the allowlist is used: the add-on id, the kept keys and the migration\'s old names are really there', read('extension/manifest.json').includes(ADDON_ID)
  && KEPT_KEYS.every(k => scanFiles.some(f => !/^test\//.test(f) && read(f).includes(k))) && oldWord.test(read('host/install.ps1')) && read('extension/lib/policy.js').includes(`'${OLD_WORD('_')}'`));
oldWord.lastIndex = 0;
check('D3: the files are renamed (git mv): the helper, the tool server, the setup and the menu', ['host/claudefox-host.js', 'host/claudefox-mcp.js', 'Set up Claudefox.bat', 'tools/Claudefox menu.bat'].every(has)
  && [`host/${OLD_WORD('-')}-host.js`, `host/${['zen', 'mcp'].join('-')}.js`, `Set up ${OLD_NAME}.bat`, `tools/${OLD_NAME} menu.bat`].every(f => !has(f)));
check('D3: files named after the browser keep their names', ['zen-profile/apply.ps1', 'tools/Load in Zen.bat', 'tools/Install in Zen.bat', 'tools/Apply Zen settings.bat', 'tools/Link add-on to Zen.bat', 'friends/Set up Claudefox.bat'].every(has));
check('D3: zen-profile/apply.ps1 keeps its marker lines (they are already in people\'s Zen profile files, and a new name would add a second block)', read('zen-profile/apply.ps1').includes(`$comment ${OLD_NAME} BEGIN$close`) && read('zen-profile/apply.ps1').includes(`$comment ${OLD_NAME} END$close`));
check('D3: the add-on id stays', JSON.parse(read('extension/manifest.json')).browser_specific_settings.gecko.id === ADDON_ID && read('host/install.ps1').includes(`'${ADDON_ID}'`));

// The names the helper uses, read from the real modules (a child process, so LOCALAPPDATA can point at a temp folder).
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-names-'));
try {
  const out = spawnSync(process.execPath, ['-e', "const p=require(process.argv[1]);console.log(JSON.stringify({base:p.BASE,pipe:p.PIPE,hook:p.testHook('CLAUDEFOX_PIPE')}))", path.join(root, 'host', 'lib', 'paths.js')],
    { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: probe, CLAUDEFOX_TEST: '1', CLAUDEFOX_PIPE: '/x/y.sock' } });
  const o = JSON.parse(out.stdout || '{}');
  check('D3: the data folder is %LOCALAPPDATA%\\claudefox and the test hooks read CLAUDEFOX_*', o.base === path.join(probe, 'claudefox') && o.hook === '/x/y.sock', out.stdout + out.stderr);
  const env2 = { ...process.env, LOCALAPPDATA: probe }; delete env2.CLAUDEFOX_PIPE; delete env2.CLAUDEFOX_TEST;
  const out2 = spawnSync(process.execPath, ['-e', "const p=require(process.argv[1]);console.log(p.PIPE)", path.join(root, 'host', 'lib', 'paths.js')], { encoding: 'utf8', env: env2 });
  check('D3: the pipe is claudefox-<user> (the socket file on Linux)', /[\\/]claudefox-[^\\/]+(\.sock)?$/.test(out2.stdout.trim()) && !/zen/i.test(out2.stdout), out2.stdout + out2.stderr);
  const out3 = spawnSync(process.execPath, ['-e', "const p=require(process.argv[1]);console.log(p.PIPE)", path.join(root, 'host', 'lib', 'paths.js')], { encoding: 'utf8', env: { ...env2, [['CLAUDE', 'IN', 'ZEN', 'TEST'].join('_')]: '1', [['CLAUDE', 'IN', 'ZEN', 'PIPE'].join('_')]: '/old/x.sock' } });
  check('D3: the old test variables (the previous environment prefix) no longer move the pipe', out3.stdout.trim() === out2.stdout.trim(), out3.stdout);
} finally { fs.rmSync(probe, { recursive: true, force: true }); }
const cc = read('host/lib/claudecode.js'), plug = read('host/lib/plugins.js');
check('D3: the tool server is `claudefox` (tools are mcp__claudefox__*): in the config Claude Code gets, the allowed tools, the server\'s own name and the plugins\' reserved names', /'claudefox': \{/.test(cc) && /'mcp__claudefox'/.test(read('host/lib/chatargs.js'))
  && /serverInfo: \{ name: 'claudefox'/.test(read('host/claudefox-mcp.js')) && /s\.name === 'claudefox'/.test(plug) && /mcp__claudefox__local_files/.test(read('host/lib/sites.js')));

// host/install.ps1 (no PowerShell here, so its text is read): it registers claudefox, moves the old data folder without
// opening a file, and removes the old registration, launcher and manifest; -Uninstall removes both registrations.
const inst = read('host/install.ps1');
const hasRe = (re, t = inst) => re.test(t);
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OLD_US = OLD_WORD('_'), OLD_DASH = OLD_WORD('-');
const mig = inst.slice(inst.indexOf('# Migration'), inst.indexOf('# Registration'));
check('D3: install.ps1 registers claudefox: the manifest name, its data folder, the launcher claudefox-host.bat and the helper claudefox-host.js', hasRe(/\$name\s+= 'claudefox'/) && hasRe(/\$base\s+= Join-Path \$env:LOCALAPPDATA 'claudefox'/)
  && hasRe(/\$launcher\s+= Join-Path \$base 'claudefox-host\.bat'/) && hasRe(/Join-Path \$PSScriptRoot 'claudefox-host\.js'/) && hasRe(new RegExp(`\\$addonId\\s+= '${esc(ADDON_ID)}'`)));
check('D3: install.ps1 names the old registration, folder, launcher and manifest', hasRe(new RegExp(`\\$oldName\\s+= '${OLD_US}'`)) && hasRe(new RegExp(`\\$oldBase\\s+= Join-Path \\$env:LOCALAPPDATA '${OLD_DASH}'`))
  && hasRe(new RegExp(`'${OLD_DASH}-host\\.bat'`)) && hasRe(/\$oldName\.json/));
check('D3: migration, old folder only: the folder is renamed to claudefox', mig !== '' && /Test-Path -LiteralPath \$oldBase\) -and -not \(Test-Path -LiteralPath \$base\)/.test(mig) && /Rename-Item -LiteralPath \$oldBase -NewName/.test(mig));
check('D3: migration, both folders: each top-level item the new folder lacks is moved, the rest stays and is said', /Get-ChildItem -LiteralPath \$oldBase -Force/.test(mig) && /Move-Item -LiteralPath \$item\.FullName -Destination/.test(mig)
  && /Test-Path -LiteralPath \(Join-Path \$base \$item\.Name\)/.test(mig) && /left in place/i.test(mig));
check('D3: migration moves files and never opens them', mig !== '' && !/Get-Content|ReadAll|Select-String|Copy-Item|Import-|\[IO\.File\]::(Open|Read)|-Recurse/.test(mig));
check('D3: a locked folder (the old helper still running) stops with a plain message, before anything is registered', /catch/.test(mig) && /Close Zen/i.test(mig) && inst.indexOf('# Migration') < inst.indexOf('# Registration'));
check('D3: install.ps1 removes the old registration, launcher and manifest after registering claudefox', /Remove-Item \$oldRegKey -Force/.test(inst) && inst.indexOf('Remove-Item $oldRegKey') > inst.indexOf('New-Item -Path $regKey'));
const un = inst.slice(inst.indexOf('if ($Uninstall)'), inst.indexOf('exit 0'));
check('D3: -Uninstall removes the new registration, and the old one if it is still there', /\$regKey/.test(un) && /\$oldRegKey/.test(un) && /\$launcher/.test(un) && /\$oldLauncher/.test(un) && /Test-Path/.test(un));
check('D3: install.ps1 keeps CRLF', inst.includes('\r\n') && !/[^\r]\n/.test(inst));
check('D3: the setup says Claudefox in its messages', /Claudefox helper installed\./.test(inst) && /Claudefox helper removed\./.test(inst) && !inst.includes(OLD_NAME));

// The friends copy is what Improve tests: the whole suite (test/run-all.js) must pass on the branded copy. The inner run
// sets CLAUDEFOX_FRIENDS_INNER, which skips this block, so the copy never stages a copy of its own.
if (!process.env.CLAUDEFOX_FRIENDS_INNER) {
  const sf = stage();
  try {
    const r = run(sf);
    check('friends suite: the staged copy is branded', r.status === 0, r.stderr);
    const left = walk(sf).filter(f => fs.readFileSync(f, 'latin1').includes(OLD_NAME)).map(f => path.relative(sf, f));
    check('friends suite: no old product name is left in any file of the copy', left.length === 0, left.join(', '));
    // D3 (spec): no "Zen" is left in the friends copy outside an explicit allowlist. A word "Zen" (any case) is either text a
    // friend or Claude reads, which must say Firefox by now, or code that is really about Zen; the second kind is listed here, by file.
    const ZEN_WORD = /\bzen\b/i;
    const ZEN_KEEP_ANY = [   // in any file
      [new RegExp(esc(ADDON_ID), 'g'), 'the add-on id (an install keeps it, so updates still reach the same add-on)'],
      [new RegExp(`${OLD_WORD('[-_]')}(-host\\.bat|\\.json)?`, 'g'), 'the old data folder, launcher and registration that install.ps1 moves and removes'],
      [/zen:\\?\/\\?\//g, 'the link scheme Claude writes for a tab or a file; the panel turns it into a link (lib/markdown.js)'],
      [/zen\.exe/g, 'the name of the program, where a comment or a lookup names it'],
    ];
    const ZEN_KEEP = {   // file (or a folder, ending in /) -> [pattern, why]
      'test/': [/\bzen\b/gi, 'the tests check the source, which still says Zen where it means the browser; friends do not read them'],
      'host/test/': [/\bzen\b/gi, 'the same: tests of the helper'],
      'extension/panel.js': [/\bzen\b/g, 'a local variable (the account email of the browser), not text'],
      'host/lib/localpages.js': [/^\s*\/\/.*$|'Zen Browser'|\|zen\|/gm, 'finds the browser to open local pages in, and Zen Browser is one it looks for; its comments say how'],
      'host/lib/updates.js': [/^\s*\/\/.*$|\bzen\b/gm, 'finds out whether a Zen profile links the add-on to the project folder (link.ps1); inert in a friends copy'],
      'host/lib/guard.js': [/^\s*\/\/.*$|'zen'|'\.zen'/gm, 'the protected folders: the Zen profile folders stay off-limits to Claude'],
    };
    const zenLeft = [];
    for (const f of walk(sf)) {
      const rel = path.relative(sf, f).split(path.sep).join('/');
      if (!/\.(js|json|html|css|svg|txt|md|bat|cmd|ps1|py)$/i.test(rel)) continue;
      let text = fs.readFileSync(f, 'latin1');
      for (const [re] of ZEN_KEEP_ANY) text = text.replace(re, '');
      for (const k of Object.keys(ZEN_KEEP)) if (k.endsWith('/') ? rel.startsWith(k) : rel === k) text = text.replace(ZEN_KEEP[k][0], '');
      text.split('\n').forEach((l, i) => { if (ZEN_WORD.test(l)) zenLeft.push(`${rel}:${i + 1} ${l.trim().slice(0, 90)}`); });
    }
    check('friends suite: no "Zen" is left in the copy outside the allowlist', zenLeft.length === 0, `${zenLeft.length} left: ${zenLeft.slice(0, 12).join(' | ')}`);
    const inner = spawnSync(process.execPath, [path.join(sf, 'test', 'run-all.js')], { cwd: sf, encoding: 'utf8', timeout: 600000,
      env: { ...process.env, CLAUDEFOX_FRIENDS_INNER: '1' } });
    const out = `${inner.stdout || ''}${inner.stderr || ''}`;
    const last = out.trim().split('\n').pop() || '';
    check('friends suite: the full suite passes on the branded copy', inner.status === 0 && /test file\(s\) passed/.test(last),
      inner.error ? inner.error.message : out.split('\n').filter(l => /^FAIL/.test(l)).join(' | ') || last);
  } finally { fs.rmSync(sf, { recursive: true, force: true }); }
}

console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
