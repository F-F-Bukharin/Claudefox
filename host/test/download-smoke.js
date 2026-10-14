'use strict';
// Picture download core (lib/download.js): saves a PNG, JPEG, GIF or WebP from a public address, checking every hop,
// the bytes, the size and the time. The test server listens on 127.0.0.1; the test's lookup maps test hostnames to a
// public-looking address and connectTo maps that address back to 127.0.0.1, so the address check still runs on the
// looked-up address.   node host/test/download-smoke.js
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const PUBLIC = '93.184.216.34';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('gif-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('webp-body')]);

const table = {
  'pics.test': [PUBLIC], 'other.test': [PUBLIC], 'loop.test': ['127.0.0.1'], 'ten.test': ['10.0.0.5'],
  'lan.test': ['192.168.1.2'], 'v6.test': ['::1'], 'mapped.test': ['::ffff:127.0.0.1'], 'mixed.test': [PUBLIC, '127.0.0.1'],
};
const lookup = async h => {
  if (!table[h]) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; }
  return table[h].map(address => ({ address, family: net.isIP(address) }));
};
const dialled = [];
const connectTo = a => { dialled.push(a); return a === PUBLIC ? '127.0.0.1' : a; };

const failed = [];
let passed = 0;
const check = (name, ok, detail) => { if (ok) passed++; else failed.push(name + (detail ? ` (${detail})` : '')); };
const LOCAL = 'That address is inside this computer or its local network, so Claudefox will not fetch it.';
const NOT_PIC = 'This is not a PNG, JPEG, GIF or WebP picture, so it was not saved.';

// The test server: every route is described by the table below; hits are recorded with their headers.
const hits = [];
let counter = 0, busyHits = 0, busyAlways = 0;
const routes = {
  '/png': () => ({ type: 'image/png', body: PNG }),
  '/a/cat.jpg': () => ({ type: 'image/jpeg', body: PNG }),
  '/b/dog.png': () => ({ type: 'image/png', body: JPEG }),
  '/c/fish': () => ({ body: GIF }),
  '/d/tree.webp': () => ({ type: 'text/plain', body: WEBP }),
  '/html': () => ({ type: 'image/png', body: Buffer.from('<!doctype html><p>not a picture</p>') }),
  '/svg': () => ({ type: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>') }),
  '/headers': () => ({ body: PNG }),
  '/counter.png': () => ({ body: Buffer.concat([PNG, Buffer.from(`#${++counter}`)]) }),
  '/img/Sunset%20Beach%20%231.png': () => ({ body: Buffer.concat([PNG, Buffer.from(`#${++counter}`)]) }),
  '/': () => ({ body: PNG }),
  '/big-cl': () => ({ type: 'image/png', headers: { 'Content-Length': '5000' }, body: Buffer.alloc(5000) }),
  '/stall': () => ({ stall: true, body: PNG.subarray(0, 12) }),
  '/redir-local': () => ({ status: 302, headers: { Location: 'http://127.0.0.1:PORT/png' } }),
  '/redir-data': () => ({ status: 302, headers: { Location: 'data:image/png;base64,iVBORw0KGgo=' } }),
  '/redir-other': () => ({ status: 302, headers: { Location: 'http://other.test:PORT/png' } }),
  '/redir-ftp': () => ({ status: 302, headers: { Location: 'ftp://pics.test/x.png' } }),
  '/nolocation': () => ({ status: 302, body: Buffer.alloc(0) }),
  '/missing': () => ({ status: 404, body: Buffer.from('nope') }),
  '/busy-once.png': () => (++busyHits === 1 ? { status: 429, headers: { 'Retry-After': '1' }, body: Buffer.from('slow down') } : { body: PNG }),
  '/busy.png': () => { busyAlways++; return { status: 429, headers: { 'Retry-After': '1' }, body: Buffer.from('slow down') }; },
};
const routeFor = p => {
  if (routes[p]) return routes[p];
  const m = /^\/chain\/(\d+)$/.exec(p);
  if (m) return Number(m[1]) === 1 ? () => ({ status: 302, headers: { Location: '/png' } }) : () => ({ status: 302, headers: { Location: `/chain/${Number(m[1]) - 1}` } });
  if (p.startsWith('/long/')) return () => ({ body: PNG });
  if (/^\/big-stream/.test(p)) return () => ({ type: 'image/png', chunked: 8000, body: Buffer.concat([PNG, Buffer.alloc(8000)]) });
  return null;
};
const server = http.createServer((req, res) => {
  hits.push({ path: req.url, headers: req.headers });
  const make = routeFor(req.url.split('?')[0]);
  if (!make) { res.writeHead(404); res.end('no route'); return; }
  const r = make();
  if (r.stall) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.write(r.body); return; }
  const port = server.address().port;
  const headers = { ...(r.headers || {}) };
  for (const k of Object.keys(headers)) headers[k] = String(headers[k]).replace('PORT', port);
  if (r.type) headers['Content-Type'] = r.type;
  if (r.status) { res.writeHead(r.status, headers); res.end(r.body); return; }
  if (r.chunked) { res.writeHead(200, headers); const b = r.body; for (let i = 0; i < b.length; i += 1000) res.write(b.subarray(i, i + 1000)); res.end(); return; }
  res.writeHead(200, headers);
  res.end(r.body);
});

let lib = {};
try { lib = require('../lib/download.js'); } catch (e) { failed.push(`module loads (${e.code || e.message})`); }
const made = [];
const freshFolder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-download-')); made.push(d); return d; };
const listing = dir => fs.readdirSync(dir).sort();
const url = (p, host = 'pics.test') => `http://${host}:${server.address().port}${p}`;
const downloader = (over = {}) => lib.createDownloader({ lookup, connectTo, ...over });
const run = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, e.message); } };

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  await run('PNG, JPEG, GIF and WebP are saved by their bytes, not by their names or labels', async () => {
    const dir = freshFolder();
    const cases = [
      ['/a/cat.jpg', 'cat.png', PNG, 'image/png'],
      ['/b/dog.png', 'dog.jpg', JPEG, 'image/jpeg'],
      ['/c/fish', 'fish.gif', GIF, 'image/gif'],
      ['/d/tree.webp', 'tree.webp', WEBP, 'image/webp'],
    ];
    for (const [p, name, bytes, type] of cases) {
      const r = await downloader().download({ url: url(p), folder: dir });
      const kept = r.ok && fs.readFileSync(r.path).equals(bytes);
      check(`saves ${p} as ${name}`, r.ok === true && path.basename(r.path) === name && kept && r.bytes === bytes.length && r.type === type, r.error || JSON.stringify(r));
    }
    check('the folder holds exactly the four pictures', listing(dir).join() === ['cat.png', 'dog.jpg', 'fish.gif', 'tree.webp'].sort().join(), listing(dir).join());
  });

  await run('a page or an SVG labelled as a picture is refused and leaves no file', async () => {
    const dir = freshFolder();
    const html = await downloader().download({ url: url('/html'), folder: dir });
    const svg = await downloader().download({ url: url('/svg'), folder: dir });
    check('text/html labelled image/png is refused', html.ok === false && html.error === NOT_PIC, html.error);
    check('SVG is refused', svg.ok === false && svg.error === NOT_PIC, svg.error);
    check('no file or temp file is left behind', listing(dir).length === 0, listing(dir).join());
  });

  await run('blob:, data:, ftp:, file: and junk are refused with the spec text, without a request', async () => {
    const dir = freshFolder();
    const before = hits.length;
    const BLOB = 'That picture exists only inside the page (blob: or data:), so it cannot be saved.';
    const SCHEME = 'Only http and https addresses can be saved.';
    const got = [];
    for (const u of ['blob:https://pics.test/1234-5678', 'data:image/png;base64,iVBORw0KGgo=']) {
      got.push((await downloader().download({ url: u, folder: dir })).error === BLOB);
    }
    for (const u of ['ftp://pics.test/x.png', 'file:///etc/passwd', 'not a web address']) {
      got.push((await downloader().download({ url: u, folder: dir })).error === SCHEME);
    }
    check('each one gets the spec text', got.every(Boolean), got.join(' '));
    check('no request was made for them', hits.length === before, `${hits.length - before} request(s)`);
  });

  await run('a host that resolves to a private, loopback or link-local address is refused before any connection', async () => {
    const dir = freshFolder();
    const before = hits.length;
    dialled.length = 0;
    const got = [];
    for (const h of ['loop.test', 'ten.test', 'lan.test', 'v6.test', 'mapped.test', 'mixed.test']) {
      const r = await downloader().download({ url: url('/png', h), folder: dir });
      got.push(`${h}:${r.error === LOCAL}`);
    }
    check('each one gets the local-network text', got.every(g => g.endsWith(':true')), got.join(' '));
    check('no connection was made to any of them', dialled.length === 0 && hits.length === before, `dialled ${dialled.length}, requests ${hits.length - before}`);
    const dns = await downloader().download({ url: url('/png', 'nowhere.test'), folder: dir });
    check('a host that does not resolve gives an error, not a throw', dns.ok === false && typeof dns.error === 'string', JSON.stringify(dns));
    check('nothing was saved in the refused cases', listing(dir).length === 0, listing(dir).join());
  });

  await run('redirects: three are followed, a fourth is refused, and each hop is checked', async () => {
    const dir = freshFolder();
    const ok3 = await downloader().download({ url: url('/chain/3'), folder: dir });
    check('three redirects, then a picture: saved', ok3.ok === true && path.basename(ok3.path) === 'png.png', ok3.error || JSON.stringify(ok3));
    const four = await downloader().download({ url: url('/chain/4'), folder: dir });
    check('four redirects: Too many redirects.', four.error === 'Too many redirects.', four.error);
    const before = hits.length;
    const local = await downloader().download({ url: url('/redir-local'), folder: dir });
    check('a redirect to http://127.0.0.1 is refused', local.error === LOCAL, local.error);
    check('the loopback target was never requested', !hits.slice(before).some(h => h.path === '/png'));
    const data = await downloader().download({ url: url('/redir-data'), folder: dir });
    check('a redirect to data: is refused with the blob/data text', data.error === 'That picture exists only inside the page (blob: or data:), so it cannot be saved.', data.error);
    const ftp = await downloader().download({ url: url('/redir-ftp'), folder: dir });
    check('a redirect to ftp: is refused', ftp.error === 'Only http and https addresses can be saved.', ftp.error);
    const other = await downloader().download({ url: url('/redir-other'), folder: freshFolder() });
    check('a redirect to another public host is followed and checked', other.ok === true && path.basename(other.path) === 'png.png', other.error || JSON.stringify(other));
    const noLoc = await downloader().download({ url: url('/nolocation'), folder: dir });
    check('a redirect with no address: HTTP status text', noLoc.error === 'The server did not send the picture (HTTP 302).', noLoc.error);
    const missing = await downloader().download({ url: url('/missing'), folder: dir });
    check('HTTP 404: HTTP status text', missing.error === 'The server did not send the picture (HTTP 404).', missing.error);
  });

  await run('a picture over the size cap is refused by Content-Length, or aborted when it grows past it', async () => {
    const dir = freshFolder();
    const dl = downloader({ maxBytes: 4096 });
    const big = await dl.download({ url: url('/big-cl'), folder: dir });
    check('Content-Length over the cap: size text', big.error === 'The picture is larger than 4 KB.', big.error);
    const grows = await dl.download({ url: url('/big-stream'), folder: dir });
    check('a body that grows past the cap: same text', grows.error === 'The picture is larger than 4 KB.', grows.error);
    check('no partial file is left behind', listing(dir).length === 0, listing(dir).join());
  });

  await run('a stalled download stops at the time cap or at Stop, and leaves no partial file', async () => {
    const dir = freshFolder();
    const timed = await downloader({ timeoutMs: 1000 }).download({ url: url('/stall'), folder: dir });
    check('the time cap: time text', timed.error === 'The download took longer than 1 s.', timed.error);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const stopped = await downloader().download({ url: url('/stall'), folder: dir, signal: ac.signal });
    check('Stop: Stopped.', stopped.error === 'Stopped.', stopped.error);
    check('no partial file is left behind', listing(dir).length === 0, listing(dir).join());
  });

  await run('names: sanitized, extension from the bytes, never overwritten, capped at 80', async () => {
    const dir = freshFolder();
    const dl = downloader();
    const first = await dl.download({ url: url('/img/Sunset%20Beach%20%231.png'), folder: dir });
    check('sanitized to [A-Za-z0-9._ -]', first.ok === true && path.basename(first.path) === 'Sunset Beach _1.png', first.error || JSON.stringify(first));
    const firstBytes = first.ok && fs.readFileSync(first.path);
    const second = await dl.download({ url: url('/img/Sunset%20Beach%20%231.png'), folder: dir });
    check('a second save gets " (2)", the first file is untouched', second.ok === true && path.basename(second.path) === 'Sunset Beach _1 (2).png' && fs.readFileSync(first.path).equals(firstBytes), second.error || JSON.stringify(second));
    const empty = await dl.download({ url: url('/'), folder: dir });
    check('an empty name becomes picture', empty.ok === true && path.basename(empty.path) === 'picture.png', empty.error || JSON.stringify(empty));
    const long = await dl.download({ url: url('/long/' + 'a'.repeat(120) + '.gif'), folder: dir });
    check('capped at 80 characters, extension included', long.ok === true && path.basename(long.path) === 'a'.repeat(76) + '.png', long.error || JSON.stringify(long));
  });

  await run('no Cookie, Authorization or Referer; User-Agent Claudefox; https goes through transport.https', async () => {
    const dir = freshFolder();
    const seenHttp = [];
    const seenHttps = [];
    const transport = {
      http: { request: (opts, ...rest) => { seenHttp.push(opts); return http.request(opts, ...rest); } },
      https: { request: (opts, ...rest) => { seenHttps.push(opts); return http.request(opts, ...rest); } },
    };
    const r = await downloader({ transport }).download({ url: url('/png'), folder: dir });
    const hdr = (seenHttp[0] && seenHttp[0].headers) || {};
    const bad = Object.keys(hdr).filter(k => /^(cookie|authorization|referer)$/i.test(k));
    check('client sends a descriptive Claudefox User-Agent with a contact address, an Accept for pictures, and none of the three',
      r.ok === true && bad.length === 0 && hdr['User-Agent'] === lib.USER_AGENT && /^Claudefox\/\S+ \(.*https:\/\//.test(hdr['User-Agent']) && /image\//.test(hdr.Accept || ''), `${bad.join(',')} ${hdr['User-Agent']}`);
    const served = hits.filter(h => h.path === '/png').pop();
    check('the server sees the same', !!served && served.headers['user-agent'] === lib.USER_AGENT && !served.headers.cookie && !served.headers.authorization && !served.headers.referer);
    const s = await downloader({ transport }).download({ url: `https://pics.test:${server.address().port}/png`, folder: dir });
    check('https uses transport.https with the pinned lookup', s.ok === true && seenHttps.length === 1 && typeof seenHttps[0].lookup === 'function', s.error || `${seenHttps.length} https request(s)`);
  });

  await run('HTTP 429: one more try after the wait the site asks for, then a clear refusal', async () => {
    const dir = freshFolder();
    const t0 = Date.now();
    const once = await downloader({ retryCapMs: 60 }).download({ url: url('/busy-once.png'), folder: dir });
    check('a site that is busy once: the second try saves the picture', once.ok === true && busyHits === 2, once.error || JSON.stringify(once));
    check('the wait is capped by retryCapMs (Retry-After 1 s, cap 60 ms)', Date.now() - t0 < 900, `${Date.now() - t0} ms`);
    const always = await downloader({ retryCapMs: 30 }).download({ url: url('/busy.png'), folder: dir });
    check('a site that stays busy: tried twice, then the limit text', always.ok === false && always.error === lib.LIMITED && busyAlways === 2, `${always.error} ${busyAlways}`);
  });

  await run('a missing folder, or a file in its place, is refused', async () => {
    const dir = freshFolder();
    const file = path.join(dir, 'plain.txt');
    fs.writeFileSync(file, 'x');
    const a = await downloader().download({ url: url('/png'), folder: path.join(dir, 'not-there') });
    const b = await downloader().download({ url: url('/png'), folder: file });
    check('missing folder: The folder is not there.', a.error === 'The folder is not there.', a.error);
    check('a file in place of the folder: same text', b.error === 'The folder is not there.', b.error);
  });

  await run('addressAllowed follows the spec table', async () => {
    const rows = [
      ['93.184.216.34', true], ['8.8.8.8', true], ['100.63.255.255', true], ['100.128.0.1', true], ['172.15.255.255', true],
      ['172.32.0.1', true], ['192.167.1.1', true], ['223.255.255.255', true], ['2606:4700:4700::1111', true], ['::ffff:93.184.216.34', true],
      ['0.0.0.0', false], ['10.0.0.5', false], ['127.0.0.1', false], ['100.64.0.1', false], ['100.127.255.255', false],
      ['169.254.1.1', false], ['172.16.0.1', false], ['172.31.255.255', false], ['192.168.1.2', false], ['224.0.0.1', false],
      ['255.255.255.255', false], ['::', false], ['::1', false], ['fc00::1', false], ['fd12:3456::1', false], ['fe80::1', false],
      ['febf::1', false], ['ff02::1', false], ['::ffff:127.0.0.1', false], ['::ffff:10.0.0.5', false], ['::ffff:7f00:1', false],
      ['::ffff:192.168.1.2', false], ['pics.test', false],
    ];
    const wrong = rows.filter(([ip, want]) => lib.addressAllowed(ip) !== want).map(([ip]) => ip);
    check('addressAllowed table', wrong.length === 0, wrong.join(' '));
  });

  server.closeAllConnections();
  server.close();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  if (failed.length) {
    for (const f of failed) console.log(`FAIL  ${f}`);
    console.log(`${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`download-smoke: ${passed} checks passed`);
  process.exit(0);
}

main().catch(e => { console.log(`FAIL  harness: ${e.stack}`); process.exit(1); });
