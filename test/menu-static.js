'use strict';
// Static checks for the setup menu (tools\menu.ps1 and its launcher). No PowerShell runs here, so these checks
// make sure the launcher and the menu use CRLF, point at files that exist, only read Zen's prefs.js, and only
// check that the API key variables are set (they never print them).   node test/menu-static.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const menu = read('tools/menu.ps1');
const launcher = read('tools/Claude in Zen menu.bat');
const lines = (text) => text.split(/\r?\n/);
let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed++;
  else { failed++; console.log('FAIL ' + name); }
}

check('the launcher starts menu.ps1 next to it in STA', /powershell[^\r\n]* -STA [^\r\n]*-File "%~dp0menu\.ps1"/.test(launcher));
check('the launcher keeps the window open when the menu fails', /if errorlevel 1 pause/.test(launcher));
check('menu.ps1 and the launcher use CRLF line endings', [menu, launcher].every(t => t.includes('\r\n') && !/[^\r]\n/.test(t)));

const scripts = [
  'host/install.ps1', 'zen-profile/link.ps1', 'zen-profile/apply.ps1', 'tools/build-xpi.ps1',
  'tools/install-xpi.ps1', 'tools/build-friends.ps1', 'tools/Sign in Claude Code.bat', 'tools/Sign add-on.bat',
  'tools/Load in Zen.bat', 'test/run-all.js',
];
for (const rel of scripts) {
  check('exists: ' + rel, fs.existsSync(path.join(root, rel)));
  check('the menu uses ' + path.basename(rel), menu.includes(path.basename(rel)));
}

const prefLines = lines(menu).filter(l => /prefs\.js/.test(l));
check('the menu reads prefs.js and never writes it', prefLines.length > 0 &&
  prefLines.every(l => !/Set-Content|Add-Content|Out-File|WriteAll|Copy-Item|Move-Item|Remove-Item/.test(l)));
const keyLines = lines(menu).filter(l => /\$env:WEB_EXT_API_/.test(l));
check('the menu only checks that the API key variables are set', keyLines.length > 0 &&
  keyLines.every(l => /-not \$env:WEB_EXT_API_(KEY|SECRET)/.test(l)));

console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
