'use strict';
// The output folder: the files Claude makes that the add-on stores here instead of downloading (Settings, Files).
// It sits beside the mods folder. Each file is written in one step under its own name; a name that is taken gets
// " (2)", " (3)" and so on, so nothing is overwritten.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 50 * 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// A name that is safe to write on Windows: no folder parts, no reserved characters, no leading or trailing dots and
// spaces, no device names, at most 120 characters with its extension kept.
function safeName(name, fallback = 'file') {
  let n = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!n) n = fallback;
  const stem = n.replace(/\.[^.]*$/, '');
  if (RESERVED.test(stem)) n = '_' + n;
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

// The first name that is free in dir: report.xlsx, then report (2).xlsx, report (3).xlsx and so on.
function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`;
  return candidate;
}

// Writes base64 data into dir and returns the full path. The bytes go to a temporary file first and are then renamed,
// so a failed write leaves no half-written file behind.
function save(dir, name, base64) {
  const data = Buffer.from(String(base64 || ''), 'base64');
  if (!data.length) throw new Error('the file is empty');
  if (data.length > MAX_BYTES) throw new Error(`the file is over ${MAX_BYTES / (1024 * 1024)} MB`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, freeName(dir, safeName(name)));
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return target;
}

module.exports = { MAX_BYTES, safeName, freeName, save };
