'use strict';
// Claudefox: the plain parts of video watching (plan docs/superpowers/plans/2026-10-20-video-watching-native.md).
// No browser APIs here: the background page (lib/bg-watch.js) uses them, cfxWatchSampler is also injected into the
// video's tab (lib/watchPage.js), and the Node tests require this file (module.exports at the end).

const CFX_WATCH = {
  BASE_STEP: 1,            // the base pass: one frame a second of video
  ZOOM_STEP: 0.25,         // watch_zoom: four frames a second
  ZOOM_MAX_SPAN: 30,       // seconds of video per zoom
  ZOOM_MAX: 10,            // zooms per watched video
  COLS: 5, ROWS: 4,        // a sheet: 5 x 4 frames
  CELL_W: 320, CELL_H: 180, STRIP_H: 28,
  HEARTBEAT: 10,           // the base pass keeps a frame at least every 10 s, even when nothing changes
  DIFF_MEAN: 4,            // a frame is new when the 16 x 9 grey thumbnail moved this much on average (0-255)...
  DIFF_CELL: 24, DIFF_CELLS: 4,   // ...or when 4 of its 144 cells moved by 24 or more
  THUMB_W: 16, THUMB_H: 9,
  MAX_SHEETS: 40,          // per call: about 60k tokens of pictures
  MAX_CAPTION_CHARS: 40000,
  LINE_SEC: 10,            // caption lines Claude reads are merged to about 10 s each
};

// '90', '90.5', '1:30', '1:02:03', '1:30.25' -> seconds; anything else -> null.
function cfxWatchParseClock(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const sec = Number(m[3]);
  if (sec >= 60 || Number(m[2]) >= 60 && m[1] !== undefined) return null;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + sec;
}

// Seconds -> '1:05' or '1:02:03'; fine -> two decimals of a second ('12:41.25').
function cfxWatchClock(t, fine) {
  let x = Math.max(0, Number(t) || 0);
  if (fine) x = Math.round(x * 100) / 100; else x = Math.floor(x);
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x - h * 3600 - m * 60;
  const ss = fine ? (s < 10 ? '0' : '') + s.toFixed(2) : String(Math.floor(s)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Which video frames to keep while the video plays: the first frame at or after each step from t0, before t1 (t1 is
// not included: the next span starts there). want(mediaTime) says yes once per step; a jump in the video skips the
// steps it passed (no frame is invented). Self-contained: lib/watchPage.js injects its source into the tab.
function cfxWatchSampler(t0, t1, step) {
  const eps = 1e-3;
  let next = t0;
  return {
    want(t) {
      if (!(t >= next - eps) || t >= t1 - eps) return false;
      next = t0 + (Math.floor((t - t0) / step + eps) + 1) * step;
      return true;
    },
    next() { return next; },
    done(t) { return t >= t1 - eps || next >= t1 - eps; },
  };
}

// Mean change and the number of changed cells between two grey thumbnails (arrays of 0-255).
function cfxWatchDiff(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return { mean: 255, cells: a ? a.length : 0 };
  let sum = 0, cells = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d >= CFX_WATCH.DIFF_CELL) cells++;
  }
  return { mean: sum / a.length, cells };
}

// The base pass drops near-duplicate frames: a frame is kept when it changed enough from the last kept one, or when
// the heartbeat has passed. frames: [{ t, gray }] in time order. Returns the indexes kept.
function cfxWatchKeep(frames, opts) {
  const o = Object.assign({ heartbeat: CFX_WATCH.HEARTBEAT, mean: CFX_WATCH.DIFF_MEAN, cells: CFX_WATCH.DIFF_CELLS }, opts || {});
  const kept = [];
  let last = null;
  frames.forEach((f, i) => {
    if (!last) { kept.push(i); last = f; return; }
    const d = cfxWatchDiff(last.gray, f.gray);
    if (d.mean >= o.mean || d.cells >= o.cells || f.t - last.t >= o.heartbeat - 1e-6) { kept.push(i); last = f; }
  });
  return kept;
}

// Kept frames -> sheets of COLS x ROWS. Each row spans from its first frame to the next row's first frame (the last
// row to its last frame plus one step), so the caption strip under it holds what was said while those frames played.
// frames: [{ t, ... }]; returns [{ n, t0, t1, frames, rows: [{ t0, t1, frames }] }].
function cfxWatchSheets(frames, step, opts) {
  const o = Object.assign({ cols: CFX_WATCH.COLS, rows: CFX_WATCH.ROWS }, opts || {});
  const per = o.cols * o.rows;
  const sheets = [];
  for (let i = 0; i < frames.length; i += per) {
    const fs = frames.slice(i, i + per);
    const after = frames[i + per];
    const rows = [];
    for (let r = 0; r * o.cols < fs.length; r++) {
      const rf = fs.slice(r * o.cols, (r + 1) * o.cols);
      const nextRow = fs[(r + 1) * o.cols] || after;
      rows.push({ t0: rf[0].t, t1: nextRow ? nextRow.t : rf[rf.length - 1].t + step, frames: rf });
    }
    sheets.push({ n: sheets.length + 1, t0: fs[0].t, t1: rows[rows.length - 1].t1, frames: fs, rows });
  }
  return sheets;
}

const cfxWatchSquash = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Rolling captions (auto-generated lines that repeat the end of the last one): the new words only.
function cfxWatchRoll(prev, next) {
  const p = cfxWatchSquash(prev).split(' ').filter(Boolean), n = cfxWatchSquash(next).split(' ').filter(Boolean);
  if (!p.length) return n.join(' ');
  for (let k = Math.min(p.length, n.length); k > 0; k--) {
    let same = true;
    for (let j = 0; j < k; j++) if (p[p.length - k + j].toLowerCase() !== n[j].toLowerCase()) { same = false; break; }
    if (same) return n.slice(k).join(' ');
  }
  return n.join(' ');
}

// Cues -> clean cues: text squashed, empty and repeated ones dropped, time order, rolling repeats cut.
function cfxWatchCleanCues(cues) {
  const list = (Array.isArray(cues) ? cues : [])
    .map(c => ({ start: Number(c.start), end: Number(c.end), text: cfxWatchSquash(c.text) }))
    .filter(c => Number.isFinite(c.start) && c.text)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of list) {
    if (!Number.isFinite(c.end) || c.end < c.start) c.end = c.start;
    const last = out[out.length - 1];
    if (last && last.text === c.text) { last.end = Math.max(last.end, c.end); continue; }
    const text = last ? cfxWatchRoll(last.text, c.text) : c.text;
    if (!text) { if (last) last.end = Math.max(last.end, c.end); continue; }
    out.push({ start: c.start, end: c.end, text });
  }
  return out;
}

// What was said between t0 and t1 (cues that overlap the span), on one line.
function cfxWatchSaid(cues, t0, t1) {
  return cfxWatchSquash(cues.filter(c => c.start < t1 && Math.max(c.end, c.start + 0.5) > t0).map(c => c.text).join(' '));
}

// Cues -> lines of about LINE_SEC seconds, '[m:ss] text', for Claude; cut at maxChars with a note.
function cfxWatchCaptionLines(cues, opts) {
  const o = Object.assign({ lineSec: CFX_WATCH.LINE_SEC, maxChars: CFX_WATCH.MAX_CAPTION_CHARS, t0: -Infinity, t1: Infinity }, opts || {});
  const lines = [];
  let cur = null;
  for (const c of cues) {
    if (c.start >= o.t1 || Math.max(c.end, c.start) < o.t0) continue;
    if (!cur || c.start - cur.t >= o.lineSec) { cur = { t: c.start, text: c.text }; lines.push(cur); }
    else cur.text += ' ' + c.text;
  }
  let out = '', cut = false;
  for (const l of lines) {
    const line = `[${cfxWatchClock(l.t)}] ${l.text}\n`;
    if (out.length + line.length > o.maxChars) { cut = true; break; }
    out += line;
  }
  return { text: out + (cut ? `(captions cut at ${Math.round(o.maxChars / 1000)}k characters; watch a later part with start and end)\n` : ''), lines: lines.length, cut };
}

// YouTube's json3 caption format -> cues.
function cfxWatchJson3(obj) {
  const events = obj && Array.isArray(obj.events) ? obj.events : [];
  const cues = [];
  for (const e of events) {
    if (!Array.isArray(e.segs) || e.aAppend) continue;
    const text = e.segs.map(s => s && s.utf8 || '').join('');
    if (!cfxWatchSquash(text)) continue;
    const start = (Number(e.tStartMs) || 0) / 1000;
    cues.push({ start, end: start + (Number(e.dDurationMs) || 0) / 1000, text });
  }
  return cues;
}

// Captions read off the screen while the video played ([{ t, text }] every step) -> cues.
function cfxWatchSeenCues(seen, step) {
  const cues = [];
  for (const s of Array.isArray(seen) ? seen : []) {
    const text = cfxWatchSquash(s.text);
    const last = cues[cues.length - 1];
    if (last && last.text === text && s.t - last.end <= step * 2.5) { last.end = s.t + step; continue; }
    if (text) cues.push({ start: s.t, end: s.t + step, text });
  }
  return cues;
}

// Which caption track to read. tracks: [{ lang, name, auto, isDefault }]; lang: what Claude asked for ('' for the video's
// own). Manual tracks beat auto-generated ones. Returns { index, translate } (translate: a language to ask the site to
// translate the chosen track into), or null when there is none.
function cfxWatchPickTrack(tracks, lang, canTranslate) {
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) return null;
  const want = String(lang || '').toLowerCase();
  const base = l => String(l || '').toLowerCase().split(/[-_]/)[0];
  const order = [];
  if (want) {
    order.push(t => !t.auto && String(t.lang || '').toLowerCase() === want, t => !t.auto && base(t.lang) === base(want),
      t => t.auto && base(t.lang) === base(want));
  }
  order.push(t => !t.auto && t.isDefault, t => !t.auto, t => true);
  for (const test of order) {
    const i = list.findIndex(test);
    if (i < 0) continue;
    const translate = want && base(list[i].lang) !== base(want) && canTranslate ? want : '';
    return { index: i, translate };
  }
  return null;
}

const cfxWatchCore = {
  CFX_WATCH, parseClock: cfxWatchParseClock, clock: cfxWatchClock, sampler: cfxWatchSampler, diff: cfxWatchDiff,
  keep: cfxWatchKeep, sheets: cfxWatchSheets, roll: cfxWatchRoll, cleanCues: cfxWatchCleanCues, said: cfxWatchSaid,
  captionLines: cfxWatchCaptionLines, json3: cfxWatchJson3, seenCues: cfxWatchSeenCues, pickTrack: cfxWatchPickTrack,
};
if (typeof module === 'object' && module && module.exports) module.exports = cfxWatchCore;
