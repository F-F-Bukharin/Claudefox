'use strict';
// The permission card for the watch_video tool (watch-tool spec, "Gating and permission"). Claude can ask; only the user
// can allow. The card sits in the panel chat with Allow and Deny. Allow opens the confirm window (lib/confirm.js), and only
// its Yes turns watching on for the session. After a Deny or a No, a card waits a minute before it can come back.
//
// The timings are options so the tests can run in milliseconds; the host takes the defaults, which are the spec's.

const DENIED = 'The user said no to watching videos for now.';
const NO_PANEL = 'Open the Claude panel to answer whether Claude may watch videos.';
const BUSY = 'The user is already answering a question about watching videos. Wait for that answer.';

// deps: { showCard(id, source), hideCard(id), confirmWindow() -> Promise<boolean>, setEnabled(on), now,
//         cardTimeoutMs, cooldownMs, panelWaitMs }
function createWatchGate(deps) {
  const { showCard, hideCard, confirmWindow, setEnabled, now = Date.now,
    cardTimeoutMs = 120000, cooldownMs = 60000, panelWaitMs = 5000 } = deps;
  let seq = 0;
  let cooldownUntil = 0;
  let card = null;   // the open card: { id, source, phase: 'panel' | 'answer' | 'window', timer, cancelled, done }

  // Ends the ask. A card still in the panel is taken down here; one in the window was taken down when Allow was pressed.
  function close(c, result, cooldown) {
    clearTimeout(c.timer);
    if (c.phase !== 'window') hideCard(c.id);
    card = null;
    if (cooldown) cooldownUntil = now() + cooldownMs;
    c.done(result);
  }

  function ask(source) {
    if (now() < cooldownUntil) return Promise.resolve({ ok: false, message: DENIED });
    if (card) return Promise.resolve({ ok: false, message: BUSY });
    return new Promise(done => {
      const c = { id: String(++seq), source: String(source == null ? '' : source), phase: 'panel', timer: null, cancelled: false, done };
      card = c;
      showCard(c.id, c.source);
      c.timer = setTimeout(() => close(c, { ok: false, message: NO_PANEL }, false), panelWaitMs);
    });
  }

  // The panel has the card on screen: the wait for the answer starts.
  function shown(id) {
    const c = card;
    if (!c || c.id !== String(id) || c.phase !== 'panel') return;
    c.phase = 'answer';
    clearTimeout(c.timer);
    c.timer = setTimeout(() => close(c, { ok: false, message: DENIED }, true), cardTimeoutMs);   // no answer counts as No
  }

  function answer(id, allow) {
    const c = card;
    if (!c || c.id !== String(id) || c.phase !== 'answer') return;
    if (!allow) return close(c, { ok: false, message: DENIED }, true);
    clearTimeout(c.timer);
    c.phase = 'window';
    hideCard(c.id);
    new Promise(resolve => resolve(confirmWindow()))
      .catch(() => false)
      .then(yes => {
        if (yes === true && !c.cancelled) { setEnabled(true); return close(c, { ok: true }, false); }
        close(c, { ok: false, message: DENIED }, !c.cancelled);
      });
  }

  // Stop, or the panel reloading: a card in the panel is withdrawn with no wait. A window already open is left to answer,
  // and its Yes is ignored.
  function cancel() {
    const c = card;
    if (!c) return;
    if (c.phase === 'window') { c.cancelled = true; return; }
    close(c, { ok: false, message: DENIED }, false);
  }

  return { ask, answer, shown, cancel };
}

module.exports = { createWatchGate, DENIED, NO_PANEL, BUSY };
