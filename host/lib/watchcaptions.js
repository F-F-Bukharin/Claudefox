'use strict';
// Subtitle files next to a local video (video.mp4 with video.vtt, video.srt or video.en.srt): read here, in the helper,
// because the add-on cannot read files. The cues go to the add-on with the watch (extension/lib/bg-watch.js).
const fs = require('fs');
const path = require('path');
const guard = require('./guard');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CUES = 20000;

function clockOf(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(s).trim());
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&lrm;': '', '&rlm;': '' };

// WebVTT and SRT -> [{ start, end, text }]. Cue settings, tags (<i>, <v Name>, <c.x>) and NOTE/STYLE blocks are dropped.
function parseSubtitles(text) {
  const cues = [];
  const blocks = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, rest] = lines[i].split('-->');
    const start = clockOf(a), end = clockOf(String(rest || '').trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const body = lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, '').replace(/&[#a-z0-9]+;/gi, e => (e in ENTITIES ? ENTITIES[e] : e)).replace(/\s+/g, ' ').trim();
    if (body) cues.push({ start, end, text: body });
    if (cues.length >= MAX_CUES) break;
  }
  return cues;
}

// The subtitle file for a video: <name>.vtt / .srt, or <name>.<language>.vtt / .srt. With a language asked for, a file
// in that language comes first. Only files in the video's own folder, never a protected or secret file.
function findSubtitles(videoPath, lang) {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath)).toLowerCase();
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const want = String(lang || '').toLowerCase().split(/[-_]/)[0];
  const found = [];
  for (const n of names) {
    const low = n.toLowerCase();
    const m = /^(.*)\.(vtt|srt)$/.exec(low);
    if (!m) continue;
    let tag = null;
    if (m[1] === base) tag = '';
    else if (m[1].startsWith(base + '.')) tag = m[1].slice(base.length + 1);
    if (tag === null) continue;
    const rank = want && tag.split(/[-_]/)[0] === want ? 0 : tag === '' ? 1 : 2;
    found.push({ n, tag, rank });
  }
  found.sort((x, y) => x.rank - y.rank || x.n.localeCompare(y.n));
  for (const f of found) {
    const p = path.join(dir, f.n);
    try {
      if (guard.localProblem(p, false) || guard.secretFile(p)) continue;
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const cues = parseSubtitles(fs.readFileSync(p, 'utf8'));
      if (cues.length) return { cues, label: f.n };
    } catch {}
  }
  return null;
}

module.exports = { parseSubtitles, findSubtitles };
