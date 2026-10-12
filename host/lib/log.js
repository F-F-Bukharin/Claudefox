'use strict';
// Small file logger. Logs carry metadata only (tool names, timings, errors), never page content.
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('./paths');

const MAX_BYTES = 1024 * 1024;
let file = null;

function open(name) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    file = path.join(LOG_DIR, name);
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch {}
  } catch { file = null; }
}

function write(level, parts) {
  if (!file) return;
  const text = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  try { fs.appendFileSync(file, `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`); } catch {}
}

module.exports = {
  open,
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};
