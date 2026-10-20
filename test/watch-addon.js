'use strict';
// The video watcher's background side (extension/lib/bg-watch.js) with a faked browser and a faked video page: the
// gate, the watch window, spans of 30 s, near-duplicates dropped, sheets with times and captions, early stops,
// ads, the screenshot fallback, zooms, local files, Stop and closing everything.   node test/watch-addon.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${extra !== undefined ? '  ' + extra : ''}`); } };

// ---- a fake clock: waits in the add-on move it on at once
let clock = 1e12;
class FakeDate extends Date { static now() { return clock; } }

// ---- the fake video pages, one per tab
const pages = new Map();   // tabId -> page
const log = { windows: [], updates: [], removed: [], tabUpdates: [], opens: [], reads: 0, captures: 0, ops: [] };
const gray = v => new Array(144).fill(v);
function makePage(cfg) {
  return Object.assign({ found: true, duration: 65, title: 'A talk', captions: { source: 'none', note: 'none here', cues: [] },
    scene: t => ((Math.floor(t) * 37) % 200) + 20, rate: null, perCall: 160, installed: false, grabs: [] }, cfg);
}
async function pageOp(tabId, op, args) {
  const p = pages.get(tabId);
  if (!p) throw new Error('No tab');
  log.ops.push(`${tabId}:${op}`);
  if (op === 'probe') return p.found ? { found: true, title: p.title, duration: p.duration, live: !!p.live, protected: !!p.protected, rvfc: true, hidden: false }
    : { found: false, embeds: p.embeds || [], title: p.title };
  if (op === 'captions') return p.captions;
  if (op === 'stop') { p.stopped = true; return { stopped: true }; }
  if (op === 'restore') { p.restored = (p.restored || 0) + 1; return { restored: true }; }
  if (op === 'seekshow') { p.shows = (p.shows || 0) + 1; return { t: args.t, rect: { x: 0, y: 0, width: 640, height: 360 }, ad: false, caption: '' }; }
  if (op === 'grab') {
    p.grabs.push(args);
    if (p.hold) await p.hold;
    if (p.adOnce) { p.adOnce = false; return { frames: [], seen: [], next: args.t0, reached: args.t0, ad: true, waitingAd: true }; }
    if (p.taint) return { frames: [], seen: [], next: args.t0, tainted: true };
    if (p.stall && args.t0 >= p.stall.at) { p.stall.count = (p.stall.count || 0) + 1; return { frames: [], seen: [], next: args.t0, reached: args.t0, stalled: true }; }
    const frames = [];
    let t = args.t0;
    for (; t < Math.min(args.t1, p.duration + 1e-9) - 1e-3 && frames.length < Math.min(p.perCall, args.maxFrames); t = Math.round((t + args.step) * 1000) / 1000) {
      frames.push({ t, jpeg: 'data:image/jpeg;base64,RkZG', gray: gray(p.scene(t)) });
    }
    return { frames, seen: [], next: t, reached: t, ended: t >= p.duration - 1e-3, stalled: false, tainted: false, rate: p.rate || args.rate, ad: false, hidden: false };
  }
  throw new Error('op ' + op);
}

// ---- the fake browser
let nextWin = 100, nextTab = 500;
const tabs = new Map();   // id -> { id, url, windowId }
const wins = new Map();
const browser = {
  windows: {
    async create(o) {
      log.windows.push(o);
      if (o.url && /refuse-window/.test(o.url)) throw new Error('no windows');
      const id = nextWin++;
      let tabId;
      if (o.tabId != null) { tabId = o.tabId; tabs.get(tabId).windowId = id; }
      else {
        tabId = nextTab++;
        tabs.set(tabId, { id: tabId, url: o.url, windowId: id, status: 'complete' });
        pages.set(tabId, makePage(nextPageCfg));
      }
      wins.set(id, { id });
      return { id, tabs: [{ id: tabId }] };
    },
    async update(id, o) { log.updates.push({ id, ...o }); },
    async remove(id) { log.removed.push(id); wins.delete(id); for (const [k, t] of tabs) if (t.windowId === id) { tabs.delete(k); pages.delete(k); } },
  },
  tabs: {
    async get(id) { const t = tabs.get(Number(id)); if (!t) throw new Error('no tab'); return t; },
    async update(id, o) { log.tabUpdates.push({ id, ...o }); },
    async remove(id) { tabs.delete(id); pages.delete(id); },
    async query() { return []; },
    async captureTab() { log.captures++; return 'data:image/jpeg;base64,Q0FQ'; },
    async executeScript(tabId, { code }) {
      const install = code.includes('window.__cfxWatch = cfxWatchPage;');
      const p = pages.get(tabId);
      if (!p) throw new Error('Missing host permission for the tab');
      if (!install && !p.installed) return [{ __cfxNeedInstall: true }];
      if (install) p.installed = true;
      const m = /window\.__cfxWatch\(("(?:[^"\\]|\\.)*"), ([\s\S]*?)\)(?:;\n\}\)\(\);$| : \{ __cfxNeedInstall)/.exec(code);
      return [await pageOp(tabId, JSON.parse(m[1]), JSON.parse(m[2]))];
    },
  },
};
let nextPageCfg = {};

// ---- the fake canvas: records the text drawn on sheets
const drawn = [];
const fakeCanvas = () => {
  const c = { width: 0, height: 0 };
  c.getContext = () => ({
    set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
    fillRect() {}, drawImage() {}, strokeText() {},
    fillText(t) { drawn.push(String(t)); },
    measureText: t => ({ width: String(t).length * 8 }),
    getImageData: () => ({ data: new Uint8ClampedArray(144 * 4).fill(90) }),
  });
  c.toDataURL = () => 'data:image/jpeg;base64,U0hFRVQ=';
  return c;
};

const state = { watching: null, unsafe: false, localGrants: [] };
const ctx = vm.createContext({
  console, Date: FakeDate, Math, JSON, Promise, Error, Set, Map, Number, String, Array, Object, AbortController, Uint8ClampedArray,
  setTimeout: (f, ms) => (ms > 60000 ? { held: ms } : setTimeout(f, 0)), clearTimeout: t => { if (t && !t.held) clearTimeout(t); },
  browser, CFX_TOOLS: {}, CFX_FILE_ACCESS_OFF: 'Access local files is off.',
  cfxState: { get: () => state, set: async patch => Object.assign(state, patch), addLog: async () => {} },
  cfxSleep: ms => { clock += ms; return new Promise(r => setTimeout(r, 0)); },
  cfxWaitLoaded: async () => ({ loaded: true }),
  cfxGateOpts: () => ({}),
  cfxUrlBlocked: url => (/accounts\.google\.com/.test(url) ? { blocked: true, reason: 'Google sign-in pages are hands-off' }
    : /^file:/.test(url) ? (url.startsWith('file:///C:/ok/') ? { blocked: false, local: true } : { blocked: false, needGrant: 'C:\\no' }) : { blocked: false }),
  cfxOpenCheck: async url => { log.opens.push(url); if (/blocked-site/.test(url)) throw new Error('The user said no to this site.'); },
  cfxWindowTabUrl: async () => 'https://chat.example',
  cfxLocal: { fileAccess: async () => 'yes' },
  cfxLocalRead: () => { log.reads++; },
  document: { createElement: () => fakeCanvas() },
  createImageBitmap: async () => ({ width: 640, height: 360 }),
  fetch: async () => ({ blob: async () => ({}) }),
});
const ext = path.join(__dirname, '..', 'extension', 'lib');
for (const f of ['watchCore.js', 'watchPage.js', 'bg-watch.js']) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx, { filename: f });
const T = ctx.CFX_TOOLS;
const gated = a => Object.assign({ __gated: true }, a);
const errOf = async p => { try { await p; return ''; } catch (e) { return e.message; } };

(async () => {
  // ---- only the helper's own calls
  check('a call the helper did not make is refused', /goes through the helper/.test(await errOf(T.watch_run({ kind: 'url', url: 'https://v.example/a' }))));
  check('so is a zoom', /goes through the helper/.test(await errOf(T.watch_zoom_run({ watch_id: 'w1', start: 0, end: 5 }))));
  check('nothing opened for them', log.windows.length === 0);

  // ---- a 65 s talk: one frame a second, a still stretch from 20 to 40 s, captions from YouTube
  nextPageCfg = { duration: 65, title: 'A talk', scene: t => (t >= 20 && t < 40 ? 150 : ((Math.floor(t) * 37) % 200) + 20),
    captions: { source: 'youtube', label: 'English (auto-generated)', lang: 'en', auto: true, cues: [{ start: 1, end: 3, text: 'hello there' }, { start: 2.5, end: 4, text: 'there friends' }, { start: 41, end: 43, text: 'after the still part' }] } };
  drawn.length = 0;
  const r = await T.watch_run(gated({ kind: 'url', url: 'https://v.example/talk', start: 0, end: '', lang: 'en' }));
  const w0 = log.windows[0];
  check('the video opens in a small popup window of its own, off screen, without taking focus', w0 && w0.type === 'popup' && w0.focused === false && w0.url === 'https://v.example/talk' && w0.width <= 500 && w0.left >= 1280, JSON.stringify(w0));
  const tab = [...tabs.values()][0];
  check('its tab is muted', log.tabUpdates.some(u => u.id === tab.id && u.muted === true));
  check('the site goes through the chat\'s site check first', log.opens[0] === 'https://v.example/talk');
  const grabs = pages.get(tab.id).grabs;
  check('the video is caught in spans of 30 s, each starting where the last left off', grabs.map(g => g.t0).join(',') === '0,30,60' && grabs.every(g => g.step === 1 && g.rate === 4), grabs.map(g => `${g.t0}-${g.t1}`).join(' '));
  check('65 frames, 47 kept: the still 20 s keep their first frame and one heartbeat', /65 frames, 47 kept after dropping near-duplicates, in 3 sheets/.test(r.head), r.head.split('\n')[0]);
  check('three sheets, labelled with their times', r.sheets.length === 3 && r.sheets[0].label === 'Sheet 1 of 3: 0:00 to 0:20, 20 frames.' && r.sheets[2].label.startsWith('Sheet 3 of 3:') && r.sheets.every(s => s.mimeType === 'image/jpeg' && s.data === 'U0hFRVQ='), r.sheets.map(s => s.label).join(' | '));
  check('each frame has its time drawn, and each row what was said', drawn.includes('0:00') && drawn.includes('0:19') && drawn.some(t => t === '“hello there friends”') && drawn.includes('(nothing said)'), drawn.filter(t => /“/.test(t)).join(' | '));
  check('the summary names the captions and the watch_id, and how to zoom', /Captions: English \(auto-generated\), from YouTube\./.test(r.head) && /watch_id: w1\./.test(r.head) && /call watch_zoom with this watch_id/.test(r.head));
  check('the caption text has the rolled words once, with times', r.text.includes('Video title: A talk') && r.text.includes('[0:01] hello there friends') && r.text.includes('[0:41] after the still part'), JSON.stringify(r.text));
  check('afterwards the video is put back and its window minimised, held for zooms', pages.get(tab.id).restored >= 1 && log.updates.some(u => u.id === w0 && u.state === 'minimized' || u.state === 'minimized') && log.removed.length === 0);
  check('the watching status is cleared', state.watching === null);

  // ---- zooms
  const z = await T.watch_zoom_run(gated({ watch_id: 'w1', start: 10, end: 15 }));
  const zg = pages.get(tab.id).grabs.slice(-1)[0];
  check('a zoom catches four frames a second at 2x', zg.step === 0.25 && zg.rate === 2 && zg.t0 === 10 && zg.t1 === 15);
  check('20 frames in one sheet, with exact times', z.sheets.length === 1 && z.sheets[0].label === 'Sheet 1 of 1: 0:10.00 to 0:15.00, 20 frames.' && drawn.includes('0:10.25'), z.sheets[0] && z.sheets[0].label);
  check('the zoom says which one it is and what was said there', /^Zoom 1 of 10: 0:10\.00 to 0:15\.00, four frames a second: 20 frames in 1 sheet\./.test(z.head) && z.text === '(nothing said in this part)', z.head);
  check('the window comes back up for the zoom, off screen and without focus', log.updates.some(u => u.state === 'normal' && u.focused === undefined && u.left >= 1280));
  check('a zoom over 30 s is refused', /up to 30 s apart/.test(await errOf(T.watch_zoom_run(gated({ watch_id: 'w1', start: 0, end: 31 })))));
  check('a zoom past the end is refused', /only 1:05 long/.test(await errOf(T.watch_zoom_run(gated({ watch_id: 'w1', start: 70, end: 75 })))));
  check('an unknown watch_id is refused', /not open any more/.test(await errOf(T.watch_zoom_run(gated({ watch_id: 'w9', start: 0, end: 5 })))));
  for (let i = 2; i <= 10; i++) await T.watch_zoom_run(gated({ watch_id: 'w1', start: i, end: i + 1 }));
  check('an 11th zoom is refused', /had its 10 zooms/.test(await errOf(T.watch_zoom_run(gated({ watch_id: 'w1', start: 1, end: 2 })))));

  // ---- the window closed by the user: a zoom opens the video again
  nextPageCfg = { duration: 30 };
  const r2 = await T.watch_run(gated({ kind: 'url', url: 'https://v.example/short', start: 5, end: 12 }));
  check('start and end limit the watch', /Watched 0:05 to 0:12 of a 0:30 video/.test(r2.head), r2.head.split('\n')[0]);
  check('no captions: Claude is told so, and may mention the third-party skill but never installs it', /Captions: none\./.test(r2.head) && /third-party Claude Skill \(made by another developer, not by Claudefox/.test(r2.head) && /never install it/.test(r2.head));
  const t2 = [...tabs.values()].find(t => t.url === 'https://v.example/short');
  await browser.windows.remove(t2.windowId);
  const before = log.windows.length;
  await T.watch_zoom_run(gated({ watch_id: 'w2', start: 6, end: 8 }));
  check('a zoom after the window was closed opens the video again', log.windows.length === before + 1 && log.windows[before].url === 'https://v.example/short');

  // ---- refusals
  const wn = log.windows.length;
  check('a Google sign-in page is refused before anything opens', /Cannot watch this page: Google sign-in/.test(await errOf(T.watch_run(gated({ kind: 'url', url: 'https://accounts.google.com/x' })))) && log.windows.length === wn);
  check('a site the user said no to is refused before anything opens', /said no/.test(await errOf(T.watch_run(gated({ kind: 'url', url: 'https://blocked-site.example/v' })))) && log.windows.length === wn);
  check('only web pages and files', /web pages \(https\)/.test(await errOf(T.watch_run(gated({ kind: 'url', url: 'ftp://x.example/v' })))));
  for (const [cfg, re, name] of [[{ protected: true }, /protected \(DRM\)/, 'a protected video'], [{ live: true, duration: Infinity }, /live stream/, 'a live stream'],
    [{ found: false, embeds: ['https://www.youtube.com/embed/abc'] }, /embedded player\. Watch its own address instead: https:\/\/www\.youtube\.com\/embed\/abc/, 'a page with only an embedded player'],
    [{ found: false }, /No video was found/, 'a page without a video']]) {
    nextPageCfg = cfg;
    const msg = await errOf(T.watch_run(gated({ kind: 'url', url: 'https://v.example/' + name.replace(/\W/g, '') })));
    const last = log.windows[log.windows.length - 1];
    check(`${name} is refused and its window closed`, re.test(msg) && [...tabs.values()].every(t => t.url !== last.url), msg);
  }

  // ---- a stalled video: its window is brought forward once, then the watch stops early with where to go on from
  nextPageCfg = { duration: 90, stall: { at: 30 } };
  const r3 = await T.watch_run(gated({ kind: 'url', url: 'https://v.example/stall' }));
  const p3 = pages.get([...tabs.values()].find(t => t.url === 'https://v.example/stall').id);
  const moves = log.updates.filter(u => u.state === 'normal' && u.left < 1280);
  check('a stalled video: its window moves into the corner without focus, then comes to the front', p3.stall.count === 3 && moves.length === 2 && moves[0].focused === undefined && moves[1].focused === true, JSON.stringify(moves));
  check('then it stops early and says where to go on from', /Stopped early: the video stopped playing/.test(r3.head) && /Call watch_video again with start 0:29 for the rest/.test(r3.head) && /Watched 0:00 to 0:29/.test(r3.head), r3.head);

  // ---- an ad first
  nextPageCfg = { duration: 10, adOnce: true };
  const r4 = await T.watch_run(gated({ kind: 'url', url: 'https://v.example/ad' }));
  check('an ad is waited out and said', /An ad played first/.test(r4.head) && /10 frames/.test(r4.head), r4.head.split('\n')[0]);

  // ---- frames kept from the add-on: screenshots instead
  nextPageCfg = { duration: 6, taint: true };
  const caps = log.captures;
  const r5 = await T.watch_run(gated({ kind: 'url', url: 'https://v.example/taint' }));
  check('a site that keeps its frames from add-ons is caught with screenshots of the video', log.captures - caps === 6 && /frames are screenshots of the video/.test(r5.head) && /6 frames/.test(r5.head), r5.head.split('\n')[0]);

  // ---- a busy hour: as many sheets as one call returns, then where to go on from
  nextPageCfg = { duration: 1000, scene: t => (Math.floor(t) * 71) % 250 };
  const r6 = await T.watch_run(gated({ kind: 'url', url: 'https://v.example/busy' }));
  check('a busy long video stops at 40 sheets and says where to go on from', r6.sheets.length === 40 && /as many sheets as one call returns/.test(r6.head) && /start 13:20/.test(r6.head), r6.head);

  // ---- a local file: the helper opened its tab; it moves into the watch window
  tabs.set(9, { id: 9, url: 'file:///C:/ok/clip.mp4', windowId: 1 });
  pages.set(9, makePage({ duration: 4 }));
  const reads = log.reads;
  const r7 = await T.watch_run(gated({ kind: 'file', tab_id: 9, cues: [{ start: 0, end: 2, text: 'from the file' }], cueLabel: 'clip.vtt' }));
  const wf = log.windows[log.windows.length - 1];
  check('a local file\'s tab moves into the watch window, and the read is noted', wf.tabId === 9 && wf.type === 'popup' && log.reads === reads + 1);
  check('the subtitle file\'s captions are used', /Captions: clip\.vtt, from the subtitle file next to the video\./.test(r7.head) && r7.text.includes('[0:00] from the file'));
  tabs.set(10, { id: 10, url: 'file:///C:/elsewhere/x.mp4', windowId: 1 });
  check('a file outside the allowed folders is refused', /outside the folders the user allowed/.test(await errOf(T.watch_run(gated({ kind: 'file', tab_id: 10 })))));
  check('a file tab given as tab:<id> is sent to the file path route', /full path instead/.test(await errOf(T.watch_run(gated({ kind: 'tab', tab_id: 10 })))));

  // ---- one at a time, and Stop in the middle
  let release;
  nextPageCfg = { duration: 60, hold: new Promise(r => { release = r; }) };
  const ac = new AbortController();
  const running = T.watch_run(gated({ kind: 'url', url: 'https://v.example/long' }), ac.signal);
  await new Promise(r => setTimeout(r, 5));
  check('a second watch while one runs is refused', /Another video is being watched/.test(await errOf(T.watch_run(gated({ kind: 'url', url: 'https://v.example/other' })))));
  const tl = [...tabs.values()].find(t => t.url === 'https://v.example/long');
  ac.abort();
  release();
  const stopMsg = await errOf(running);
  check('Stop ends the watch, tells the page to stop and closes its window', stopMsg === 'Stopped' && pages.get(tl.id) === undefined && log.removed.includes(tl.windowId), stopMsg);

  // ---- closing everything
  const open = [...tabs.values()].filter(t => /v\.example/.test(t.url)).length;
  await ctx.cfxWatchCancelAll();
  check('Stop or the switch closes every watch window', open > 0 && [...tabs.values()].filter(t => /v\.example/.test(t.url)).length === 0);
  check('after that a zoom finds nothing open', /not open any more/.test(await errOf(T.watch_zoom_run(gated({ watch_id: 'w2', start: 0, end: 2 })))));

  console.log(`${pass} checks passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log(`FAIL ${e.stack || e}`); process.exit(1); });
