'use strict';
// Claude in Zen: debug tools for pages (network_log, console_log), without the debug port.
//
// network_log: the add-on watches requests with webRequest while the agent is active. Page loads and frames are
// always kept; every request type is kept for tabs Claude asked "all" for. Each hop of a redirect chain is its own
// entry. Only metadata is kept, in memory: method, URL (secret-looking query values hidden), status, redirect target,
// type, and the NAMES of cookies sent and set (with their flags), never a value, a header value or a body.
//
// console_log: on the first call for a tab, a small listener goes into that tab (and again after each reload while it
// is watched). It collects console messages and uncaught errors in the add-on's own content-script world.

const CIZ_NET_MAX = 300;
const cizNet = new Map();            // tabId -> entries (oldest first)
const cizNetOpen = new Map();        // requestId -> the entry of the current hop
const cizNetAll = new Set();         // tabs whose every request is kept
const cizConsoleTabs = new Set();    // tabs whose console is watched
const CIZ_SECRET_PARAM = /^(code|token|access_?token|id_?token|refresh_?token|auth|authuser_?token|authorization|key|api_?key|secret|client_?secret|password|passwd|pwd|pass|session|session_?id|sid|ssid|hsid|sig|signature|otp|state|nonce|ticket|jwt|bearer|credential|assertion|saml\w*|oauth\w*|x-?amz-\w+|tok|at)$/i;

// A URL with secrets hidden: user:password@, secret-named query and fragment values, and long token-like values.
function cizRedactUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return String(raw || '').slice(0, 300); }
  if (u.username || u.password) { u.username = ''; u.password = ''; }
  const hide = (k, v) => CIZ_SECRET_PARAM.test(k) || (v.length >= 32 && /^[A-Za-z0-9_\-.~+/=%]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v));
  const clean = params => {
    const out = [];
    for (const [k, v] of params) out.push(`${encodeURIComponent(k)}=${hide(k, v) ? '[hidden]' : encodeURIComponent(v).slice(0, 200)}`);
    return out.join('&');
  };
  const q = clean(u.searchParams);
  let frag = '';
  if (u.hash) frag = /=/.test(u.hash) ? '#' + clean(new URLSearchParams(u.hash.slice(1))) : u.hash.slice(0, 100);
  return `${u.origin}${u.pathname}${q ? '?' + q : ''}${frag}`.slice(0, 1200);
}

function cizCookieNames(header) {
  return String(header || '').split(';').map(c => c.split('=')[0].trim()).filter(Boolean).slice(0, 60);
}

// "Set-Cookie: NID=abc; Domain=.google.com; Secure; SameSite=None" -> "NID (Domain=.google.com, Secure, SameSite=None)"
function cizSetCookie(line) {
  const parts = String(line).split(';').map(s => s.trim());
  const name = (parts.shift() || '').split('=')[0].trim();
  if (!name) return '';
  const flags = [];
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    const key = k.trim().toLowerCase();
    const v = rest.join('=').trim();
    if (key === 'domain' || key === 'path' || key === 'samesite') flags.push(`${k.trim()}=${v.slice(0, 80)}`);
    else if (key === 'secure' || key === 'httponly' || key === 'partitioned') flags.push(k.trim());
    else if (key === 'max-age') flags.push(Number(v) <= 0 ? 'deleted (Max-Age<=0)' : 'persistent');
    else if (key === 'expires') flags.push(Date.parse(v) < Date.now() ? 'deleted (expired)' : 'persistent');
  }
  return `${name}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

function cizHeader(headers, name) {
  const h = (headers || []).filter(x => x && String(x.name).toLowerCase() === name);
  return h.map(x => String(x.value || '')).join('\n');
}

function cizNetRecording(d) {
  if (d.tabId == null || d.tabId < 0) return false;
  if (typeof cizState !== 'undefined' && cizState.get && cizState.get().agent !== 'active') return false;
  return d.type === 'main_frame' || d.type === 'sub_frame' || cizNetAll.has(d.tabId);
}

function cizNetPush(tabId, entry) {
  let list = cizNet.get(tabId);
  if (!list) { list = []; cizNet.set(tabId, list); }
  list.push(entry);
  if (list.length > CIZ_NET_MAX) list.splice(0, list.length - CIZ_NET_MAX);
}

const cizNetListeners = {
  before(d) {
    if (!cizNetRecording(d)) return;
    const e = { t: Math.round(d.timeStamp || Date.now()), method: d.method, url: cizRedactUrl(d.url), type: d.type, frame: d.frameId || 0 };
    cizNetOpen.set(d.requestId, e);
    cizNetPush(d.tabId, e);
  },
  send(d) {
    const e = cizNetOpen.get(d.requestId);
    if (!e) return;
    const sent = cizCookieNames(cizHeader(d.requestHeaders, 'cookie'));
    e.cookies_sent = sent.length ? sent : [];
  },
  headers(d) {
    const e = cizNetOpen.get(d.requestId);
    if (!e) return;
    e.status = d.statusCode;
    const set = cizHeader(d.responseHeaders, 'set-cookie').split('\n').map(cizSetCookie).filter(Boolean).slice(0, 60);
    if (set.length) e.cookies_set = set;
    const type = cizHeader(d.responseHeaders, 'content-type');
    if (type) e.content_type = type.split(';')[0].slice(0, 60);
  },
  redirect(d) {
    const e = cizNetOpen.get(d.requestId);
    if (!e) return;
    e.status = d.statusCode;
    e.redirect_to = cizRedactUrl(d.redirectUrl);
    cizNetOpen.delete(d.requestId);   // the next hop is a new entry
  },
  done(d) {
    const e = cizNetOpen.get(d.requestId);
    if (!e) return;
    e.status = d.statusCode;
    if (d.fromCache) e.from_cache = true;
    cizNetOpen.delete(d.requestId);
  },
  error(d) {
    const e = cizNetOpen.get(d.requestId);
    if (!e) return;
    e.error = String(d.error || 'failed').slice(0, 120);
    cizNetOpen.delete(d.requestId);
  },
};

// The listeners the log keeps while the agent is active: cizNetLogStart adds them (once), cizNetLogStop removes them.
const cizNetTabListeners = {
  removed: id => { cizNet.delete(id); cizNetAll.delete(id); cizConsoleTabs.delete(id); },
  updated: (id, info, tab) => {
    if (info.status === 'loading' && cizConsoleTabs.has(id)) cizConsoleInject(tab || { id, url: info.url || '' }).catch(() => {});
  },
};
let cizNetWr = null;   // the webRequest API the listeners are on, or null while they are off

function cizNetLogStart() {
  const wr = typeof browser !== 'undefined' && browser.webRequest;
  if (!wr || cizNetWr) return;
  cizNetWr = wr;
  const filter = { urls: ['<all_urls>'] };
  try {
    wr.onBeforeRequest.addListener(cizNetListeners.before, filter);
    wr.onSendHeaders.addListener(cizNetListeners.send, filter, ['requestHeaders']);
    wr.onHeadersReceived.addListener(cizNetListeners.headers, filter, ['responseHeaders']);
    wr.onBeforeRedirect.addListener(cizNetListeners.redirect, filter);
    wr.onCompleted.addListener(cizNetListeners.done, filter);
    wr.onErrorOccurred.addListener(cizNetListeners.error, filter);
  } catch (e) { console.warn('network log unavailable', e); }
  if (browser.tabs && browser.tabs.onRemoved) browser.tabs.onRemoved.addListener(cizNetTabListeners.removed);
  if (browser.tabs && browser.tabs.onUpdated) browser.tabs.onUpdated.addListener(cizNetTabListeners.updated);
}

// Stop: the listeners go. A listener that cannot be removed is logged, not thrown, so Stop goes on past this call
// (as cizNetLogStart logs a listener it cannot add).
function cizNetLogStop() {
  const wr = cizNetWr;
  if (!wr) return;
  cizNetWr = null;
  try {
    wr.onBeforeRequest.removeListener(cizNetListeners.before);
    wr.onSendHeaders.removeListener(cizNetListeners.send);
    wr.onHeadersReceived.removeListener(cizNetListeners.headers);
    wr.onBeforeRedirect.removeListener(cizNetListeners.redirect);
    wr.onCompleted.removeListener(cizNetListeners.done);
    wr.onErrorOccurred.removeListener(cizNetListeners.error);
    if (browser.tabs && browser.tabs.onRemoved) browser.tabs.onRemoved.removeListener(cizNetTabListeners.removed);
    if (browser.tabs && browser.tabs.onUpdated) browser.tabs.onUpdated.removeListener(cizNetTabListeners.updated);
  } catch (e) { console.warn('network log: listeners not removed', e); }
}

// Stop: forget everything recorded and stop watching consoles; the listeners go too (cizNetLogStop).
function cizNetReset() {
  cizNet.clear(); cizNetOpen.clear(); cizNetAll.clear(); cizConsoleTabs.clear();
  cizNetLogStop();
}

function cizNetLog(tabId, args) {
  const a = args || {};
  if (a.detail === 'all') cizNetAll.add(tabId);
  const limit = Math.min(Math.max(Math.round(Number(a.limit) || 60), 1), CIZ_NET_MAX);
  const all = cizNet.get(tabId) || [];
  const list = (a.detail === 'all' ? all : all.filter(e => e.type === 'main_frame' || e.type === 'sub_frame' || e.redirect_to)).slice(-limit);
  if (a.clear) { cizNet.delete(tabId); for (const [k, e] of cizNetOpen) if (all.includes(e)) cizNetOpen.delete(k); }
  const t0 = list.length ? list[0].t : 0;
  const lines = list.map(e => {
    const bits = [`+${((e.t - t0) / 1000).toFixed(2)}s`, e.method, e.status || (e.error ? 'ERR' : '…'), e.type === 'main_frame' ? 'page' : e.type, e.url];
    if (e.redirect_to) bits.push(`-> ${e.redirect_to}`);
    if (e.error) bits.push(`error: ${e.error}`);
    if (e.content_type) bits.push(`[${e.content_type}]`);
    if (e.from_cache) bits.push('(cache)');
    let line = bits.join(' ');
    if (e.cookies_sent) line += `\n    cookies sent: ${e.cookies_sent.length ? e.cookies_sent.join(', ') : 'none'}`;
    if (e.cookies_set) line += `\n    cookies set: ${e.cookies_set.join('; ')}`;
    return line;
  });
  const note = a.detail === 'all' && !all.some(e => e.type !== 'main_frame' && e.type !== 'sub_frame')
    ? 'Detailed recording starts now for this tab: reload or repeat the steps, then call again.' : '';
  return {
    title: `Network log of tab ${tabId}`, url: '',
    text: (lines.length ? lines.join('\n') : 'Nothing recorded for this tab yet. Recording covers page loads since the add-on started; reload or repeat the steps, then call again.')
      + (note ? `\n\n${note}` : ''),
    entries: list.length, recorded: all.length,
  };
}

// ---------------------------------------------------------------- console

// Runs in the tab's content-script world. Wraps the page's console methods (Firefox exportFunction) and keeps up to
// 500 messages; uncaught errors, failed promises and Content-Security-Policy blocks are kept too.
const CIZ_CONSOLE_HOOK = `(function () {
  if (window.__cizConsole) return true;
  var buf = window.__cizConsole = [];
  var fmt = function (v) {
    try {
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object' && 'message' in v && 'stack' in v) return String(v.name || 'Error') + ': ' + String(v.message) + (v.stack ? '\\n' + String(v.stack).split('\\n').slice(0, 4).join('\\n') : '');
      var s = JSON.stringify(v); return s === undefined ? String(v) : s;
    } catch (e) { try { return String(v); } catch (e2) { return '[object]'; } }
  };
  var push = function (level, args) {
    if (buf.length >= 500) return;
    var parts = []; for (var i = 0; i < args.length && i < 20; i++) parts.push(fmt(args[i]));
    buf.push({ t: Date.now(), level: level, text: parts.join(' ').slice(0, 2000) });
  };
  try {
    var page = window.wrappedJSObject;
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var orig = page.console[level];
      exportFunction(function () { push(level, arguments); return orig.apply(page.console, arguments); }, page.console, { defineAs: level });
    });
  } catch (e) {}
  window.addEventListener('error', function (e) { push('error', ['Uncaught ' + (e.message || 'error') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')]); }, true);
  window.addEventListener('unhandledrejection', function (e) { push('error', ['Unhandled promise rejection: ' + fmt(e.reason)]); });
  document.addEventListener('securitypolicyviolation', function (e) { push('error', ['Content Security Policy blocked ' + e.blockedURI + ' (' + e.violatedDirective + ')']); });
  return true;
})();`;

async function cizConsoleInject(tab) {
  const gate = cizUrlBlocked(tab.url || '', { unsafe: !!cizState.get().unsafe });
  if (gate.blocked) return false;
  await browser.tabs.executeScript(tab.id, { code: CIZ_CONSOLE_HOOK, runAt: 'document_start' });
  return true;
}

async function cizConsoleLog(tab, args) {
  const fresh = !cizConsoleTabs.has(tab.id);
  cizConsoleTabs.add(tab.id);
  await cizConsoleInject(tab);
  const [list] = await browser.tabs.executeScript(tab.id, { code: `(function(){var b=window.__cizConsole||[];var o=b.slice();${args && args.clear ? 'b.length=0;' : ''}return o;})();` });
  const items = Array.isArray(list) ? list : [];
  const t0 = items.length ? items[0].t : 0;
  return {
    title: tab.title || '', url: tab.url || '',
    text: items.length
      ? items.map(m => `+${((m.t - t0) / 1000).toFixed(2)}s ${m.level.toUpperCase()} ${m.text}`).join('\n')
      : fresh ? 'Now listening to this tab\'s console. Reload the page or repeat the steps, then call console_log again.' : 'No console messages since listening started.',
    messages: items.length,
  };
}
