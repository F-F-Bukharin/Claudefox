'use strict';
// The add-on's questions before Unsafe mode, file tools or video watching go on (confirm.js shows the window).

const path = require('path');
const guard = require('./guard');
const T = require('./confirmtexts');

// deps: { confirm, confirmed, sendAddon, sendConfirmedState, isDir, sameDir, watchWindow, saveWatchOnLoad, sendWatchState }
function createConfirmFlow({ confirm, confirmed, sendAddon, sendConfirmedState, isDir, sameDir, watchWindow, saveWatchOnLoad, sendWatchState }) {
  // The add-on asks before Unsafe mode, Automatic mode (kind 'trusted') or file tools go on. The user answers in the confirm window;
  // the helper keeps the answer, and chat turns get only what was allowed. With Automatic or Unsafe mode on, the file-tools folder
  // question is answered Yes without the window, after every refusal below has run.
  async function answerConfirm(msg) {
    const id = String(msg.id || '');
    const reply = (ok, error) => sendAddon({ type: 'confirm_result', id, ok: !!ok, error: error || '' });
    if (msg.kind === 'unsafe') {
      const r = await confirm.ask(T.q('unsafe'));
      if (r.ok) { confirmed.unsafe = true; sendConfirmedState(); }
      return reply(r.ok, r.error);
    }
    if (msg.kind === 'trusted') {
      const r = await confirm.ask(T.q('trusted'));
      if (r.ok) { confirmed.trusted = true; sendConfirmedState(); }
      return reply(r.ok, r.error);
    }
    if (msg.kind === 'files') {
      const mode = msg.mode === 'write' ? 'write' : 'read';
      const raw = String(msg.folder || '').trim();
      if (!raw || !path.isAbsolute(raw) || !isDir(raw)) return reply(false, `There is no folder at ${raw || '(none)'}.`);
      const folder = path.resolve(raw);
      const why = guard.folderProblem(folder, mode);
      if (why) return reply(false, `File tools can't use ${folder}: ${why}.`);
      const have = confirmed.files;
      if (have && sameDir(have.folder, folder) && (mode === 'read' || have.mode === 'write')) return reply(true);   // allowed already
      if (confirmed.trusted === true || confirmed.unsafe === true) {   // Automatic or Unsafe mode: a Yes, with no window
        confirmed.files = { mode, folder };
        sendConfirmedState();
        return reply(true);
      }
      const r = await confirm.ask(T.q(mode === 'write' ? 'files.write' : 'files.read', folder));
      if (r.ok) { confirmed.files = { mode, folder }; sendConfirmedState(); }
      return reply(r.ok, r.error);
    }
    if (msg.kind === 'watch') {   // the Settings switch: watching on for this session
      const on = await watchWindow('watch');
      if (on) confirmed.watch = true;
      sendWatchState();
      return reply(on);
    }
    if (msg.kind === 'watch_on_load') {   // the saved option: start with watching on or off
      const on = await watchWindow('watch_on_load');
      saveWatchOnLoad(on);
      sendWatchState();
      return reply(on);
    }
    return reply(false, 'Unknown question.');
  }

  return { answerConfirm };
}

module.exports = { createConfirmFlow };
