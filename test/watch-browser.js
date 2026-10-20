'use strict';
// The video watcher's page side (extension/lib/watchPage.js) in a real browser, on a video made here: frame times,
// the grey thumbnails, dropping near-duplicates, 4-frames-a-second zooms, captions from a <track>, the screenshot
// fallback's frame on screen, and a video from another site without CORS (its frames are kept from the page).
// Optional: needs Playwright's Chromium and ffmpeg, and skips without them.   node test/watch-browser.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawnSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('SKIP playwright is not installed'); process.exit(0); }
if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) { console.log('SKIP ffmpeg is not installed'); process.exit(0); }

const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${extra !== undefined ? '  ' + extra : ''}`); } };

// The code the add-on injects, built by the add-on's own builder (lib/bg-watch.js), loaded with a stand-in tool table.
const ext = path.join(__dirname, '..', 'extension', 'lib');
const ctx = vm.createContext({ CFX_TOOLS: {}, console });
for (const f of ['watchCore.js', 'watchPage.js', 'bg-watch.js']) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx, { filename: f });
const script = (op, args) => vm.runInContext(`cfxWatchScript(${JSON.stringify(op)}, ${JSON.stringify(args || {})}, true)`, ctx);
const W = require('../extension/lib/watchCore');

// A 16 s video, 30 frames a second: its brightness says which second it is, and seconds 8 to 13 are all the same.
const level = s => (s >= 8 && s <= 13 ? 200 : (s * 37 + 20) % 256);
// What the browser shows for that brightness: the video's luma is limited range (16 to 235), the picture full range.
// A frame at the very end (16 s) shows the last second.
const shown = t => Math.min(255, Math.max(0, Math.round((level(Math.min(15, Math.floor(t + 0.02))) - 16) * 255 / 219)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-watch-browser-'));
made.push(dir);
const mk = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=320x180:r=30:d=16',
  '-vf', "geq=lum='if(between(T,8,13.999),200,mod(floor(T)*37+20,256))':cb=128:cr=128,format=yuv420p", '-c:v', 'libvpx', '-b:v', '300k', '-g', '30', path.join(dir, 'clip.webm')], { encoding: 'utf8', timeout: 90000 });
if (mk.status !== 0) { console.log(`SKIP ffmpeg could not make the test video: ${(mk.stderr || '').trim().split('\n').pop()}`); process.exit(0); }
fs.writeFileSync(path.join(dir, 'clip.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nfirst words\n\n00:00:09.000 --> 00:00:11.000\nthe still part\n');

function serve(cors) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('?')[0].slice(1)) || 'index.html';
      const file = path.join(dir, path.basename(name));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const type = { '.webm': 'video/webm', '.vtt': 'text/vtt', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream';
      const data = fs.readFileSync(file);
      const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) };
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const a = Number(m[1]), b = m[2] ? Number(m[2]) : data.length - 1;
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
        return res.end(data.subarray(a, b + 1));
      }
      res.writeHead(200, { ...headers, 'Content-Length': data.length });
      res.end(data);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const a = await serve(true), b = await serve(false);
  const other = `http://127.0.0.1:${b.address().port}/clip.webm`;
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Test clip</title><body style="margin:0"><video id="v" src="clip.webm" width="640" height="360">'
    + '<track kind="captions" src="clip.vtt" srclang="en" label="English"></video></body>');
  fs.writeFileSync(path.join(dir, 'taint.html'), `<!doctype html><title>Other site</title><body><video src="${other}" width="640" height="360"></video></body>`);
  let browser;
  const watchdog = setTimeout(() => { console.log('FAIL the checks did not finish within 100 s'); process.exit(1); }, 100000);
  try {
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
    const run = (op, args) => page.evaluate(script(op, args));
    await page.goto(`http://127.0.0.1:${a.address().port}/index.html`);
    await page.waitForFunction(() => document.getElementById('v').readyState >= 1, null, { timeout: 15000 });

    const p = await run('probe');
    check('probe finds the video, its length and the frame callback', p.found && Math.abs(p.duration - 16) < 0.3 && p.rvfc === true && p.title === 'Test clip', JSON.stringify(p));

    const c = await run('captions', { lang: 'en' });
    check('captions come from the video\'s <track>', c.source === 'track' && c.label === 'English' && c.cues.length === 2 && c.cues[1].text === 'the still part', JSON.stringify(c));

    const g = await run('grab', { t0: 0, t1: 16.5, step: 1, rate: 4, maxWallMs: 30000, maxFrames: 200 });
    const times = g.frames.map(f => f.t);
    check('one frame a second: 15 or 16 frames, each just after its second', g.frames.length >= 15 && g.frames.every(f => {
      const s = Math.round(f.t);
      return f.t >= s - 0.01 && f.t < s + 0.35;
    }), times.join(','));
    check('no two frames fall in the same second', new Set(g.frames.map(f => Math.round(f.t))).size === g.frames.length, times.join(','));
    check('the end of the video is reached', g.ended === true || g.next >= 16, JSON.stringify({ ended: g.ended, next: g.next }));
    const mean = gray => gray.reduce((x, y) => x + y, 0) / gray.length;
    const off = g.frames.filter(f => Math.abs(mean(f.gray) - shown(f.t)) > 12).map(f => `${f.t}:${Math.round(mean(f.gray))}/${shown(f.t)}`);
    check('each frame shows its own second (the grey thumbnail has that second\'s brightness)', off.length === 0, off.join(' '));
    check('frames are 320 x 180 JPEG pictures', g.frames.every(f => /^data:image\/jpeg;base64,/.test(f.jpeg)) && g.frames.every(f => f.gray.length === 144));
    const kept = W.keep(g.frames).map(i => Math.round(g.frames[i].t));
    check('the still stretch (8 to 13 s) keeps only its first frame', kept.includes(8) && ![9, 10, 11, 12, 13].some(s => kept.includes(s)) && kept.includes(14), kept.join(','));
    check('the video plays fast while watching (4x was kept)', g.rate === 4, g.rate);

    const z = await run('grab', { t0: 2, t1: 4, step: 0.25, rate: 2, maxWallMs: 20000, maxFrames: 100 });
    check('a zoom catches four frames a second: 8 frames over 2 s, each just after its quarter', z.frames.length === 8
      && z.frames.every((f, i) => f.t >= 2 + i * 0.25 - 0.01 && f.t < 2 + i * 0.25 + 0.2), z.frames.map(f => f.t).join(','));

    const sh = await run('seekshow', { t: 5 });
    check('the screenshot fallback shows the asked moment, with the video\'s box on screen', Math.abs(sh.t - 5) < 0.1 && sh.rect.width > 100 && sh.rect.height > 50, JSON.stringify(sh));

    const r = await run('restore');
    const after = await page.evaluate(() => ({ muted: document.getElementById('v').muted, rate: document.getElementById('v').playbackRate, paused: document.getElementById('v').paused }));
    check('restore puts the sound and the speed back, and leaves the video paused', r.restored && after.muted === false && after.rate === 1 && after.paused === true, JSON.stringify(after));

    await page.goto(`http://127.0.0.1:${a.address().port}/taint.html`);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 15000 });
    const t = await run('grab', { t0: 0, t1: 3, step: 1, rate: 2, maxWallMs: 10000, maxFrames: 10 });
    check('a video from another site without CORS: the page reports its frames are kept from it', t.tainted === true && t.frames.length === 0, JSON.stringify({ tainted: t.tainted, n: t.frames.length }));

    await page.goto(`http://127.0.0.1:${a.address().port}/clip.vtt`);
    const none = await run('probe');
    check('a page without a video says so', none.found === false);
  } catch (e) {
    fail++;
    console.log(`FAIL ${e.stack || e}`);
  } finally {
    clearTimeout(watchdog);
    if (browser) await browser.close().catch(() => {});
    a.close(); b.close();
  }
  console.log(`${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
