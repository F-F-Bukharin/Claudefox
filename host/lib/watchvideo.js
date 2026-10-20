'use strict';
// watch_video and watch_zoom, the helper's side (plan docs/superpowers/plans/2026-10-20-video-watching-native.md): the
// checks, the user's permission (watchgate.js), then the add-on, which watches the video in a window of its own
// (extension/lib/bg-watch.js). Nothing is installed, downloaded or saved: the add-on catches frames from the video
// while it plays, muted. A local video is opened in Zen first (lib/localpages.js), and a subtitle file next to it is
// read here (lib/watchcaptions.js).
const fs = require('fs');
const path = require('path');
const { toPath } = require('./localpages');
const guard = require('./guard');
const { findSubtitles } = require('./watchcaptions');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv', '.ogg']);
const MAX_SOURCE = 2048;
const MAX_QUESTION = 500;
const ZOOM_MAX_SPAN = 30;

function checkSource(raw, folderOf) {
  const source = String(raw == null ? '' : raw).trim();
  if (!source) return { ok: false, error: 'Give a video address, a tab (tab:<id> from tabs_list) or the path of a video file.' };
  if (source.length > MAX_SOURCE) return { ok: false, error: `The source is longer than ${MAX_SOURCE} characters.` };
  if (/^tab:\d{1,10}$/i.test(source)) return { ok: true, kind: 'tab', tab_id: Number(source.slice(4)) };
  if (/^https?:\/\//i.test(source)) {
    let url;
    try { url = new URL(source); } catch { return { ok: false, error: 'That address is not valid.' }; }
    if (!url.hostname) return { ok: false, error: 'That address has no host.' };
    return { ok: true, kind: 'url', source: url.href };
  }
  if (source.startsWith('-')) return { ok: false, error: 'A source cannot start with a dash.' };
  let real;
  try {
    real = fs.realpathSync.native(toPath(source));
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'That video file was not found.' : (e.message || 'That path is not valid.') };
  }
  if (!fs.statSync(real).isFile()) return { ok: false, error: 'That path is not a file.' };
  if (!VIDEO_EXT.has(path.extname(real).toLowerCase())) return { ok: false, error: 'The browser plays .mp4, .m4v, .mov, .webm, .mkv and .ogv files; this file is not one of them.' };
  const problem = guard.localProblem(real, false);
  if (problem) return { ok: false, error: `Claude cannot watch that file: ${problem}.` };
  if (!folderOf(real)) return { ok: false, error: 'Allow the folder that holds this video in Local folders first.' };
  return { ok: true, kind: 'file', source: real };
}

function checkQuestion(raw) {
  const value = raw == null ? '' : String(raw);
  if (value.includes('\0')) return { ok: false, error: 'The question contains a NUL character.' };
  if (value.length > MAX_QUESTION) return { ok: false, error: `The question is longer than ${MAX_QUESTION} characters.` };
  return { ok: true, value };
}

// '90', '1:30', '1:02:03', '1:30.25' -> seconds (the same rules as extension/lib/watchCore.js parseClock).
function parseClock(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const sec = Number(m[3]);
  if (sec >= 60 || Number(m[2]) >= 60 && m[1] !== undefined) return null;
  return (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + sec;
}

// An optional time: '' when not given; a bad one is refused at once.
function timeArg(name, raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const t = parseClock(raw);
  if (t === null) throw new Error(`The ${name} time is not valid. Use seconds (90) or a clock time (1:30).`);
  return t;
}

// A caption language: '' (the video's own), or a code such as en, pt or pt-BR.
function langArg(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (!/^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/i.test(s)) throw new Error('The language is not valid. Use a code such as en, pt or pt-BR.');
  return s.replace('_', '-');
}

async function allowed(deps, what) {
  if (deps.enabled) return;
  const v = await deps.permission.ask(what);
  if (!v.ok) throw new Error(v.message);
}

// The tool. A refusal throws at once. Unless watching is on for the session, the user is asked first; a No throws its
// text and nothing opens.
// deps: { enabled, permission: { ask(source) -> Promise<{ ok, message? }> }, folderOf(real), openLocal(real) ->
//         Promise<{ tab_id }>, callAddon(tool, args, ms) -> Promise<{ ok, result, error }>, runMs }
async function watchVideo(args, deps) {
  const a = args || {};
  const src = checkSource(a.source, deps.folderOf);
  if (!src.ok) throw new Error(src.error);
  const q = checkQuestion(a.question);
  if (!q.ok) throw new Error(q.error);
  const start = timeArg('start', a.start);
  const end = timeArg('end', a.end);
  if (start !== '' && end !== '' && end <= start) throw new Error('The end must come after the start.');
  const lang = langArg(a.lang);
  await allowed(deps, a.source);
  const payload = { kind: src.kind, start: start === '' ? 0 : start, end, lang };
  if (src.kind === 'url') payload.url = src.source;
  if (src.kind === 'tab') payload.tab_id = src.tab_id;
  if (src.kind === 'file') {
    const subs = findSubtitles(src.source, lang);
    if (subs) { payload.cues = subs.cues; payload.cueLabel = subs.label; }
    const opened = await deps.openLocal(src.source);
    payload.tab_id = opened.tab_id;
  }
  const r = await deps.callAddon('watch_run', payload, deps.runMs);
  if (!r || !r.ok) throw new Error((r && r.error) || 'The video could not be watched.');
  return r.result;
}

// watch_zoom: four frames a second over up to 30 s of a video watch_video opened (its watch_id).
async function watchZoom(args, deps) {
  const a = args || {};
  const id = String(a.watch_id == null ? '' : a.watch_id).trim();
  if (!/^w\d{1,6}$/.test(id)) throw new Error('Give the watch_id that watch_video returned (such as w1).');
  const start = timeArg('start', a.start);
  const end = timeArg('end', a.end);
  if (start === '' || end === '') throw new Error('Give a start and an end, such as 12:40 and 12:55.');
  if (end <= start) throw new Error('The end must come after the start.');
  if (end - start > ZOOM_MAX_SPAN + 1e-6) throw new Error(`A zoom covers at most ${ZOOM_MAX_SPAN} seconds. Zoom into a shorter part, or into two parts.`);
  await allowed(deps, `zoom ${id}`);
  const r = await deps.callAddon('watch_zoom_run', { watch_id: id, start, end }, deps.zoomMs);
  if (!r || !r.ok) throw new Error((r && r.error) || 'The zoom did not work.');
  return r.result;
}

module.exports = { checkSource, checkQuestion, parseClock, timeArg, langArg, watchVideo, watchZoom, ZOOM_MAX_SPAN };
