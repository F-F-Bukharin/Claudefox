'use strict';
// Claudefox: debug tools for pages (network_log, console_log), without the debug port.
//
// network_log: the add-on watches requests with webRequest while the agent is active. Page loads and frames are
// always kept; every request type is kept for tabs Claude asked "all" for. Each hop of a redirect chain is its own
// entry. Only metadata is kept, in memory: method, URL (secret-looking query values hidden), status, redirect target,
// type, and the NAMES of cookies sent and set (with their flags), never a value, a header value or a body.
//
// console_log: on the first call for a tab, a small listener goes into that tab (and again after each reload while it
// is watched). It collects console messages and uncaught errors in the add-on's own content-script world.

const CFX_NET_MAX = 300;
const cfxNet = new Map();            // tabId -> entries (oldest first)
const cfxNetOpen = new Map();        // requestId -> the entry of the current hop
const cfxNetAll = new Set();         // tabs whose every request is kept
const cfxConsoleTabs = new Set();    // tabs whose console is watched
const CFX_SECRET_PARAM = /^(code|token|access_?token|id_?token|refresh_?token|auth|authuser_?token|authorization|key|api_?key|secret|client_?secret|password|passwd|pwd|pass|session|session_?id|sid|ssid|hsid|sig|signature|otp|state|nonce|ticket|jwt|bearer|credential|assertion|saml\w*|oauth\w*|x-?amz-\w+|tok|at)$/i;

// A URL with secrets hidden: user:password@, secret-named query and fragment values, and long token-like values.
function cfxRedactUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return String(raw || '').slice(0, 300); }
  if (u.username || u.password) { u.username = ''; u.password = ''; }
  const hide = (k, v) => CFX_SECRET_PARAM.test(k) || (v.length >= 32 && /^[A-Za-z0-9_\-.~+/=%]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v));
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

function cfxCookieNames(header) {
  return String(header || '').split(';').map(c => c.split('=')[0].trim()).filter(Boolean).slice(0, 60);
}

// "Set-Cookie: NID=abc; Domain=.google.com; Secure; SameSite=None" -> "NID (Domain=.google.com, Secure, SameSite=None)"
function cfxSetCookie(line) {
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

function cfxHeader(headers, name) {
  const h = (headers || []).filter(x => x && String(x.name).toLowerCase() === name);
  return h.map(x => String(x.value || '')).join('\n');
}

function cfxNetRecording(d) {
  if (d.tabId == null || d.tabId < 0) return false;
  if (typeof cfxState !== 'undefined' && cfxState.get && cfxState.get().agent !== 'active') return false;
  return d.type === 'main_frame' || d.type === 'sub_frame' || cfxNetAll.has(d.tabId);
}

function cfxNetPush(tabId, entry) {
  let list = cfxNet.get(tabId);
  if (!list) { list = []; cfxNet.set(tabId, list); }
  list.push(entry);
  if (list.length > CFX_NET_MAX) list.splice(0, list.length - CFX_NET_MAX);
}

const cfxNetListeners = {
  before(d) {
    if (!cfxNetRecording(d)) return;
    const e = { t: Math.round(d.timeStamp || Date.now()), method: d.method, url: cfxRedactUrl(d.url), type: d.type, frame: d.frameId || 0 };
    cfxNetOpen.set(d.requestId, e);
    cfxNetPush(d.tabId, e);
  },
  send(d) {
    const e = cfxNetOpen.get(d.requestId);
    if (!e) return;
    const sent = cfxCookieNames(cfxHeader(d.requestHeaders, 'cookie'));
    e.cookies_sent = sent.length ? sent : [];
  },
  headers(d) {
    const e = cfxNetOpen.get(d.requestId);
    if (!e) return;
    e.status = d.statusCode;
    const set = cfxHeader(d.responseHeaders, 'set-cookie').split('\n').map(cfxSetCookie).filter(Boolean).slice(0, 60);
    if (set.length) e.cookies_set = set;
    const type = cfxHeader(d.responseHeaders, 'content-type');
    if (type) e.content_type = type.split(';')[0].slice(0, 60);
  },
  redirect(d) {
    const e = cfxNetOpen.get(d.requestId);
    if (!e) return;
    e.status = d.statusCode;
    e.redirect_to = cfxRedactUrl(d.redirectUrl);
    cfxNetOpen.delete(d.requestId);   // the next hop is a new entry
  },
  done(d) {
    const e = cfxNetOpen.get(d.requestId);
    if (!e) return;
    e.status = d.statusCode;
    if (d.fromCache) e.from_cache = true;
    cfxNetOpen.delete(d.requestId);
  },
  error(d) {
    const e = cfxNetOpen.get(d.requestId);
    if (!e) return;
    e.error = String(d.error || 'failed').slice(0, 120);
    cfxNetOpen.delete(d.requestId);
  },
};

// The listeners the log keeps while the agent is active: cfxNetLogStart adds them (once), cfxNetLogStop removes them.
const cfxNetTabListeners = {
  removed: id => { cfxNet.delete(id); cfxNetAll.delete(id); cfxConsoleTabs.delete(id); },
  updated: (id, info, tab) => {
    if (info.status === 'loading' && cfxConsoleTabs.has(id)) cfxConsoleInject(tab || { id, url: info.url || '' }).catch(() => {});
  },
};
let cfxNetWr = null;   // the webRequest API the listeners are on, or null while they are off

function cfxNetLogStart() {
  const wr = typeof browser !== 'undefined' && browser.webRequest;
  if (!wr || cfxNetWr) return;
  cfxNetWr = wr;
  const filter = { urls: ['<all_urls>'] };
  try {
    wr.onBeforeRequest.addListener(cfxNetListeners.before, filter);
    wr.onSendHeaders.addListener(cfxNetListeners.send, filter, ['requestHeaders']);
    wr.onHeadersReceived.addListener(cfxNetListeners.headers, filter, ['responseHeaders']);
    wr.onBeforeRedirect.addListener(cfxNetListeners.redirect, filter);
    wr.onCompleted.addListener(cfxNetListeners.done, filter);
    wr.onErrorOccurred.addListener(cfxNetListeners.error, filter);
  } catch (e) { console.warn('network log unavailable', e); }
  if (browser.tabs && browser.tabs.onRemoved) browser.tabs.onRemoved.addListener(cfxNetTabListeners.removed);
  if (browser.tabs && browser.tabs.onUpdated) browser.tabs.onUpdated.addListener(cfxNetTabListeners.updated);
}

// Stop: the listeners go. A listener that cannot be removed is logged, not thrown, so Stop goes on past this call
// (as cfxNetLogStart logs a listener it cannot add).
function cfxNetLogStop() {
  const wr = cfxNetWr;
  if (!wr) return;
  cfxNetWr = null;
  try {
    wr.onBeforeRequest.removeListener(cfxNetListeners.before);
    wr.onSendHeaders.removeListener(cfxNetListeners.send);
    wr.onHeadersReceived.removeListener(cfxNetListeners.headers);
    wr.onBeforeRedirect.removeListener(cfxNetListeners.redirect);
    wr.onCompleted.removeListener(cfxNetListeners.done);
    wr.onErrorOccurred.removeListener(cfxNetListeners.error);
    if (browser.tabs && browser.tabs.onRemoved) browser.tabs.onRemoved.removeListener(cfxNetTabListeners.removed);
    if (browser.tabs && browser.tabs.onUpdated) browser.tabs.onUpdated.removeListener(cfxNetTabListeners.updated);
  } catch (e) { console.warn('network log: listeners not removed', e); }
}

// Stop: forget everything recorded and stop watching consoles; the listeners go too (cfxNetLogStop).
function cfxNetReset() {
  cfxNet.clear(); cfxNetOpen.clear(); cfxNetAll.clear(); cfxConsoleTabs.clear();
  cfxNetLogStop();
}

function cfxNetLog(tabId, args) {
  const a = args || {};
  if (a.detail === 'all') cfxNetAll.add(tabId);
  const limit = Math.min(Math.max(Math.round(Number(a.limit) || 60), 1), CFX_NET_MAX);
  const all = cfxNet.get(tabId) || [];
  const list = (a.detail === 'all' ? all : all.filter(e => e.type === 'main_frame' || e.type === 'sub_frame' || e.redirect_to)).slice(-limit);
  if (a.clear) { cfxNet.delete(tabId); for (const [k, e] of cfxNetOpen) if (all.includes(e)) cfxNetOpen.delete(k); }
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
const CFX_CONSOLE_HOOK = `(function () {
  if (window.__cfxConsole) return true;
  var buf = window.__cfxConsole = [];
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

async function cfxConsoleInject(tab) {
  const gate = cfxUrlBlocked(tab.url || '', { unsafe: !!cfxState.get().unsafe });
  if (gate.blocked) return false;
  await browser.tabs.executeScript(tab.id, { code: CFX_CONSOLE_HOOK, runAt: 'document_start' });
  return true;
}

async function cfxConsoleLog(tab, args) {
  const fresh = !cfxConsoleTabs.has(tab.id);
  cfxConsoleTabs.add(tab.id);
  await cfxConsoleInject(tab);
  const [list] = await browser.tabs.executeScript(tab.id, { code: `(function(){var b=window.__cfxConsole||[];var o=b.slice();${args && args.clear ? 'b.length=0;' : ''}return o;})();` });
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
