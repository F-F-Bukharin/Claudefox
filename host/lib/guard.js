'use strict';
// File-tool guard (plan rule 5): folders and files Claude never reads or changes, whatever folder the user picks.
//
// The panel chat's file tools are Claude Code's own Read, Glob, Grep, Edit and Write. They obey deny rules, so every
// chat turn gets one Read rule per protected place (a Read deny also blocks Edit and Write there, and Grep and Glob
// skip it). On Windows, Claude Code matches paths in POSIX form, C:\Users\x -> //c/Users/x. The rules always apply,
// with file tools on or off. A folder inside a protected place is refused outright.

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');

// Files that hold keys, passwords or sessions, wherever they are.
const SECRET_FILES = [
  '.env', '.env.*', '*.kdbx', '*.kdb', '*.keyx', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '*.pem', '*.pfx', '*.p12',
  'key3.db', 'key4.db', 'logins.json', 'cookies.sqlite', 'cert9.db', 'Login Data', 'Login Data For Account', 'Cookies',
  'Web Data', '.git-credentials', '.netrc', '_netrc', '.npmrc', '.pypirc', '.credentials.json', 'pipe-token',
];

// Browser profiles (Zen first), Windows credential stores, Claude's own sign-ins and the usual key folders.
function protectedPlaces() {
  const home = os.homedir();
  const app = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
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
    path.join(P.BASE, 'tools.json'), path.join(P.BASE, 'mcp.json'), P.MCP_ARMY_CONFIG, P.ARMY_DIR, path.join(P.BASE, 'sign-in.cmd'), path.join(P.BASE, 'tool-sign-in.cmd'),
    path.join(home, '.ssh'), path.join(home, '.gnupg'), path.join(home, '.aws'), path.join(home, '.azure'),
    path.join(home, '.config', 'gcloud'), path.join(home, '.kube'), path.join(home, '.docker'),
    path.join(app, 'Bitwarden'), path.join(local, '1Password'), path.join(app, 'KeePass'), path.join(app, 'KeePassXC'),
    path.join(app, 'gnupg'),
  ];
}

const win = () => process.platform === 'win32';

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

// Read deny rules for every chat turn (passed in --settings permissions.deny).
function denyRules() {
  const rules = new Set();
  for (const place of protectedPlaces()) {
    const variants = new Set([path.resolve(place)]);
    if (fs.existsSync(place)) variants.add(real(place));
    for (const v of variants) {
      let file = false;
      try { file = fs.statSync(v).isFile(); } catch { file = /\.(json|cmd)$|pipe-token$/i.test(v); }
      const p = escapeRule(posix(v));
      rules.add(file ? `Read(/${p})` : `Read(/${p}/**)`);
    }
  }
  for (const f of SECRET_FILES) rules.add(`Read(//**/${escapeRule(f)})`);
  return [...rules];
}

function same(a, b) { return win() ? a.toLowerCase() === b.toLowerCase() : a === b; }

function within(child, parent) {
  const c = path.resolve(child), p = path.resolve(parent);
  if (same(c, p)) return true;
  const rel = path.relative(win() ? p.toLowerCase() : p, win() ? c.toLowerCase() : c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Why a folder may not be used for file tools, or '' when it may.
function folderProblem(folder) {
  const f = real(folder);
  for (const place of protectedPlaces()) {
    if (within(f, place) || within(f, real(place))) {
      return 'it holds browser, password or Claude sign-in data, which Claude never reads';
    }
  }
  if (within(f, P.BASE) && !within(f, P.WORKSPACE)) return "it is Claude in Zen's own data folder";
  return '';
}

// True when a path may be read by Claude in Zen's own tools (read_document, attachments): inside one of the allowed
// folders and outside every protected place and secret file.
function readable(file, allowedFolders) {
  const f = real(file);
  if (!allowedFolders.some(d => d && within(f, real(d)))) return false;
  for (const place of protectedPlaces()) if (within(f, place) || within(f, real(place))) return false;
  const base = path.basename(f);
  for (const pat of SECRET_FILES) {
    const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', win() ? 'i' : '');
    if (re.test(base)) return false;
  }
  return true;
}

module.exports = { denyRules, folderProblem, readable, protectedPlaces, posix, SECRET_FILES };
