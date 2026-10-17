'use strict';
// Fixed safety rules (plan section 7). These hold even with open permissions.
// Loaded first by the background page; later phases (page actions, files)
// call into this before doing anything.

const CFX = {
  NATIVE_HOST: 'claudefox',              // HKCU\Software\Mozilla\NativeMessagingHosts\claudefox
  NATIVE_HOST_OLD: 'claude_in_zen',      // the registration before 0.11; the add-on tries it once when claudefox is missing (lib/bg-chat.js)
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
// Outside them the answer names the folder to ask about. Army workers never get this far (lib/pageTools.js).
// Each refusal also carries reasonKey (its bg_reason* text in the language files, which the panel shows) and reasonArg (the $1 of
// that text, when it has one). reason stays English: Claude reads it in tool errors.
function cfxUrlBlocked(rawUrl, opts) {
  let u;
  try { u = new URL(rawUrl); } catch { return { blocked: true, reason: 'unparseable URL', reasonKey: 'bg_reasonUnparseable' }; }
  if (u.protocol === 'file:') {
    const path = cfxFilePath(rawUrl);
    if (!path) return { blocked: true, reason: 'file: pages on network shares or odd paths are off-limits', reasonKey: 'bg_reasonFileShare' };
    if (((opts && opts.localGrants) || []).some(f => cfxInFolder(path, f))) return { blocked: false, local: true, path };
    // A URL ending in / is Zen's listing of a folder, so that folder is the one to ask about.
    const folder = /\/$/.test(u.pathname) ? path : cfxFolderOf(path);
    return { blocked: true, needGrant: folder, path, reason: `the user has not allowed Claude to look in ${folder}`, reasonKey: 'bg_reasonFolder', reasonArg: folder };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { blocked: true, reason: `${u.protocol} pages are off-limits`, reasonKey: 'bg_reasonProtocol', reasonArg: u.protocol };
  }
  if (opts && opts.unsafe) return { blocked: false };
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    return { blocked: true, reason: GOOGLE_HANDS_OFF, reasonKey: 'bg_reasonGoogle' };
  }
  for (const p of BLOCKED_PATH_PATTERNS) {
    if (p.host.test(host) && p.path.test(u.pathname)) {
      return { blocked: true, reason: GOOGLE_HANDS_OFF, reasonKey: 'bg_reasonGoogle' };
    }
  }
  return { blocked: false };
}

// Seeing is not touching: screenshots may show about: pages (Firefox settings, about:config, about:support...),
// which add-ons can never read or act on, except the pages that list saved passwords. Web pages follow the rules
// above; file: pages follow the folder grants (cfxUrlBlocked); moz-extension: and other non-web pages stay out.
const VIEW_BLOCKED_ABOUT = /^about:(logins|loginsimportreport|keychain|certificate)\b/i;

function cfxViewBlocked(rawUrl, opts) {
  const url = String(rawUrl || '');
  if (/^about:/i.test(url)) {
    return VIEW_BLOCKED_ABOUT.test(url) ? { blocked: true, reason: 'that page shows saved passwords', reasonKey: 'bg_reasonPasswords' } : { blocked: false, about: true };
  }
  return cfxUrlBlocked(url, opts);
}

// ---- Paths on this computer. Pure functions, so tests can call them directly.
// Windows drive paths (either slash, compared without case) and POSIX paths. '.' and '..' are resolved, and '..'
// never climbs above the drive or /. Anything else (relative paths, network shares like \\server or //server, NUL) is null.

function cfxPathParts(path) {
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

function cfxJoinPath(p) { return p.drive ? `${p.drive}:\\${p.segs.join('\\')}` : `/${p.segs.join('/')}`; }

// file:///C:/Users/you/game/index.html -> C:\Users\you\game\index.html; file:///home/you/game/index.html -> /home/you/game/index.html.
// null for other URLs and for a host other than localhost (no network shares).
function cfxFilePath(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return null; }
  if (u.protocol !== 'file:') return null;
  if (u.hostname && u.hostname.toLowerCase() !== 'localhost') return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return null; }
  if (p.includes('\0')) return null;
  const win = /^\/([A-Za-z])[:|](?:[\\/]([\s\S]*))?$/.exec(p);
  const parts = cfxPathParts(win ? `${win[1]}:\\${win[2] || ''}` : p);
  return parts ? cfxJoinPath(parts) : null;
}

// A folder written one way: no trailing separator (except the root, C:\ or /). '' when it is not a full path.
function cfxNormFolder(path) { const p = cfxPathParts(path); return p ? cfxJoinPath(p) : ''; }

// The folder a file is in.
function cfxFolderOf(path) {
  const p = cfxPathParts(path);
  if (!p) return '';
  p.segs.pop();
  return cfxJoinPath(p);
}

function cfxSamePath(a, b) {
  const pa = cfxPathParts(a), pb = cfxPathParts(b);
  if (!pa || !pb || pa.drive !== pb.drive) return false;
  return pa.drive ? cfxJoinPath(pa).toLowerCase() === cfxJoinPath(pb).toLowerCase() : cfxJoinPath(pa) === cfxJoinPath(pb);
}

// A folder holds itself and its subfolders, whole names only: C:\ab is not inside C:\a.
function cfxInFolder(path, folder) {
  const pa = cfxPathParts(path), pf = cfxPathParts(folder);
  if (!pa || !pf || pa.drive !== pf.drive || pf.segs.length > pa.segs.length) return false;
  const same = pa.drive ? (x, y) => x.toLowerCase() === y.toLowerCase() : (x, y) => x === y;
  return pf.segs.every((seg, i) => same(seg, pa.segs[i]));
}

// Rule 2: never type passwords, 2FA codes or payment details.
// Used by the fill/type tools in P2 to refuse the field outright.
// Self-contained: pageOp.js turns this function's source into the tab's script, so it may call no helper from this file.
function cfxSensitiveField(desc) {
  const type = String(desc.type || '').toLowerCase();
  if (type === 'password') return 'password field';
  // Lower case with accents removed: "cartão", "CARTAO" and "cartao" match alike. The words below have no accents.
  const hay = [desc.name, desc.id, desc.autocomplete, desc.label, desc.placeholder]
    .filter(Boolean).join(' ').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/one-time-code|otp|2fa|totp|verification code|security code|codigo de verificacao|codigo de seguranca|verificacao em duas etapas|codigo de acceso|codigo de verificacion/.test(hay)) return '2FA code field';
  if (/cc-|card.?number|cardnumber|cvv|cvc|expir|iban|routing|cartao|numero do cartao|nome no cartao|validade do cartao|vencimento|tarjeta|numero de tarjeta|fecha de vencimiento|titular/.test(hay)) return 'payment field';
  if (/current-password|new-password|passwd|password|senha|contrasena|clave/.test(hay)) return 'password field';
  return null;
}

// The site of a page address and the site-list match (used by the site gate, the page tools and the upload card).
// cfxSiteOf(url): lowercase host of an http(s) URL without one leading "www." and one trailing dot; IPv4, [IPv6] and localhost as they
// are; '' for anything else. cfxSiteMatch(list, site): an entry equals site or site ends with "." + entry (IPs, [IPv6], localhost: exact).
function cfxSiteOf(url) {
  const m = /^https?:\/\/([^\/?#\s]*)/i.exec(String(url == null ? '' : url).trim());
  if (!m) return '';
  let h = m[1].slice(m[1].lastIndexOf('@') + 1).toLowerCase();
  if (h.charAt(0) === '[') {
    const end = h.indexOf(']');
    return end < 0 ? '' : h.slice(0, end + 1);
  }
  h = h.replace(/:\d*$/, '').replace(/\.$/, '').replace(/^www\./, '');
  return /^[a-z0-9._-]+$/.test(h) ? h : '';
}

function cfxSiteMatch(list, site) {
  if (!site || !list) return false;
  const exact = site.charAt(0) === '[' || site === 'localhost' || /^\d+(\.\d+){3}$/.test(site);
  for (let i = 0; i < list.length; i++) {
    const e = String(list[i] || '').toLowerCase();
    if (!e) continue;
    if (e === site || (!exact && site.length > e.length && site.slice(-(e.length + 1)) === '.' + e)) return true;
  }
  return false;
}
