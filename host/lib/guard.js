'use strict';
// File-tool guard (plan rule 5): folders and files Claude never reads or changes, whatever folder the user picks.
//
// The panel chat's file tools are Claude Code's own Read, Glob, Grep, Edit and Write. They obey deny rules, so every
// chat turn gets a Read, an Edit and a Write rule per protected place (Grep and Glob
// skip it). On Windows, Claude Code matches paths in POSIX form, C:\Users\x -> //c/Users/x. The rules always apply,
// with file tools on or off. A folder inside a protected place is refused outright.

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const path = require('path');
const P = require('./paths');

// Files that hold keys, passwords or sessions, wherever they are.
const SECRET_FILES = [
  '.env', '.env.*', '*.kdbx', '*.kdb', '*.keyx', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '*.pem', '*.pfx', '*.p12',
  'key3.db', 'key4.db', 'logins.json', 'cookies.sqlite', 'cert9.db', 'Login Data', 'Login Data For Account', 'Cookies',
  'Web Data', '.git-credentials', '.netrc', '_netrc', '.npmrc', '.pypirc', '.credentials.json', 'pipe-token',
  '*.key', '*.ovpn', 'wallet.dat',
];

// Browser profiles (Zen first), Windows credential stores, Claude's own sign-ins, the usual key folders, chat apps,
// the GitHub CLI, PowerShell history and editor storage.
function protectedPlaces() {
  const home = os.homedir();
  const app = appDir(), local = localDir();
  return [
    path.join(app, 'zen'), path.join(local, 'zen'),
    path.join(app, 'Mozilla'), path.join(local, 'Mozilla'), path.join(home, '.mozilla'), path.join(home, '.zen'),
    path.join(local, 'Google', 'Chrome', 'User Data'), path.join(local, 'Microsoft', 'Edge', 'User Data'),
    path.join(local, 'BraveSoftware'), path.join(app, 'Opera Software'), path.join(local, 'Vivaldi'),
    path.join(home, '.config', 'google-chrome'), path.join(home, '.config', 'chromium'),
    path.join(app, 'Microsoft', 'Credentials'), path.join(local, 'Microsoft', 'Credentials'),
    path.join(app, 'Microsoft', 'Protect'), path.join(app, 'Microsoft', 'Vault'), path.join(local, 'Microsoft', 'Vault'),
    path.join(app, 'Microsoft', 'Crypto'), path.join(app, 'Microsoft', 'SystemCertificates'),
    path.join(home, '.claude'), path.join(home, '.claude.json'), path.join(app, 'Claude'),
    P.CLAUDE_CONFIG_DIR, P.ACCOUNTS_DIR, P.TOKEN_FILE, P.ACCOUNTS_FILE, P.LOG_DIR,
    path.join(P.BASE, 'tools.json'), path.join(P.BASE, 'mcp.json'), P.MCP_ARMY_CONFIG, P.ARMY_DIR, P.LOCAL_GRANTS, path.join(P.BASE, 'sign-in.cmd'), path.join(P.BASE, 'tool-sign-in.cmd'),
    path.join(home, '.ssh'), path.join(home, '.gnupg'), path.join(home, '.aws'), path.join(home, '.azure'),
    path.join(home, '.config', 'gcloud'), path.join(home, '.kube'), path.join(home, '.docker'),
    path.join(app, 'Bitwarden'), path.join(local, '1Password'), path.join(app, 'KeePass'), path.join(app, 'KeePassXC'),
    path.join(app, 'gnupg'),
    path.join(app, 'discord'), path.join(app, 'discordcanary'), path.join(app, 'discordptb'), path.join(app, 'Slack'),
    path.join(app, 'Telegram Desktop'), path.join(app, 'GitHub CLI'), path.join(app, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine'),
    path.join(app, 'Code', 'User', 'globalStorage'), path.join(app, 'Cursor', 'User', 'globalStorage'), path.join(app, 'VSCodium', 'User', 'globalStorage'),
    path.join(home, '.config', 'gh'),
  ];
}

const win = () => process.platform === 'win32';
const appDir = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const localDir = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

// Claude in Zen's own code: the folder this helper runs from, with the add-on, its mods and the tools. File tools may
// read it but never change it, whatever folder the user picks; changes go through Improve Claude in Zen, which works
// on a copy and needs the user's Apply.
const OWN = path.resolve(__dirname, '..', '..');

// The real spelling of a path (case and links resolved) when it exists; Claude Code checks both.
function real(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

// C:\Users\x -> /c/Users/x on Windows; unchanged elsewhere.
function posix(p) {
  const r = path.resolve(p);
  if (!win()) return r;
  return r.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');
}

const escapeRule = s => s.replace(/[()]/g, c => '\\' + c);

// Folders too broad for file tools and local pages: a drive root, the home folder, %APPDATA%, %LOCALAPPDATA%, and any
// folder that holds the helper's data folder.
function tooBroad(f) {
  return path.parse(f).root === f || [os.homedir(), appDir(), localDir()].map(real).some(b => same(f, b)) || within(real(P.BASE), f);
}

// The Documents folder: the registry's Personal value with %USERPROFILE% expanded, else %USERPROFILE%\Documents.
function documentsFolder(readPersonal) {
  const profile = process.env.USERPROFILE || os.homedir();
  const personal = readPersonal();
  return personal ? personal.replace(/%USERPROFILE%/gi, profile) : path.join(profile, 'Documents');
}

// The User Shell Folders value Personal (Windows), or '' when there is none.
function registryPersonal() {
  if (!win()) return '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'], { encoding: 'utf8', windowsHide: true });
    const m = /Personal\s+REG_\w+\s+(.+)/.exec(out);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// Deny rules for every chat turn (passed in --settings permissions.deny). A protected place gets Read, Edit and Write
// denies. The data folder, the Startup folder and the PowerShell profiles get Edit and Write denies: Windows and
// PowerShell run files there. readPersonal is the Documents lookup (the tests inject one).
function denyRules(readPersonal = registryPersonal) {
  const rules = new Set();
  const add = (v, file) => {
    const p = escapeRule(posix(v));
    for (const tool of ['Read', 'Edit', 'Write']) rules.add(file ? `${tool}(/${p})` : `${tool}(/${p}/**)`);
  };
  for (const place of protectedPlaces()) {
    const variants = new Set([path.resolve(place)]);
    if (fs.existsSync(place)) variants.add(real(place));
    for (const v of variants) {
      let file = false;
      try { file = fs.statSync(v).isFile(); } catch { file = /\.(json|cmd)$|pipe-token$/i.test(v); }
      add(v, file);
    }
  }
  for (const f of SECRET_FILES) rules.add(`Read(//**/${escapeRule(f)})`);
  for (const v of new Set([OWN, real(OWN)])) rules.add(`Edit(/${escapeRule(posix(v))}/**)`);   // Edit rules cover Write too
  const docs = documentsFolder(readPersonal);
  const noWrite = [P.BASE, path.join(appDir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), path.join(docs, 'WindowsPowerShell'), path.join(docs, 'PowerShell')];
  for (const v of noWrite) for (const d of new Set([path.resolve(v), real(v)])) {
    for (const tool of ['Edit', 'Write']) rules.add(`${tool}(/${escapeRule(posix(d))}/**)`);
  }
  return [...rules];
}

function same(a, b) { return win() ? a.toLowerCase() === b.toLowerCase() : a === b; }

function within(child, parent) {
  const c = path.resolve(child), p = path.resolve(parent);
  if (same(c, p)) return true;
  const rel = path.relative(win() ? p.toLowerCase() : p, win() ? c.toLowerCase() : c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Why a folder may not be used for file tools, or '' when it may. mode 'write': also not inside Claude in Zen's code.
function folderProblem(folder, mode) {
  const f = real(folder);
  for (const place of protectedPlaces()) {
    if (within(f, place) || within(f, real(place))) {
      return 'it holds browser, password or Claude sign-in data, which Claude never reads';
    }
  }
  if (within(f, P.BASE) && !within(f, P.WORKSPACE)) return "it is Claude in Zen's own data folder";
  if (tooBroad(f)) return `${path.resolve(folder)} is too broad for Claude: pick a folder inside it`;
  if (mode === 'write' && (within(f, OWN) || within(f, real(OWN)))) return "it holds Claude in Zen's own code, which file tools never change (use Read only, or Improve Claude in Zen)";
  return '';
}

// True when a file's name is one of SECRET_FILES (keys, passwords, sessions).
function secretFile(file) {
  const base = path.basename(file);
  return SECRET_FILES.some(pat => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', win() ? 'i' : '').test(base));
}

// True when a path may be read by Claude in Zen's own tools (read_document, attachments): inside one of the allowed
// folders and outside every protected place and secret file.
function readable(file, allowedFolders) {
  const f = real(file);
  if (!allowedFolders.some(d => d && within(f, real(d)))) return false;
  for (const place of protectedPlaces()) if (within(f, place) || within(f, real(place))) return false;
  return !secretFile(f);
}

// Local pages (lib/localpages.js): why Claude may not open, list or read this path (already resolved to its real
// spelling), or '' when it may once the user allows its folder. Same places as the file tools.
function localProblem(realPath, isDir) {
  const why = folderProblem(isDir ? realPath : path.dirname(realPath));
  if (why) return why;
  if (!isDir && secretFile(realPath)) return 'it is a file that holds keys, passwords or sign-ins, which Claude never opens';
  return '';
}

module.exports = { denyRules, folderProblem, readable, localProblem, secretFile, within, protectedPlaces, posix, SECRET_FILES, OWN };
