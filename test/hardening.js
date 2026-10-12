'use strict';
// Hardening checks: the words that mark a password, 2FA or payment field (extension/lib/policy.js). No browser needed.
//   node test/hardening.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };

// policy.js is a plain script: load it into its own context, as test/dom-page-tools.js does.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'policy.js'), 'utf8') + '\nthis.cizSensitiveField = cizSensitiveField;', ctx);
const refusedAs = desc => ctx.cizSensitiveField(desc);

// Portuguese and Spanish words, each labelling a field that must be refused. Every spelling counts: as written,
// in capitals, and without accents.
const TERMS = [
  ['senha', 'password field'], ['contraseña', 'password field'], ['clave', 'password field'],
  ['código de verificação', '2FA code field'], ['código de segurança', '2FA code field'], ['verificação em duas etapas', '2FA code field'],
  ['código de acceso', '2FA code field'], ['código de verificación', '2FA code field'],
  ['cartão', 'payment field'], ['número do cartão', 'payment field'], ['nome no cartão', 'payment field'], ['validade do cartão', 'payment field'],
  ['vencimento', 'payment field'], ['CVV', 'payment field'], ['CVC', 'payment field'], ['tarjeta', 'payment field'],
  ['número de tarjeta', 'payment field'], ['fecha de vencimiento', 'payment field'], ['titular', 'payment field'],
];
const spellings = word => [word, word.toUpperCase(), word.normalize('NFD').replace(/[̀-ͯ]/g, '')];
for (const [word, kind] of TERMS) {
  const got = spellings(word).map(label => refusedAs({ type: 'text', label }));
  check(`a field labelled "${word}" is refused as a ${kind}`, got.every(k => k === kind), got.join(' | '));
}
check('an ordinary Portuguese "Nome" field is not refused', refusedAs({ type: 'text', label: 'Nome' }) === null);
check('an ordinary Portuguese "Endereço de entrega" field is not refused', refusedAs({ type: 'text', label: 'Endereço de entrega' }) === null);

// ---- The file guard (host/lib/guard.js). Its paths are read from the environment when used, and paths.js reads
// LOCALAPPDATA at load, so the profile variables point into a temp folder before guard is loaded.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(require('os').tmpdir(), 'ciz-harden-')));
const home = path.join(tmp, 'home'), appData = path.join(home, 'AppData', 'Roaming');
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
const guard = require('../host/lib/guard');
const put = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, name); fs.writeFileSync(f, 'x'); return fs.realpathSync(f); };
const allowed = [home];   // the user allowed the whole fake home for file tools
const docs = path.join(home, 'Documents');

// Each new protected folder: a file in it, and the folder itself, are refused.
const NEW_FOLDERS = [
  path.join(appData, 'discord'), path.join(appData, 'discordcanary'), path.join(appData, 'discordptb'), path.join(appData, 'Slack'),
  path.join(appData, 'Telegram Desktop'), path.join(appData, 'GitHub CLI'), path.join(appData, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine'),
  path.join(appData, 'Code', 'User', 'globalStorage'), path.join(appData, 'Cursor', 'User', 'globalStorage'),
  path.join(appData, 'VSCodium', 'User', 'globalStorage'), path.join(home, '.config', 'gh'),
];
for (const dir of NEW_FOLDERS) {
  const name = path.relative(tmp, dir), file = put(dir, 'state.json');
  check(`a file under ${name} is refused`, !guard.readable(file, allowed) && guard.localProblem(file, false) !== '', guard.localProblem(file, false));
  check(`the folder ${name} is refused outright`, guard.localProblem(fs.realpathSync(dir), true) !== '');
}

// Each new file pattern: a file with that name is refused wherever it sits.
for (const name of ['server.key', 'client.ovpn', 'wallet.dat']) {
  const file = put(docs, name);
  check(`a file named like ${name} is refused`, !guard.readable(file, allowed) && guard.localProblem(file, false) !== '' && guard.secretFile(file), guard.localProblem(file, false));
}

// An ordinary file in an ordinary folder is still allowed.
const notes = put(docs, 'notes.txt');
check('an ordinary file in Documents is still allowed', guard.readable(notes, allowed) && guard.localProblem(notes, false) === '' && guard.localProblem(fs.realpathSync(docs), true) === '');

// The chat's file tools get a Read deny rule for each new folder and pattern (guard.denyRules).
const rules = guard.denyRules();
check('the chat file tools deny every new folder and file pattern', NEW_FOLDERS.every(dir => rules.some(r => r.endsWith(`${path.basename(dir)}/**)`)))
  && ['*.key', '*.ovpn', 'wallet.dat'].every(p => rules.includes(`Read(//**/${p})`)));

// ---- Broad folders, the deny rules and the chat's settings sources (B1). Documents comes from an injected lookup.
const P = require('../host/lib/paths');
const chatargs = require('../host/lib/chatargs');
fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true });
const tooBroad = dir => `${path.resolve(dir)} is too broad for Claude: pick a folder inside it`;
const BROAD = [['a drive root', path.parse(tmp).root], ['the home folder', home], ['%APPDATA%', appData],
  ['%LOCALAPPDATA%', path.join(home, 'AppData', 'Local')], ['a folder that holds the data folder', path.join(home, 'AppData')], ['a folder above the data folder', tmp]];
for (const [what, dir] of BROAD) {
  const real = fs.realpathSync(dir);
  check(`${what} is too broad for file tools`, guard.folderProblem(real, 'read') === tooBroad(real), guard.folderProblem(real, 'read'));
  check(`${what} is too broad for local pages`, guard.localProblem(real, true) === tooBroad(real), guard.localProblem(real, true));
}
const INSIDE = [path.join(appData, 'Notes'), path.join(home, 'AppData', 'Local', 'Other'), path.join(home, 'Projects', 'site'), docs];
for (const dir of INSIDE) fs.mkdirSync(dir, { recursive: true });
check('folders inside them stay allowed', INSIDE.every(d => guard.folderProblem(fs.realpathSync(d), 'write') === '' && guard.localProblem(fs.realpathSync(d), true) === ''));

// Deny rules: a Read deny of a protected place has Edit and Write denies for the same path; the data folder, the Startup
// folder and the PowerShell profiles get Edit and Write denies. Documents comes from the lookup, or %USERPROFILE%\Documents.
const W = dir => [`Edit(/${guard.posix(dir)}/**)`, `Write(/${guard.posix(dir)}/**)`];
const custom = guard.denyRules(() => path.join('%USERPROFILE%', 'Docs Custom'));
const fallback = guard.denyRules(() => '');
const reads = custom.filter(r => r.startsWith('Read(/') && !r.startsWith('Read(//**/'));
check('every Read deny of a protected place has Edit and Write denies for the same path', reads.length > 0
  && guard.protectedPlaces().every(p => reads.some(r => r.includes(guard.posix(p))))
  && reads.every(r => custom.includes('Edit' + r.slice(4)) && custom.includes('Write' + r.slice(4))));
const STARTUP = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
check('the data folder, the Startup folder and the PowerShell profiles are denied Edit and Write', W(P.BASE).every(r => custom.includes(r))
  && W(STARTUP).every(r => custom.includes(r)) && ['WindowsPowerShell', 'PowerShell'].every(n => W(path.join(home, 'Docs Custom', n)).every(r => custom.includes(r))));
check('without a registry value the profiles are under %USERPROFILE%\\Documents', ['WindowsPowerShell', 'PowerShell'].every(n => W(path.join(docs, n)).every(r => fallback.includes(r))));

// Chat turns and army workers load only the user's own Claude Code settings.
const chatA = chatargs.chatArgs({ mode: 'write', folder: docs }, null, chatargs.MODELS.speed,
  { settingsFile: path.join(tmp, 'chat-settings.json'), mcpConfig: path.join(tmp, 'mcp.json') });
const workerA = chatargs.workerArgs(path.join(tmp, 'mcp-army.json'), path.join(tmp, 'worker-settings.json'), { extraTabs: 2, calls: 40, navs: 10, softMs: 600000 });
check('a chat turn passes --setting-sources user', chatA[chatA.indexOf('--setting-sources') + 1] === 'user', chatA.join(' '));
check('an army worker passes --setting-sources user', workerA[workerA.indexOf('--setting-sources') + 1] === 'user', workerA.join(' '));

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
