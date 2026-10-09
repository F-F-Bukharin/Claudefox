'use strict';
// Newline-delimited JSON over a stream (the local pipe between the host and its clients).
const MAX_LINE = 64 * 1024 * 1024;

function onLines(stream, handler, onOverflow) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buf += chunk;
    if (buf.length > MAX_LINE) { buf = ''; if (onOverflow) onOverflow(); return; }
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handler(msg);
    }
  });
}

function sendLine(stream, msg) {
  if (!stream || stream.destroyed || !stream.writable) return false;
  return stream.write(JSON.stringify(msg) + '\n');
}

module.exports = { onLines, sendLine };
