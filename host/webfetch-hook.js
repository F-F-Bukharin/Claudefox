'use strict';
// The WebFetch hook. Claude Code runs it before each WebFetch (a PreToolUse command in the chat's settings, see
// lib/chatargs.js) with the tool input on stdin. It asks the helper over the local pipe whether this chat may fetch the
// address (lib/sites.js decides). Exit 0 lets the fetch go on; anything else exits 2, and Claude reads the one stderr
// line as the reason. One 5 s timer covers the whole check, so a helper that is down or silent blocks the fetch.
const fs = require('fs');
const net = require('net');
const P = require('./lib/paths');
const { onLines, sendLine } = require('./lib/lines');

const NO_CHECK = 'Claudefox could not check this address, so WebFetch is blocked.';
let settled = false;
const timer = setTimeout(() => finish(false, NO_CHECK), 5000);

function finish(allowed, reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (allowed) process.exit(0);
  process.stderr.write(`${reason || NO_CHECK}\n`, () => process.exit(2));
}

function ask(session, url) {
  let token;
  try { token = fs.readFileSync(P.TOKEN_FILE, 'utf8').trim(); } catch { finish(false, NO_CHECK); return; }
  const sock = net.connect(P.PIPE);
  sock.on('connect', () => sendLine(sock, { type: 'hello', token, client: 'webfetch-hook' }));
  sock.on('error', () => finish(false, NO_CHECK));
  sock.on('close', () => finish(false, NO_CHECK));
  onLines(sock, m => {
    if (m.type === 'hello_ok') {
      sendLine(sock, { type: 'webfetch_check', session, url });
    } else if (m.type === 'webfetch_result') {
      finish(m.allowed === true, m.reason);
    } else if (m.type === 'error') {
      finish(false, NO_CHECK);
    }
  });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('error', () => finish(false, NO_CHECK));
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { finish(false, NO_CHECK); return; }
  const d = data && typeof data === 'object' ? data : {};
  const url = d.tool_input && typeof d.tool_input.url === 'string' ? d.tool_input.url : '';
  ask(typeof d.session_id === 'string' ? d.session_id : '', url);
});
