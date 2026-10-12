'use strict';
// The add-on's questions before Unsafe mode, file tools or video watching go on (confirm.js shows the window).

const path = require('path');
const guard = require('./guard');

// deps: { confirm, confirmed, sendAddon, sendConfirmedState, isDir, sameDir, watchWindow, saveWatchOnLoad, sendWatchState }
function createConfirmFlow({ confirm, confirmed, sendAddon, sendConfirmedState, isDir, sameDir, watchWindow, saveWatchOnLoad, sendWatchState }) {
  // The add-on asks before Unsafe mode, Trusted mode or file tools go on. The user answers in the confirm window; the helper keeps
  // the answer, and chat turns get only what was allowed.
  async function answerConfirm(msg) {
    const id = String(msg.id || '');
    const reply = (ok, error) => sendAddon({ type: 'confirm_result', id, ok: !!ok, error: error || '' });
    if (msg.kind === 'unsafe') {
      const r = await confirm.ask({ title: 'Claude in Zen: turn on Unsafe mode?',
        text: 'Claude may then act on Google sign-in and account pages like on any other site, to debug sign-in problems. It still never types passwords, 2FA codes or payment details.\n\nUnsafe mode turns off when you press Stop or restart Zen.',
        yes: 'Turn on', no: 'Cancel' });
      if (r.ok) { confirmed.unsafe = true; sendConfirmedState(); }
      return reply(r.ok, r.error);
    }
    if (msg.kind === 'trusted') {
      const r = await confirm.ask({ title: 'Claude in Zen: turn on Trusted mode?',
        text: 'Claude acts on any site without asking. Pages can try to steer it. It stays on until you press Stop.',
        yes: 'Turn on', no: 'Cancel' });
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
      const r = await confirm.ask({ title: 'Claude in Zen: turn on file tools?',
        text: mode === 'write'
          ? `Let Claude read, create, change and delete files in this folder and its subfolders?\n\n${folder}\n\nThere is no undo. Claude never gets a shell.`
          : `Let Claude read and search the files in this folder and its subfolders?\n\n${folder}\n\nNo changes, no shell.`,
        yes: mode === 'write' ? 'Allow read and write' : 'Allow reading', no: 'Cancel' });
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
