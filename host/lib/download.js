'use strict';
// Picture download core: saves a PNG, JPEG, GIF or WebP from a public address into a folder. Every hop is checked
// before a connection is made, and the connection is pinned to the checked address. The bytes, not the name or the
// header, decide the type. Size and time are capped, and nothing partial is ever left in the folder.
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const MB = 1024 * 1024;
const LOCAL = 'That address is inside this computer or its local network, so Claudefox will not fetch it.';
const NO_ADDRESS = 'That address could not be found.';
const BLOB = 'That picture exists only inside the page (blob: or data:), so it cannot be saved.';
const SCHEME = 'Only http and https addresses can be saved.';
const NOT_PIC = 'This is not a PNG, JPEG, GIF or WebP picture, so it was not saved.';
const NO_FOLDER = 'The folder is not there.';
const STOPPED = 'Stopped.';
const FAILED = 'The picture could not be downloaded.';
const TOO_MANY = 'Too many redirects.';
const REDIRECT_CODES = [301, 302, 303, 307, 308];
const noop = () => {};

// IPv4: this computer, private, shared, loopback, link-local, multicast and reserved space are refused.
function v4Allowed(ip) {
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168));
}

// The eight 16-bit groups of an IPv6 address; a dotted IPv4 tail becomes two groups first.
function groups(ip) {
  let s = ip;
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':') + 1;
    const o = s.slice(cut).split('.').map(Number);
    s = `${s.slice(0, cut)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(x => parseInt(x, 16));
}

function v6Allowed(ip) {
  const g = groups(ip);
  const zeros = n => g.slice(0, n).every(x => x === 0);
  if (zeros(5) && g[5] === 0xffff) return v4Allowed([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.'));
  if (zeros(6)) return false;                                                  // ::/96, which holds :: and ::1
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return false;  // 64:ff9b::/96
  const top = g[0];
  return !((top & 0xfe00) === 0xfc00                                           // fc00::/7
    || (top & 0xffc0) === 0xfe80                                               // fe80::/10
    || (top & 0xffc0) === 0xfec0                                               // fec0::/10
    || (top & 0xff00) === 0xff00);                                             // ff00::/8
}

// True only for an IP address in public space. A name is never allowed here: names are looked up and checked first.
function addressAllowed(ip) {
  const v = net.isIP(ip);
  if (v === 4) return v4Allowed(ip);
  if (v === 6) return v6Allowed(ip);
  return false;
}

// A URL the downloader may fetch, or the spec text that says why not.
function target(text) {
  let u;
  try { u = new URL(text); } catch { return { error: SCHEME }; }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return { error: BLOB };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: SCHEME };
  return { url: u };
}

// The first bytes decide the type; the name and the Content-Type header are ignored. Null when no picture matches.
function sniff(b) {
  const at = (s, o = 0) => b.length >= o + s.length && b.subarray(o, o + s.length).toString('latin1') === s;
  if (at('\x89PNG')) return { ext: '.png', type: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: '.jpg', type: 'image/jpeg' };
  if (at('GIF8')) return { ext: '.gif', type: 'image/gif' };
  if (at('RIFF') && at('WEBP', 8)) return { ext: '.webp', type: 'image/webp' };
  return null;
}

// The stem of the final URL's last segment: decoded, without its extension, unsafe characters turned into underscores.
function stemOf(u) {
  const seg = u.pathname.split('/').pop();
  let raw = seg;
  try { raw = decodeURIComponent(seg); } catch { /* a bad escape keeps the raw text */ }
  const dot = raw.lastIndexOf('.');
  return (dot >= 0 ? raw.slice(0, dot) : raw).replace(/[^A-Za-z0-9._ -]/g, '_');
}

// The name for the nth copy: the stem without leading or trailing dots and spaces, cut so that the whole name,
// " (n)" included, fits in 80 characters. An empty stem becomes "picture".
function fileName(stem, ext, n) {
  const suffix = n > 1 ? ` (${n})` : '';
  const trim = s => s.replace(/^[. ]+|[. ]+$/g, '');
  const base = trim(trim(stem).slice(0, 80 - ext.length - suffix.length)) || 'picture';
  return base + suffix + ext;
}

const sizeText = max => (max < MB
  ? `The picture is larger than ${Math.round(max / 1024)} KB.`
  : `The picture is larger than ${Math.round(max / MB)} MB.`);
const isDirectory = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// The host as it is dialled: a bracketed IPv6 literal loses its brackets.
const bareHost = u => u.hostname.replace(/^\[(.*)\]$/, '$1');
// A refusal whose text is shown to the user as it stands.
class Stop extends Error {}

// Every address the host resolves to, each one checked. A host with any refused address is refused as a whole.
async function checkedAddresses(job, host) {
  if (net.isIP(host)) {
    if (!addressAllowed(host)) throw new Stop(LOCAL);
    return [host];
  }
  let found;
  try { found = await job.lookup(host, { all: true }); } catch { throw new Stop(NO_ADDRESS); }
  const list = (Array.isArray(found) ? found : []).map(a => a.address);
  if (list.length === 0) throw new Stop(NO_ADDRESS);
  if (!list.every(a => addressAllowed(a))) throw new Stop(LOCAL);
  return list;
}

// The request's lookup answers with the dialled addresses, so the name is never resolved a second time.
function pin(dial) {
  const rows = dial.map(address => ({ address, family: net.isIP(address) }));
  return (host, options, callback) => {
    if (options && options.all) callback(null, rows);
    else callback(null, rows[0].address, rows[0].family);
  };
}

// One GET with only the User-Agent header, no agent, pinned to the dialled addresses.
function get(job, u, dial) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? job.transport.https : job.transport.http;
    const req = mod.request({
      method: 'GET',
      hostname: bareHost(u),
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers: { 'User-Agent': 'Claudefox' },
      agent: false,
      lookup: pin(dial),
    }, res => { res.on('error', noop); resolve(res); });
    job.destroy = () => req.destroy();
    req.on('error', reject);
    req.end();
  });
}

// Follows the hops: each one is checked before it is requested, redirects are counted, and the final body is read.
async function attempt(job, text, folder) {
  const first = target(text);
  if (first.error) throw new Stop(first.error);
  if (!isDirectory(folder)) throw new Stop(NO_FOLDER);
  let u = first.url;
  let redirects = 0;
  for (;;) {
    const dial = (await checkedAddresses(job, bareHost(u))).map(a => job.connectTo(a));
    if (job.halted) throw new Stop(job.halted);
    const res = await get(job, u, dial);
    const status = res.statusCode;
    if (REDIRECT_CODES.includes(status)) {
      res.destroy();
      if (!res.headers.location) throw new Stop(`The server did not send the picture (HTTP ${status}).`);
      if (redirects === job.maxRedirects) throw new Stop(TOO_MANY);
      redirects++;
      let next;
      try { next = target(new URL(res.headers.location, u).href); } catch { next = { error: SCHEME }; }
      if (next.error) throw new Stop(next.error);
      u = next.url;
      continue;
    }
    if (status < 200 || status > 299) {
      res.destroy();
      throw new Stop(`The server did not send the picture (HTTP ${status}).`);
    }
    return store(job, folder, u, await readBody(job, res));
  }
}

// The body in memory, up to maxBytes. The first 12 bytes decide the type as soon as they arrive, so a page is dropped
// there. Nothing touches the disk until the whole body has passed.
function readBody(job, res) {
  return new Promise((resolve, reject) => {
    if (Number(res.headers['content-length']) > job.maxBytes) {
      res.destroy();
      reject(new Stop(sizeText(job.maxBytes)));
      return;
    }
    const chunks = [];
    let total = 0;
    let kind = null;
    res.on('error', () => reject(new Stop(FAILED)));
    res.on('close', () => reject(new Stop(FAILED)));
    res.on('data', chunk => {
      total += chunk.length;
      if (total > job.maxBytes) { res.destroy(); reject(new Stop(sizeText(job.maxBytes))); return; }
      chunks.push(chunk);
      if (!kind && total >= 12) {
        kind = sniff(Buffer.concat(chunks));
        if (!kind) { res.destroy(); reject(new Stop(NOT_PIC)); }
      }
    });
    res.on('end', () => {
      const body = Buffer.concat(chunks);
      kind = kind || sniff(body);
      if (kind) resolve({ kind, body });
      else reject(new Stop(NOT_PIC));
    });
  });
}

// Writes the verified body to a temp file, links it under the first free name, and removes the temp file either way.
async function store(job, folder, u, { kind, body }) {
  if (job.halted) throw new Stop(job.halted);
  const stem = stemOf(u);
  const tmp = path.join(folder, `.claudefox-${crypto.randomBytes(8).toString('hex')}.part`);
  try {
    await fs.promises.writeFile(tmp, body, { flag: 'wx' });
    for (let n = 1; ; n++) {
      const final = path.join(folder, fileName(stem, kind.ext, n));
      try {
        await fs.promises.link(tmp, final);
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      if (job.halted) { await fs.promises.unlink(final).catch(noop); throw new Stop(job.halted); }
      return { ok: true, path: final, bytes: body.length, type: kind.type };
    }
  } finally {
    await fs.promises.unlink(tmp).catch(noop);
  }
}

// Never throws: every refusal and failure comes back as { ok: false, error } with the spec text. The first failure wins.
async function download(o, { url, folder, signal }) {
  const job = { ...o, halted: null, destroy: noop };
  let interrupt;
  const cut = new Promise((_, reject) => { interrupt = reject; });
  cut.catch(noop);
  const halt = message => {
    if (job.halted) return;
    job.halted = message;
    interrupt(new Stop(message));
    job.destroy();
  };
  const timer = setTimeout(() => halt(`The download took longer than ${Math.round(o.timeoutMs / 1000)} s.`), o.timeoutMs);
  const onAbort = () => halt(STOPPED);
  if (signal && signal.aborted) onAbort();
  else if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([attempt(job, url, folder), cut]);
  } catch (e) {
    return { ok: false, error: e instanceof Stop ? e.message : FAILED };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// The defaults are the spec's. Tests inject lookup, connectTo and transport.
function createDownloader(opts = {}) {
  const o = {
    lookup: host => dns.promises.lookup(host, { all: true }),
    maxBytes: 20 * MB,
    timeoutMs: 30000,
    maxRedirects: 3,
    transport: { http, https },
    connectTo: address => address,
    ...opts,
  };
  return { download: args => download(o, args || {}) };
}

module.exports = { createDownloader, addressAllowed };
