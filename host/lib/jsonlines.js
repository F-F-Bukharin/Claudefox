'use strict';
// Newline-delimited JSON read from a child's stdout as it arrives (army workers print one JSON event per line).
// splitLines calls onLine for each complete line, without its newline, and returns the unfinished tail. The caller
// adds the next chunk to that tail and, when the stream ends, handles a tail that is left (army.js does). lib/lines.js
// is a different reader, for the pipe between the helper and its clients.

function splitLines(buf, onLine) {
  let i;
  while ((i = buf.indexOf('\n')) !== -1) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  return buf;
}

module.exports = { splitLines };
