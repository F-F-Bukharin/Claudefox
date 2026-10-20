'use strict';
// Static checks for video watching (plan 2026-10-20-video-watching-native): nothing to install (no Python engine left),
// the add-on's watch tools only answer the helper's own calls, the wiring, the version and the friends files.   node test/watch-static.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// section native: the watcher lives in the add-on, and nothing runs Python, yt-dlp or ffmpeg any more
check('the vendored Python engine is gone', !fs.existsSync(path.join(ROOT, 'host', 'vendor', 'claude-video')));
check('the child-process runner is gone', !fs.existsSync(path.join(ROOT, 'host', 'lib', 'watchrun.js')));
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const shipped = [...walk(path.join(ROOT, 'extension')), ...walk(path.join(ROOT, 'host')).filter(f => !f.includes(`${path.sep}test${path.sep}`))]
  .filter(f => /\.(js|json|html|ps1|bat|txt)$/.test(f));
// The one place that may name them: the third-party notice Claude reads when a video has no captions (lib/bg-watch.js).
const NOTICE = /const CFX_WATCH_THIRD_PARTY = [^;]*;/;
const named = shipped.filter(f => /\bpython\b|yt-dlp|yt_dlp|ffmpeg|whisper/i.test(fs.readFileSync(f, 'utf8').replace(/text\/x-python/g, '').replace(NOTICE, '')));
check('no add-on or helper file names Python, yt-dlp, ffmpeg or Whisper (except the third-party notice)', named.length === 0, named.map(f => path.relative(ROOT, f)).join(', '));
const notice = (NOTICE.exec(read('extension/lib/bg-watch.js')) || [''])[0];
check('the third-party notice says it is made by another developer, not by Claudefox, and is never installed from here',
  /made by another developer/.test(notice) && /not by Claudefox/.test(notice) && /never install it/.test(notice));
const MANIFEST_SCRIPTS = JSON.parse(read('extension/manifest.json')).background.scripts;
const at = n => MANIFEST_SCRIPTS.indexOf(n);
check('the manifest loads watchCore, watchPage and bg-watch after pageTools and before the router',
  at('lib/watchCore.js') > at('lib/pageTools.js') && at('lib/watchPage.js') > at('lib/watchCore.js') && at('lib/bg-watch.js') > at('lib/watchPage.js') && at('lib/bg-router.js') > at('lib/bg-watch.js'));
const BGW = read('extension/lib/bg-watch.js'), PAGE = read('extension/lib/watchPage.js'), ROUTER = read('extension/lib/bg-router.js'), BGCHAT = read('extension/lib/bg-chat.js');
check('both add-on watch tools refuse a call the helper did not make', (BGW.match(/cfxWatchRefuseUngated\(args\);/g) || []).length === 2 && /args\.__gated !== true/.test(BGW));
check('the router drops a caller\'s own __gated and sets it only for the helper\'s gated calls',
  /hasOwnProperty\.call\(args, '__gated'\)\) \{ args = Object\.assign\(\{\}, args\); delete args\.__gated; \}/.test(ROUTER) && /if \(gated === true && !army\)/.test(ROUTER));
check('only the helper\'s message field makes a call gated', BGCHAT.includes('msg.gated === true') && !/__gated/.test(BGCHAT));
const HOSTMAIN = read('host/claudefox-host.js');
check('the helper marks only its two watch calls as gated', (HOSTMAIN.match(/\{ gated: true \}/g) || []).length === 2);
check('the watch window\'s tab is muted, and so is the video itself', /tabs\.update\(s\.tabId, \{ muted: true \}\)/.test(BGW) && /v\.muted = true;/.test(PAGE));
check('the watcher saves nothing: no downloads, no stored frames', !/browser\.downloads|storage\.(local|sync)\.set|indexedDB/.test(BGW + PAGE));
check('Stop and the switch end a watch and close its window', read('extension/lib/bg-permissions.js').split('cfxWatchCancelAll()').length === 3);
check('the add-on\'s watch tools are listed as reading tools', /'watch_run', 'watch_zoom_run'\]\);/.test(ROUTER));

// section wiring (Task 7): the host hooks the permission card, the saved option and the handler
const HOST = fs.readFileSync(path.join(ROOT, 'host', 'claudefox-host.js'), 'utf8');
// The helper's main file is split by concern (host/lib): the add-on message cases stay in main; the wiring pieces may be in any lib module.
const HOST_ALL = [HOST, ...fs.readdirSync(path.join(ROOT, 'host', 'lib')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(ROOT, 'host', 'lib', f), 'utf8'))].join('\n');
for (const token of ['createWatchGate', "case 'watch_load'", "case 'watch_set_on_load'", "case 'watch_off'", "case 'watch_answer'", "case 'watch_shown'",
  'WATCH_ON_LOAD', "'watch_on_load'", "CLAUDEFOX_WATCH: '1'", 'watch: !improve']) {
  check(`host wires ${token}`, (token.startsWith('case ') || token.startsWith('"case ') ? HOST : HOST_ALL).includes(token));
}
check('paths.js defines WATCH_ON_LOAD', fs.readFileSync(path.join(ROOT, 'host', 'lib', 'paths.js'), 'utf8').includes('WATCH_ON_LOAD'));

// section version: the add-on, the host and the tool server all say 0.12.0 (native video watching)
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
check('the manifest version is 0.12.0', MANIFEST.version === '0.12.0');
check('the host says VERSION 0.12.0', /const VERSION = '0\.12\.0';/.test(HOST));
check('the tool server says VERSION 0.12.0', /const VERSION = '0\.12\.0';/.test(fs.readFileSync(path.join(ROOT, 'host', 'claudefox-mcp.js'), 'utf8')));

// section friends (Task 12): the setup files and the build stage. CRLF throughout; the PowerShell and .bat parts run on the PC.
if (fs.existsSync(path.join(ROOT, 'tools', 'xpi-tools.ps1'))) {   // a friends copy has no tools\ or friends\ folder
  const readText = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const PS1 = readText('tools/xpi-tools.ps1');
  const BAT = readText('friends/Set up Claudefox.bat');
  const START = readText('friends/START HERE.txt');
  check('the build stage copies no vendored engine', !PS1.includes('host\\vendor'));
  check('the setup checks for no Python, yt-dlp or ffmpeg', !/py -3|yt_dlp|ffmpeg/i.test(BAT));
  check('the setup installs nothing: no line starts with winget', !BAT.split('\n').some(l => /^\s*winget/.test(l)));
  check('START HERE says video watching needs nothing installed', /Video watching\r\n/.test(START) && START.includes('Nothing to install') && !/python|yt-dlp|ffmpeg/i.test(START));
  for (const [name, text] of [['xpi-tools.ps1', PS1], ['Set up Claudefox.bat', BAT], ['START HERE.txt', START]]) {
    check(`${name}: every line ends with CRLF`, text.split('\n').slice(0, -1).every(l => l.endsWith('\r')));
  }

  // section flavours: this PC's install and the friends build each pick their own signed add-on (both are called Claudefox)
  const find = PS1.indexOf('function Find-SignedXpi');
  const FIND = find < 0 ? '' : PS1.slice(find, PS1.indexOf('\n}', find) + 2);
  check('Find-SignedXpi takes a mandatory Flavour, friends or local', /\[Parameter\(Mandatory\)\]\[ValidateSet\('friends', 'local'\)\]\[string\]\$Flavour\) \{/.test(FIND));
  check('Find-SignedXpi reads the update address: the friends build has one, this PC\'s build has none', /\$m -and \$m\.browser_specific_settings\.gecko\.update_url/.test(FIND)
    && /\$friends -eq \(\$Flavour -eq 'friends'\)/.test(FIND));
  check('Find-SignedXpi keeps the version match and the add-on name match', /\$m\.version -eq \$Version/.test(FIND) && /\$m\.name -eq \$Name/.test(FIND));
  check('brand.js writes gecko.update_url into the friends copy, which the friends flavour looks for', readText('tools/brand.js').includes('gecko.update_url'));
  // Every call names its flavour: the friends zip and the release want friends, this PC's install wants local.
  const calls = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'tools')).filter(f => f.endsWith('.ps1'))) {
    for (const line of readText(`tools/${f}`).split('\n')) {
      if (/Find-SignedXpi/.test(line) && !/^\s*(#|function )/.test(line)) calls.push({ file: f, flavour: (line.match(/'Claudefox' '(friends|local)'\s*$/) || [])[1] });
    }
  }
  check('three callers of Find-SignedXpi, each naming its flavour', calls.length === 3 && calls.every(c => c.flavour), JSON.stringify(calls));
  const flavourOf = f => calls.filter(c => c.file === f).map(c => c.flavour).join(',');
  check('build-friends.ps1 and prepare-release.ps1 want the friends build', flavourOf('build-friends.ps1') === 'friends' && flavourOf('prepare-release.ps1') === 'friends');
  check('install-xpi.ps1 wants this PC\'s build (local)', flavourOf('install-xpi.ps1') === 'local');
  for (const f of ['tools/build-friends.ps1', 'tools/install-xpi.ps1', 'tools/prepare-release.ps1']) {
    const t = readText(f);
    check(`${f}: every line ends with CRLF`, t.endsWith('\r\n') && !/[^\r]\n/.test(t));
  }
}

console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
process.exit(failed ? 1 : 0);
