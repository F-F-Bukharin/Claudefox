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

// Rule 3: no content scripts or actions on Google sign-in.
const BLOCKED_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'myaccount.google.com',
  'gds.google.com',
];
const BLOCKED_PATH_PATTERNS = [
  { host: /(^|\.)google\.[a-z.]+$/, path: /^\/(signin|ServiceLogin|accounts)\b/i },
];

function cizUrlBlocked(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return { blocked: true, reason: 'unparseable URL' }; }
  if (!/^https?:$/.test(u.protocol)) {
    return { blocked: true, reason: `${u.protocol} pages are off-limits` };
  }
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    return { blocked: true, reason: 'Google sign-in pages are hands-off' };
  }
  for (const p of BLOCKED_PATH_PATTERNS) {
    if (p.host.test(host) && p.path.test(u.pathname)) {
      return { blocked: true, reason: 'Google sign-in pages are hands-off' };
    }
  }
  return { blocked: false };
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
