'use strict';
// The permission card for the download_image tool (pictures). Claude can ask; only the user can allow. The card sits in
// the panel chat with Allow and Deny. Allow lets the download run; a No, a card no panel shows, and a card with no answer
// are all refused. A No counts at any phase; a Yes counts only once the panel shows the card. Unlike the watch card there
// is no cooldown: the next ask shows a card at once.
//
// The timings are options so the tests can run in milliseconds; the host takes the defaults, which are the spec's.
const path = require('path');

const DENIED = 'The user did not allow saving this picture.';
const NO_PANEL = 'Open the Claude panel to answer whether Claude may save this picture.';
const BUSY = 'The user is already answering about another picture. Try again after that answer.';
const NOT_ALLOWED = 'Claude can save pictures only to the pictures folder or a folder you allowed.';

// deps: { showCard(id, info), hideCard(id), cardTimeoutMs, panelWaitMs }
function createDownloadGate(deps) {
  const { showCard, hideCard, cardTimeoutMs = 120000, panelWaitMs = 5000 } = deps;
  let seq = 0;
  let card = null;   // the open card: { id, phase: 'panel' | 'answer', timer, done }

  // Ends the ask and takes the card down (it may never have been shown).
  function close(c, result) {
    clearTimeout(c.timer);
    hideCard(c.id);
    card = null;
    c.done(result);
  }

  function ask(info) {
    if (card) return Promise.resolve({ ok: false, message: BUSY });
    return new Promise(done => {
      const c = { id: String(++seq), phase: 'panel', timer: null, done };
      card = c;
      showCard(c.id, info);
      c.timer = setTimeout(() => close(c, { ok: false, message: NO_PANEL }), panelWaitMs);
    });
  }

  // The panel has the card on screen: the wait for the answer starts.
  function shown(id) {
    const c = card;
    if (!c || c.id !== String(id) || c.phase !== 'panel') return;
    c.phase = 'answer';
    clearTimeout(c.timer);
    c.timer = setTimeout(() => close(c, { ok: false, message: DENIED }), cardTimeoutMs);   // no answer counts as No
  }

  function answer(id, allow) {
    const c = card;
    if (!c || c.id !== String(id)) return;
    if (!allow) return close(c, { ok: false, message: DENIED });
    if (c.phase === 'answer') close(c, { ok: true });   // a Yes before the card is shown does not count
  }

  // Stop, or the panel reloading: a card in the panel is withdrawn at once.
  function cancel() {
    if (card) close(card, { ok: false, message: DENIED });
  }

  return { ask, shown, answer, cancel };
}

// The folder a picture is saved in. args.folder must be one of the folders the user allowed (the path is resolved first),
// and the folder guard must pass it for writing. Without a folder it is the pictures folder in outputDir.
// ctx: { outputDir, allowed, folderProblem(folder, mode) -> problem text, or '' when it is fine }. Returns { folder } or { error }.
function pictureFolder(args, ctx) {
  if (!args.folder) return { folder: path.join(ctx.outputDir, 'pictures') };
  const folder = path.resolve(String(args.folder));
  if (!ctx.allowed.includes(folder) || ctx.folderProblem(folder, 'write')) return { error: NOT_ALLOWED };
  return { folder };
}

module.exports = { createDownloadGate, pictureFolder, DENIED, NO_PANEL, BUSY };
