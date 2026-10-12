'use strict';
// Uploads a file from a folder the user allows into a file field on the page (the upload_file tool). The file is read and
// checked here, then sent to the add-on: a card call first (the user answers it in the panel), then the bytes as base64 in
// parts (the add-on limits a message from the host to 1 MB, so a part is 700 KB of base64), then the attach call. A refusal on the
// card ends the upload with the add-on's own message, and no part is sent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const guard = require('./guard');

const MB = 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * MB;
const PART_CHARS = 700 * 1024;   // a multiple of 4, so each part is whole base64 groups
const MIME = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.zip': 'application/zip' };

// deps: { folders() -> the folders the user allows, callAddon(tool, args) -> Promise<{ ok, result, error }> }.
// Resolves with a line about the attached file; a refusal throws with the reason.
async function uploadFile(args, deps) {
  const raw = String((args && args.path) || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('Give the full path of the file.');
  const selector = args.selector ? String(args.selector) : '';
  const ref = args.ref ? String(args.ref) : '';
  if (!selector && !ref) throw new Error('Give the selector or the ref of the file field.');
  const folders = deps.folders();
  const file = path.resolve(raw);
  if (!folders.some(f => guard.within(file, f)) || !guard.readable(file, folders)) {
    throw new Error(`Not allowed: ${raw} is outside the folders the user allows, or it is a protected file.`);
  }
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${raw} is not a regular file.`);
  if (st.size > MAX_UPLOAD_BYTES) throw new Error(`The file is ${(st.size / MB).toFixed(1)} MB; the limit is ${MAX_UPLOAD_BYTES / MB} MB.`);
  const data = fs.readFileSync(file).toString('base64');
  const parts = [];
  for (let i = 0; i < data.length; i += PART_CHARS) parts.push(data.slice(i, i + PART_CHARS));
  if (!parts.length) parts.push('');
  const id = crypto.randomBytes(8).toString('hex');
  const name = path.basename(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const target = selector ? { selector } : { ref };
  if (args.tab_id != null) target.tab_id = args.tab_id;
  const card = await deps.callAddon('upload_attach', Object.assign({ ask: true, id, name, type, size: st.size, parts: parts.length }, target));
  if (!card || card.ok === false) throw new Error((card && card.error) || 'The browser did not answer the upload.');
  for (let i = 0; i < parts.length; i++) {
    const sent = await deps.callAddon('upload_part', { id, index: i, data: parts[i] });
    if (!sent || sent.ok === false) throw new Error((sent && sent.error) || 'The browser did not take the file.');
  }
  const done = await deps.callAddon('upload_attach', { attach: true, id });
  if (!done || done.ok === false) throw new Error((done && done.error) || 'The browser did not attach the file.');
  const res = done.result || {};
  return `Attached ${res.attached || name} to ${res.site || 'the page'}.`;
}

module.exports = { uploadFile, MAX_UPLOAD_BYTES, PART_CHARS };
