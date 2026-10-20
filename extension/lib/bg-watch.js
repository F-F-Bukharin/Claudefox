'use strict';
// Claudefox: native video watching, the background side (plan docs/superpowers/plans/2026-10-20-video-watching-native.md).
// The helper asks first (host/lib/watchgate.js) and then calls watch_run or watch_zoom_run here, with gated set by the
// helper itself (lib/bg-chat.js): Claude cannot call these two directly.
//
// A watch opens the video in a small window of its own, muted, plays it fast and catches frames from the <video>
// element (lib/watchPage.js). Near-duplicate frames are dropped, the rest go into 5 x 4 sheets with the time on each
// frame and what was said under each row, and the captions go along as text. Nothing is saved to disk.

const CFX_WATCH_WIN = { width: 480, height: 320 };

// Where the watch window goes. It never takes focus. It starts just off the right edge of the screen, out of sight;
// Firefox stops video it thinks nobody can see, so if the video stalls there the window moves into the bottom-right
// corner (cfxWatchCatch), still without focus, and only as a last try comes to the front.
function cfxWatchPlace(where) {
  const sc = (typeof screen === 'object' && screen) || {};
  const L = Number(sc.availLeft) || 0, T = Number(sc.availTop) || 0, W = Number(sc.availWidth) || 1280, H = Number(sc.availHeight) || 720;
  if (where === 'off') return { left: L + W + 40, top: T + Math.max(0, H - CFX_WATCH_WIN.height - 40) };
  return { left: L + Math.max(0, W - CFX_WATCH_WIN.width - 16), top: T + Math.max(0, H - CFX_WATCH_WIN.height - 16) };
}
const CFX_WATCH_HOLD_MS = 5 * 60 * 1000;   // a watched video stays open (minimised) this long for watch_zoom
const cfxWatchSessions = new Map();         // watch_id -> session
const cfxWatchRuns = new Set();             // running watches: { cancel() }
let cfxWatchSeq = 0;

// ---------------------------------------------------------------- the code put in the video's tab

function cfxWatchPageBody() {
  if (cfxWatchPageBody.text) return cfxWatchPageBody.text;
  const parts = [cfxWatchSampler, cfxWatchPickTrack, cfxWatchJson3, cfxWatchPage];
  return (cfxWatchPageBody.text = 'var cfxWatchSquash = ' + cfxWatchSquash.toString() + ';\n' + parts.map(f => f.toString() + '\n').join(''));
}
function cfxWatchPageVersion() {
  if (cfxWatchPageVersion.v) return cfxWatchPageVersion.v;
  let h = 0x811c9dc5;
  const b = cfxWatchPageBody();
  for (let i = 0; i < b.length; i++) { h ^= b.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (cfxWatchPageVersion.v = h.toString(36) + '.' + b.length.toString(36));
}
function cfxWatchScript(op, args, install) {
  const call = 'window.__cfxWatch(' + JSON.stringify(op) + ', ' + JSON.stringify(args || {}) + ')';
  if (install) {
    return '(function () {\n' + cfxWatchPageBody() + 'window.__cfxWatch = cfxWatchPage;\nwindow.__cfxWatchV = '
      + JSON.stringify(cfxWatchPageVersion()) + ';\nreturn ' + call + ';\n})();';
  }
  return '(function () { return window.__cfxWatchV === ' + JSON.stringify(cfxWatchPageVersion())
    + ' && typeof window.__cfxWatch === "function" ? ' + call + ' : { __cfxNeedInstall: true }; })();';
}
async function cfxWatchIn(tabId, op, args) {
  const run = async install => {
    try {
      const res = await browser.tabs.executeScript(tabId, { code: cfxWatchScript(op, args, install), runAt: 'document_idle' });
      return res && res[0];
    } catch (e) {
      const why = String((e && e.message) || e).replace(/^Error:\s*/, '');
      if (/permission|not allowed|denied|cannot access/i.test(why)) {
        let url = '';
        try { url = (await browser.tabs.get(tabId)).url || ''; } catch {}
        if (/^file:/i.test(url)) throw new Error(CFX_FILE_ACCESS_OFF);
      }
      throw new Error(why);
    }
  };
  const first = await run(false);
  return first && first.__cfxNeedInstall === true ? run(true) : first;
}

// ---------------------------------------------------------------- the window

async function cfxWatchOpen(src) {
  let win;
  if (src.tabId != null) {
    // A tab made for this watch (a local file the helper opened): moved into the watch window.
    try { win = await browser.windows.create(Object.assign({ tabId: src.tabId, type: 'popup', focused: false }, CFX_WATCH_WIN, cfxWatchPlace('off'))); }
    catch { return { windowId: null, tabId: src.tabId, moved: false }; }
    return { windowId: win.id, tabId: src.tabId, moved: true };
  }
  win = await browser.windows.create(Object.assign({ url: src.url, type: 'popup', focused: false }, CFX_WATCH_WIN, cfxWatchPlace('off')));
  const tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : (await browser.tabs.query({ windowId: win.id }))[0].id;
  return { windowId: win.id, tabId, moved: false };
}

async function cfxWatchClose(s) {
  if (!s) return;
  clearTimeout(s.holdTimer);
  try { await cfxWatchIn(s.tabId, 'restore', {}); } catch {}
  try {
    if (s.windowId != null) await browser.windows.remove(s.windowId);
    else if (s.ownsTab) await browser.tabs.remove(s.tabId);
  } catch {}
  cfxWatchSessions.delete(s.id);
}

function cfxWatchHold(s) {
  clearTimeout(s.holdTimer);
  s.holdTimer = setTimeout(() => cfxWatchClose(s), CFX_WATCH_HOLD_MS);
}

async function cfxWatchAlive(s) {
  try { const t = await browser.tabs.get(s.tabId); return !!t && (s.windowId == null || t.windowId === s.windowId); } catch { return false; }
}

// Finds the video once the page has loaded (players load late): up to 20 s.
async function cfxWatchFind(tabId, signal) {
  const until = Date.now() + 20000;
  let p = null;
  while (Date.now() < until) {
    if (signal && signal.aborted) throw new Error('Stopped');
    try { p = await cfxWatchIn(tabId, 'probe', {}); } catch (e) { if (/Access local files/.test(e.message)) throw e; p = null; }
    if (p && p.found && (p.duration > 0 || p.live || p.protected)) return p;
    await cfxSleep(500);
  }
  if (p && !p.found && p.embeds && p.embeds.length) {
    throw new Error(`The video on this page is in an embedded player. Watch its own address instead: ${p.embeds.join(' , ')}`);
  }
  throw new Error(p && p.found ? 'The video did not load within 20 seconds.' : 'No video was found on this page.');
}

// ---------------------------------------------------------------- catching frames

// Plays from t0 to t1 and catches a frame every step, in spans of 30 s of video. A YouTube ad is waited out. A site
// that keeps its frames from the add-on (the video is from another site without CORS) is caught with screenshots
// instead (cfxWatchShots). Returns { frames, seen, partial, notes, rate }.
async function cfxWatchCatch(s, t0, t1, step, opts, signal) {
  const o = Object.assign({ rate: 4, maxWallMs: 600000, maxFrames: 2400 }, opts || {});
  const frames = [], seen = [], notes = new Set();
  let next = t0, rate = o.rate, adWaits = 0, shown = 0, partial = '';
  const began = Date.now();
  while (next < t1 - 1e-3) {
    if (signal && signal.aborted) throw new Error('Stopped');
    if (Date.now() - began > o.maxWallMs) { partial = 'time'; break; }
    if (frames.length >= o.maxFrames) { partial = 'frames'; break; }
    const end = Math.min(next + 30, t1);
    const r = await cfxWatchIn(s.tabId, 'grab', { t0: next, t1: end, step, rate, maxWallMs: 20000, maxFrames: 160, seenCaps: !!s.seenCaps });
    if (!r) throw new Error('The video page stopped answering.');
    if (r.waitingAd) { notes.add('ad'); if (++adWaits > 16) throw new Error('An ad kept playing for 4 minutes, so the video was not watched.'); continue; }
    if (r.ad) notes.add('ad');
    frames.push(...r.frames);
    seen.push(...(r.seen || []));
    if (r.tainted) {
      notes.add('shots');
      const rest = await cfxWatchShots(s, Math.max(next, r.next), t1, step, o.maxWallMs - (Date.now() - began), o.maxFrames - frames.length, signal);
      frames.push(...rest.frames); seen.push(...rest.seen);
      partial = rest.partial;
      break;
    }
    if (r.rate && r.rate < rate - 0.01) { notes.add('slow'); rate = r.rate; }
    // Frames that came out more than 1.5 steps apart: this computer can't keep up at this speed.
    const gaps = r.frames.filter((f, i) => i && f.t - r.frames[i - 1].t > step * 1.5).length;
    if (r.frames.length > 4 && gaps / r.frames.length > 0.2 && rate > 1) rate = Math.max(1, rate / 2);
    if (r.stalled || (r.hidden && !r.frames.length)) {
      if (shown < 2 && s.windowId != null) {   // a hidden window can stop the video: the corner first, then the front
        shown++;
        try { await browser.windows.update(s.windowId, Object.assign({ state: 'normal' }, cfxWatchPlace('corner'), shown === 2 ? { focused: true } : {})); } catch {}
        continue;
      }
      partial = 'stalled';
      break;
    }
    if (r.ended) break;
    next = Math.max(r.next, next + (r.frames.length ? 0 : step));
    cfxWatchProgress(s, next, t1, frames.length);
  }
  return { frames, seen, partial, notes, rate, reached: frames.length ? frames[frames.length - 1].t : t0 };
}

// The screenshot fallback: seek to each time, let the frame show, and capture the video's box on screen.
async function cfxWatchShots(s, t0, t1, step, maxWallMs, maxFrames, signal) {
  const frames = [], seen = [];
  const began = Date.now();
  let partial = '';
  for (let t = t0; t < t1 - 1e-3; t += step) {
    if (signal && signal.aborted) throw new Error('Stopped');
    if (Date.now() - began > maxWallMs) { partial = 'time'; break; }
    if (frames.length >= maxFrames) { partial = 'frames'; break; }
    const shown = await cfxWatchIn(s.tabId, 'seekshow', { t, seenCaps: !!s.seenCaps });
    if (!shown || shown.ad) continue;
    const r = shown.rect;
    if (!r || r.width < 8 || r.height < 8) throw new Error('The video is not on screen, so it could not be captured.');
    const url = await browser.tabs.captureTab(s.tabId, { format: 'jpeg', quality: 85, rect: r, scale: Math.min(1, Math.max(0.2, 640 / r.width)) });
    const f = await cfxWatchNormal(url);
    frames.push({ t: Math.round(shown.t * 1000) / 1000, jpeg: f.jpeg, gray: f.gray });
    if (s.seenCaps) seen.push({ t: shown.t, text: shown.caption || '' });
    if (frames.length % 20 === 0) cfxWatchProgress(s, t, t1, frames.length);
  }
  return { frames, seen, partial };
}

// A captured picture -> the same 320 x 180 letterboxed frame and grey thumbnail the page makes.
async function cfxWatchNormal(dataUrl) {
  const img = await cfxWatchImage(dataUrl);
  const W = CFX_WATCH.CELL_W, H = CFX_WATCH.CELL_H;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const sc = Math.min(W / img.width, H / img.height), dw = img.width * sc, dh = img.height * sc;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  const sm = document.createElement('canvas'); sm.width = 16; sm.height = 9;
  const sctx = sm.getContext('2d');
  sctx.drawImage(c, 0, 0, 16, 9);
  const px = sctx.getImageData(0, 0, 16, 9).data;
  const gray = [];
  for (let i = 0; i < 144; i++) gray.push(Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]));
  return { jpeg: c.toDataURL('image/jpeg', 0.8), gray };
}

async function cfxWatchImage(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function cfxWatchProgress(s, at, end, frames) {
  const now = Date.now();
  if (now - (s.lastProgress || 0) < 2000) return;
  s.lastProgress = now;
  cfxState.set({ watching: { title: s.title, at: Math.round(at), end: Math.round(end), frames } }).catch(() => {});
}

// ---------------------------------------------------------------- sheets

// Clips text to a width with an ellipsis.
function cfxWatchFit(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= width) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).replace(/\s+\S*$/, '') + '…';
}

// One sheet: the frames in a 5 x 4 grid, the time on each, and under each row what was said while it played.
async function cfxWatchDraw(sheet, cues, fine) {
  const W = CFX_WATCH.CELL_W, H = CFX_WATCH.CELL_H, S = CFX_WATCH.STRIP_H, cols = CFX_WATCH.COLS;
  const c = document.createElement('canvas');
  c.width = W * cols;
  c.height = sheet.rows.length * (H + S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, c.width, c.height);
  for (let r = 0; r < sheet.rows.length; r++) {
    const row = sheet.rows[r], y = r * (H + S);
    for (let k = 0; k < row.frames.length; k++) {
      const f = row.frames[k], x = k * W;
      try { ctx.drawImage(await cfxWatchImage(f.jpeg), x, y, W, H); } catch {}
      const label = cfxWatchClock(f.t, fine);
      ctx.font = 'bold 17px sans-serif';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = '#ffeb3b';
      ctx.strokeText(label, x + 6, y + 21);
      ctx.fillText(label, x + 6, y + 21);
      ctx.fillStyle = '#111';
      ctx.fillRect(x + W - 1, y, 1, H);
    }
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, y + H, c.width, S);
    const said = cfxWatchSaid(cues, row.t0, row.t1);
    ctx.font = '15px sans-serif';
    ctx.fillStyle = said ? '#f2f2f2' : '#888';
    ctx.fillText(cfxWatchFit(ctx, said ? `“${said}”` : '(nothing said)', c.width - 16), 8, y + H + 19);
  }
  return c.toDataURL('image/jpeg', 0.75).replace(/^data:image\/jpeg;base64,/, '');
}

// ---------------------------------------------------------------- the two tools

function cfxWatchRefuseUngated(args) {
  if (!args || args.__gated !== true) throw new Error('Video watching goes through the helper: use watch_video.');
}

// The video's address: a web page, or a file: tab the helper opened (lib/localpages.js). Each passes its gate.
async function cfxWatchSource(args) {
  if (args.kind === 'file') {
    const t = await browser.tabs.get(Number(args.tab_id));
    const gate = cfxUrlBlocked(t.url || '', cfxGateOpts());
    if (gate.blocked || gate.needGrant) throw new Error('That video file is outside the folders the user allowed.');
    if ((await cfxLocal.fileAccess()) === 'no') throw new Error(CFX_FILE_ACCESS_OFF);
    cfxLocalRead('watch_run');
    return { tabId: t.id, url: t.url, ownsTab: true };
  }
  let url = String(args.url || '');
  if (args.kind === 'tab') {
    let t;
    try { t = await browser.tabs.get(Number(args.tab_id)); } catch { throw new Error(`No tab with id ${args.tab_id}. Call tabs_list.`); }
    url = t.url || '';
    if (/^file:/i.test(url)) throw new Error('That tab shows a file on this computer: watch it with the file\'s full path instead.');
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('Claude can watch web pages (https) and video files in allowed folders.');
  const gate = cfxUrlBlocked(url, cfxGateOpts());
  if (gate.blocked) throw new Error(`Cannot watch this page: ${gate.reason}.`);
  await cfxOpenCheck(url, await cfxWindowTabUrl(), args);
  return { url, ownsTab: true };
}

async function cfxWatchCaptions(s, args) {
  if (Array.isArray(args.cues) && args.cues.length) {
    return { source: 'file', label: String(args.cueLabel || 'subtitle file'), cues: cfxWatchCleanCues(args.cues.slice(0, 20000)) };
  }
  let c = null;
  try { c = await Promise.race([cfxWatchIn(s.tabId, 'captions', { lang: String(args.lang || '') }), cfxSleep(15000).then(() => null)]); } catch { c = null; }
  if (!c) return { source: 'none', note: 'The captions could not be read.', cues: [] };
  return Object.assign({}, c, { cues: cfxWatchCleanCues(c.cues || []) });
}

// The secondary resource (plan, "Secondary resource"): when there are no captions, Claude may tell the user that a
// third-party skill could transcribe the speech. It is never installed or run from here.
const CFX_WATCH_THIRD_PARTY = 'If what was said matters, you may tell the user that a third-party Claude Skill (made by another developer, '
  + 'not by Claudefox, using yt-dlp and ffmpeg) can transcribe a video\'s speech once they install it themselves. Only mention it, and never install it.';

function cfxWatchCaptionHead(cap) {
  if (cap.source === 'none') return `Captions: none. ${cap.note || ''}`.trim() + ' The pictures are all there is: nothing tells Claude what was said. ' + CFX_WATCH_THIRD_PARTY;
  const from = { youtube: 'from YouTube', track: 'from the video\'s caption track', file: 'from the subtitle file next to the video', screen: 'read off the screen as the video played' }[cap.source] || '';
  return `Captions: ${cap.label || 'yes'}${from ? ', ' + from : ''}.` + (cap.note ? ' ' + cap.note : '');
}

async function cfxWatchSheetsOut(frames, step, cues, fine) {
  const sheets = cfxWatchSheets(frames, step);
  const out = [];
  for (const sh of sheets) {
    out.push({
      label: `Sheet ${sh.n} of ${sheets.length}: ${cfxWatchClock(sh.t0, fine)} to ${cfxWatchClock(sh.t1, fine)}, ${sh.frames.length} frames.`,
      data: await cfxWatchDraw(sh, cues, fine), mimeType: 'image/jpeg',
    });
  }
  return out;
}

const cfxWatchPartialText = {
  time: 'Stopped early: the watch took its 10 minutes.',
  frames: 'Stopped early: that is as many frames as one call returns.',
  stalled: 'Stopped early: the video stopped playing (its window may be hidden or covered).',
  sheets: 'Stopped early: that is as many sheets as one call returns.',
};

async function cfxWatchRunTool(args, signal) {
  cfxWatchRefuseUngated(args);
  if (cfxWatchRuns.size) throw new Error('Another video is being watched. Wait for it to finish.');
  const run = { cancel: null };
  cfxWatchRuns.add(run);
  const s = { id: `w${++cfxWatchSeq}`, url: '', windowId: null, tabId: null, ownsTab: true,
    title: '', duration: 0, cues: [], cap: null, seenCaps: false, zooms: 0, holdTimer: null };
  const local = new AbortController();
  const stop = () => { local.abort(); if (s.tabId != null) cfxWatchIn(s.tabId, 'stop', {}).catch(() => {}); };
  run.cancel = stop;
  if (signal) signal.addEventListener('abort', stop, { once: true });
  try {
    const src = await cfxWatchSource(args);
    s.url = src.url;
    if (src.tabId != null) s.tabId = src.tabId;   // the file tab the helper opened: closed with the watch
    const opened = await cfxWatchOpen(src.tabId != null ? { tabId: src.tabId } : { url: src.url });
    Object.assign(s, { windowId: opened.windowId, tabId: opened.tabId });
    cfxWatchSessions.set(s.id, s);
    try { await browser.tabs.update(s.tabId, { muted: true }); } catch {}
    if (src.tabId == null) await cfxWaitLoaded(s.tabId, 25000);
    const p = await cfxWatchFind(s.tabId, local.signal);
    if (p.protected) throw new Error('This video is protected (DRM): the browser shows add-ons only black frames, so it cannot be watched.');
    if (p.live) throw new Error('This is a live stream. Watching live streams is not supported yet.');
    s.title = p.title || '';
    s.duration = p.duration;
    const cap = await cfxWatchCaptions(s, args);
    s.cap = cap;
    s.cues = cap.cues;
    s.seenCaps = cap.source === 'screen';
    const start = Math.max(0, Math.min(Number(args.start) || 0, s.duration));
    const end = Math.min(args.end != null && args.end !== '' ? Number(args.end) : s.duration, s.duration);
    if (!(end > start)) throw new Error(`Nothing to watch between ${cfxWatchClock(start)} and ${cfxWatchClock(end)} (the video is ${cfxWatchClock(s.duration)} long).`);
    await cfxState.addLog('action', `watching ${s.title.slice(0, 80)} (${cfxWatchClock(start)}-${cfxWatchClock(end)})`);
    const step = CFX_WATCH.BASE_STEP;
    // The frame at the end is included when it is a whole second; the very end of the video shows no new frame.
    const got = await cfxWatchCatch(s, start, Math.min(end + step / 2, s.duration - 0.02), step, { rate: 4 }, local.signal);
    if (s.seenCaps) { s.cues = cfxWatchCleanCues(cfxWatchSeenCues(got.seen, step)); s.cap.cues = s.cues; }
    let kept = cfxWatchKeep(got.frames).map(i => got.frames[i]);
    let partial = got.partial;
    let reached = got.reached;
    const room = CFX_WATCH.MAX_SHEETS * CFX_WATCH.COLS * CFX_WATCH.ROWS;
    if (kept.length > room) { reached = kept[room].t; kept = kept.slice(0, room); partial = 'sheets'; }
    const sheets = await cfxWatchSheetsOut(kept, step, s.cues, false);
    const capLines = cfxWatchCaptionLines(s.cues, { t0: start, t1: partial ? reached : end + 1 });
    const head = [
      `Watched ${cfxWatchClock(start)} to ${cfxWatchClock(partial ? reached : end)} of a ${cfxWatchClock(s.duration)} video, one frame a second`
        + ` (played at up to ${got.rate}x, muted): ${got.frames.length} frames, ${kept.length} kept after dropping near-duplicates, in ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}.`,
      cfxWatchCaptionHead(cap),
      got.notes.has('shots') ? 'This site keeps its video frames from add-ons, so the frames are screenshots of the video.' : '',
      got.notes.has('ad') ? 'An ad played first; it is not in the frames.' : '',
      partial ? `${cfxWatchPartialText[partial]} Call watch_video again with start ${cfxWatchClock(reached)} for the rest.` : '',
      `watch_id: ${s.id}. For a closer look at a moment, call watch_zoom with this watch_id and a start and end up to `
        + `${CFX_WATCH.ZOOM_MAX_SPAN} s apart: 4 frames a second (up to ${CFX_WATCH.ZOOM_MAX} zooms, within ${CFX_WATCH_HOLD_MS / 60000} minutes).`,
      'Each sheet is 5 x 4 frames, left to right and top to bottom, with the time in each frame\'s corner and what was said under each row.',
    ].filter(Boolean).join('\n');
    await cfxState.addLog('info', `watched ${kept.length} frames in ${sheets.length} sheets`);
    return { title: s.title, url: s.url, watch_id: s.id, head, text: `Video title: ${s.title}\n\n${capLines.text || '(no captions)'}`, sheets };
  } catch (e) {
    await cfxWatchClose(s);
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', stop);
    cfxWatchRuns.delete(run);
    cfxState.set({ watching: null }).catch(() => {});
    if (cfxWatchSessions.has(s.id)) {
      try { await cfxWatchIn(s.tabId, 'restore', {}); } catch {}
      try { if (s.windowId != null) await browser.windows.update(s.windowId, { state: 'minimized' }); } catch {}
      cfxWatchHold(s);
    }
  }
}

async function cfxWatchZoomTool(args, signal) {
  cfxWatchRefuseUngated(args);
  const s = cfxWatchSessions.get(String(args.watch_id || ''));
  if (!s) throw new Error('That watch_id is not open any more (a watched video stays open for 5 minutes). Call watch_video again.');
  if (s.zooms >= CFX_WATCH.ZOOM_MAX) throw new Error(`This video has had its ${CFX_WATCH.ZOOM_MAX} zooms. Call watch_video again for more.`);
  const t0 = Number(args.start), t1 = Number(args.end);
  if (!(t1 > t0) || t0 < 0 || t1 - t0 > CFX_WATCH.ZOOM_MAX_SPAN + 1e-6) throw new Error(`Give a start and an end up to ${CFX_WATCH.ZOOM_MAX_SPAN} s apart.`);
  if (t0 >= s.duration) throw new Error(`The video is only ${cfxWatchClock(s.duration)} long.`);
  if (cfxWatchRuns.size) throw new Error('Another video is being watched. Wait for it to finish.');
  const run = { cancel: null };
  cfxWatchRuns.add(run);
  const local = new AbortController();
  const stop = () => { local.abort(); cfxWatchIn(s.tabId, 'stop', {}).catch(() => {}); };
  run.cancel = stop;
  if (signal) signal.addEventListener('abort', stop, { once: true });
  clearTimeout(s.holdTimer);
  try {
    if (!(await cfxWatchAlive(s))) {
      if (s.ownsTab && !/^https?:/i.test(s.url)) throw new Error('The window with this video was closed. Call watch_video again.');
      const opened = await cfxWatchOpen({ url: s.url });
      Object.assign(s, { windowId: opened.windowId, tabId: opened.tabId });
      try { await browser.tabs.update(s.tabId, { muted: true }); } catch {}
      await cfxWaitLoaded(s.tabId, 25000);
      await cfxWatchFind(s.tabId, local.signal);
    } else if (s.windowId != null) {
      try { await browser.windows.update(s.windowId, Object.assign({ state: 'normal' }, cfxWatchPlace('off'))); } catch {}
    }
    s.zooms++;
    const end = Math.min(t1, s.duration);
    const step = CFX_WATCH.ZOOM_STEP;
    const got = await cfxWatchCatch(s, t0, Math.min(end, s.duration - 0.02), step, { rate: 2, maxWallMs: 150000, maxFrames: 130 }, local.signal);
    let cues = s.cues;
    if (s.seenCaps && got.seen.length) cues = cfxWatchCleanCues(cfxWatchSeenCues(got.seen, step));
    const sheets = await cfxWatchSheetsOut(got.frames, step, cues, true);
    const capLines = cfxWatchCaptionLines(cues, { t0, t1: end, lineSec: 3 });
    const head = [
      `Zoom ${s.zooms} of ${CFX_WATCH.ZOOM_MAX}: ${cfxWatchClock(t0, true)} to ${cfxWatchClock(end, true)}, four frames a second: ${got.frames.length} frames in ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}.`,
      got.partial ? cfxWatchPartialText[got.partial] : '',
      `watch_id: ${s.id}.`,
    ].filter(Boolean).join('\n');
    return { title: s.title, url: s.url, watch_id: s.id, head, text: capLines.text || '(nothing said in this part)', sheets };
  } finally {
    if (signal) signal.removeEventListener('abort', stop);
    cfxWatchRuns.delete(run);
    if (cfxWatchSessions.has(s.id)) {
      try { await cfxWatchIn(s.tabId, 'restore', {}); } catch {}
      try { if (s.windowId != null) await browser.windows.update(s.windowId, { state: 'minimized' }); } catch {}
      cfxWatchHold(s);
    }
  }
}

// Stop, or watching turned off: running watches end and every watch window closes.
async function cfxWatchCancelAll() {
  for (const r of cfxWatchRuns) { try { if (r.cancel) r.cancel(); } catch {} }
  for (const s of [...cfxWatchSessions.values()]) await cfxWatchClose(s);
  cfxState.set({ watching: null }).catch(() => {});
}

CFX_TOOLS.watch_run = (args, signal) => cfxWatchRunTool(args || {}, signal);
CFX_TOOLS.watch_zoom_run = (args, signal) => cfxWatchZoomTool(args || {}, signal);
