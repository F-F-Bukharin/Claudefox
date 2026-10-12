'use strict';
// Fixed safety rules (plan section 7). These hold even with open permissions.
// Loaded first by the background page; later phases (page actions, files)
// call into this before doing anything.

const CIZ = {
  NATIVE_HOST: 'claude_in_zen',          // HKCU\Software\Mozilla\NativeMessagingHosts\claude_in_zen
  DEBUG_PORT_URL: 'http://127.0.0.1:9222/',
  CLAUDE_ORIGIN: 'https://claude.ai',
  LOG_LIMIT: 200,
};

// Rule 3: no content scripts or actions on Google sign-in, unless the user turned on Unsafe mode
// (Settings, Permissions). Unsafe mode lifts this rule only: rule 1 (no non-web pages) and rule 2
// (no passwords, 2FA codes or payment details typed) still hold.
const BLOCKED_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'gds.google.com',
];
const BLOCKED_PATH_PATTERNS = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/(signin|ServiceLogin|accounts)\b/i },
];

const GOOGLE_HANDS_OFF = 'Google sign-in pages are hands-off (the user can turn on Unsafe mode in Settings)';

// Local pages (lib/local.js): a file: page is open to Claude only inside a folder the user allowed (opts.localGrants).
// Outside them the answer names the folder to ask about. Army workers never get this far (lib/tools.js).
function cizUrlBlocked(rawUrl, opts) {
  let u;
  try { u = new URL(rawUrl); } catch { return { blocked: true, reason: 'unparseable URL' }; }
  if (u.protocol === 'file:') {
    const path = cizFilePath(rawUrl);
    if (!path) return { blocked: true, reason: 'file: pages on network shares or odd paths are off-limits' };
    if (((opts && opts.localGrants) || []).some(f => cizInFolder(path, f))) return { blocked: false, local: true, path };
    // A URL ending in / is Zen's listing of a folder, so that folder is the one to ask about.
    const folder = /\/$/.test(u.pathname) ? path : cizFolderOf(path);
    return { blocked: true, needGrant: folder, path, reason: `the user has not allowed Claude to look in ${folder}` };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { blocked: true, reason: `${u.protocol} pages are off-limits` };
  }
  if (opts && opts.unsafe) return { blocked: false };
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    return { blocked: true, reason: GOOGLE_HANDS_OFF };
  }
  for (const p of BLOCKED_PATH_PATTERNS) {
    if (p.host.test(host) && p.path.test(u.pathname)) {
      return { blocked: true, reason: GOOGLE_HANDS_OFF };
    }
  }
  return { blocked: false };
}

// Seeing is not touching: screenshots may show about: pages (Firefox settings, about:config, about:support...),
// which add-ons can never read or act on, except the pages that list saved passwords. Web pages follow the rules
// above; file: pages follow the folder grants (cizUrlBlocked); moz-extension: and other non-web pages stay out.
const VIEW_BLOCKED_ABOUT = /^about:(logins|loginsimportreport|keychain|certificate)\b/i;

function cizViewBlocked(rawUrl, opts) {
  const url = String(rawUrl || '');
  if (/^about:/i.test(url)) {
    return VIEW_BLOCKED_ABOUT.test(url) ? { blocked: true, reason: 'that page shows saved passwords' } : { blocked: false, about: true };
  }
  return cizUrlBlocked(url, opts);
}

// ---- Paths on this computer. Pure functions, so tests can call them directly.
// Windows drive paths (either slash, compared without case) and POSIX paths. '.' and '..' are resolved, and '..'
// never climbs above the drive or /. Anything else (relative paths, network shares like \\server or //server, NUL) is null.

function cizPathParts(path) {
  const s = String(path == null ? '' : path);
  if (!s || s.includes('\0')) return null;
  const m = /^([A-Za-z]):[\\/]([\s\S]*)$/.exec(s);
  let drive = '', rest;
  if (m) { drive = m[1].toUpperCase(); rest = m[2].split(/[\\/]/); }
  // A POSIX path never holds a backslash here: file:///%5C%5Cserver/share would otherwise reach a network share on Windows.
  else if (s[0] === '/' && s[1] !== '/' && !s.includes('\\')) rest = s.slice(1).split('/');
  else return null;
  const segs = [];
  for (const seg of rest) {
    if (!seg || seg === '.') continue;
    if (seg === '..') segs.pop(); else segs.push(seg);
  }
  return { drive, segs };
}

function cizJoinPath(p) { return p.drive ? `${p.drive}:\\${p.segs.join('\\')}` : `/${p.segs.join('/')}`; }

// file:///C:/Users/H/game/index.html -> C:\Users\H\game\index.html; file:///home/f/game/index.html -> /home/f/game/index.html.
// null for other URLs and for a host other than localhost (no network shares).
function cizFilePath(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return null; }
  if (u.protocol !== 'file:') return null;
  if (u.hostname && u.hostname.toLowerCase() !== 'localhost') return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return null; }
  if (p.includes('\0')) return null;
  const win = /^\/([A-Za-z])[:|](?:[\\/]([\s\S]*))?$/.exec(p);
  const parts = cizPathParts(win ? `${win[1]}:\\${win[2] || ''}` : p);
  return parts ? cizJoinPath(parts) : null;
}

// A folder written one way: no trailing separator (except the root, C:\ or /). '' when it is not a full path.
function cizNormFolder(path) { const p = cizPathParts(path); return p ? cizJoinPath(p) : ''; }

// The folder a file is in.
function cizFolderOf(path) {
  const p = cizPathParts(path);
  if (!p) return '';
  p.segs.pop();
  return cizJoinPath(p);
}

function cizSamePath(a, b) {
  const pa = cizPathParts(a), pb = cizPathParts(b);
  if (!pa || !pb || pa.drive !== pb.drive) return false;
  return pa.drive ? cizJoinPath(pa).toLowerCase() === cizJoinPath(pb).toLowerCase() : cizJoinPath(pa) === cizJoinPath(pb);
}

// A folder holds itself and its subfolders, whole names only: C:\ab is not inside C:\a.
function cizInFolder(path, folder) {
  const pa = cizPathParts(path), pf = cizPathParts(folder);
  if (!pa || !pf || pa.drive !== pf.drive || pf.segs.length > pa.segs.length) return false;
  const same = pa.drive ? (x, y) => x.toLowerCase() === y.toLowerCase() : (x, y) => x === y;
  return pf.segs.every((seg, i) => same(seg, pa.segs[i]));
}

// Rule 2: never type passwords, 2FA codes or payment details.
// Used by the fill/type tools in P2 to refuse the field outright.
function cizSensitiveField(desc) {
  const type = String(desc.type || '').toLowerCase();
  if (type === 'password') return 'password field';
  const hay = [desc.name, desc.id, desc.autocomplete, desc.label, desc.placeholder]
    .filter(Boolean).join(' ').toLowerCase();
  if (/one-time-code|otp|2fa|totp|verification code|security code/.test(hay)) return '2FA code field';
  if (/cc-|card.?number|cardnumber|cvv|cvc|expir|iban|routing/.test(hay)) return 'payment field';
  if (/current-password|new-password|passwd|password/.test(hay)) return 'password field';
  return null;
}
