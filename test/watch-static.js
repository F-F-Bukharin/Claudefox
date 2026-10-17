'use strict';
// Static checks for the watch tool (the plan's Task 1 section "vendor", more sections come later).
// The vendored claude-video copy must carry no cookie handling, no cloud engine, no setup script and no reads of the user's settings.   node test/watch-static.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'host', 'vendor', 'claude-video');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };

// section vendor
const KEPT = ['watch.py', 'download.py', 'frames.py', 'transcribe.py', 'config.py', 'runtime.py'];
for (const f of ['gemini.py', 'whisper.py', 'local_whisperx.py', 'setup.py']) check(`${f} is gone`, !fs.existsSync(path.join(VENDOR, f)));
check('LICENSE and NOTICE.md are there', fs.existsSync(path.join(VENDOR, 'LICENSE')) && fs.existsSync(path.join(VENDOR, 'NOTICE.md')));
for (const f of KEPT) {
  const file = path.join(VENDOR, f);
  check(`${f} is there`, fs.existsSync(file));
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check(`${f}: no cookie handling`, !/cookie/i.test(text));
  check(`${f}: no network or cloud import`, !/urlopen|urllib\.request|import requests|httpx|import (gemini|whisper|local_whisperx|setup|groq|openai|genai|whisperx)\b/.test(text));
  check(`${f}: no removed-engine or setup.py text`, !/setup\.py|whisperx|groq|openai|gemini|WATCH_/i.test(text));
  check(`${f}: reads no environment, home folder or .env`, !/environ|Path\.home|expanduser|\.env\b/.test(text));
}
const py = spawnSync('python3', ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(VENDOR)}); import watch, download, frames, transcribe, config, runtime; print('imports ok')`], { encoding: 'utf8' });
if (!py.error) check('the vendored modules import under python3 -I', py.status === 0 && /imports ok/.test(py.stdout), (py.stderr || '').trim().split('\n').pop());

// section wiring (Task 7): the host hooks the permission card, the saved option and the handler
const HOST = fs.readFileSync(path.join(ROOT, 'host', 'claudefox-host.js'), 'utf8');
// The helper's main file is split by concern (host/lib): the add-on message cases stay in main; the wiring pieces may be in any lib module.
const HOST_ALL = [HOST, ...fs.readdirSync(path.join(ROOT, 'host', 'lib')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(ROOT, 'host', 'lib', f), 'utf8'))].join('\n');
for (const token of ['createWatchGate', "case 'watch_load'", "case 'watch_set_on_load'", "case 'watch_off'", "case 'watch_answer'", "case 'watch_shown'",
  'WATCH_ON_LOAD', "'watch_on_load'", "CLAUDEFOX_WATCH: '1'", 'watch: !improve']) {
  check(`host wires ${token}`, (token.startsWith('case ') || token.startsWith('"case ') ? HOST : HOST_ALL).includes(token));
}
check('paths.js defines WATCH_ON_LOAD', fs.readFileSync(path.join(ROOT, 'host', 'lib', 'paths.js'), 'utf8').includes('WATCH_ON_LOAD'));

// section version (Task 11): the add-on, the host and the tool server all say 0.11.0
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
check('the manifest version is 0.11.0', MANIFEST.version === '0.11.0');
check('the host says VERSION 0.11.0', /const VERSION = '0\.11\.0';/.test(HOST));
check('the tool server says VERSION 0.11.0', /const VERSION = '0\.11\.0';/.test(fs.readFileSync(path.join(ROOT, 'host', 'claudefox-mcp.js'), 'utf8')));

// section friends (Task 12): the setup files and the build stage. CRLF throughout; the PowerShell and .bat parts run on the PC.
if (fs.existsSync(path.join(ROOT, 'tools', 'xpi-tools.ps1'))) {   // a friends copy has no tools\ or friends\ folder
  const readText = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const PS1 = readText('tools/xpi-tools.ps1');
  const BAT = readText('friends/Set up Claudefox.bat');
  const START = readText('friends/START HERE.txt');
  const engineLine = PS1.split('\n').find(l => l.includes('host\\vendor\\claude-video')) || '';
  check('the build stage copies the claude-video engine, recursively', /-Recurse/.test(engineLine) && /Copy-Item/.test(engineLine));
  check('the setup check runs the Python, yt-dlp and ffmpeg checks', BAT.includes('py -3 -m yt_dlp --version') && BAT.includes('ffmpeg -version'));
  check('the setup check installs nothing: no line starts with winget', !BAT.split('\n').some(l => /^\s*winget/.test(l)));
  check('START HERE has the video section, with the ffmpeg package', START.includes('Video watching (optional)') && START.includes('Gyan.FFmpeg'));
  for (const [name, text] of [['xpi-tools.ps1', PS1], ['Set up Claudefox.bat', BAT], ['START HERE.txt', START]]) {
    check(`${name}: every line ends with CRLF`, text.split('\n').slice(0, -1).every(l => l.endsWith('\r')));
  }
}

console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
process.exit(failed ? 1 : 0);
