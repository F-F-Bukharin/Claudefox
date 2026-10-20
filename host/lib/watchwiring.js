'use strict';
// The helper's side of watch_video and watch_zoom (watchgate.js asks, watchvideo.js checks and hands over to the
// add-on): the two confirm questions, the saved "every time the panel opens" answer, the watching state the panel
// shows, and the dependencies a watch gets.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const log = require('./log');
const { createWatchGate } = require('./watchgate');
const T = require('./confirmtexts');

// The two questions: the Settings switches and the card's Allow (texts in confirmtexts.js). Each resolves true only on Yes.
const WATCH_QUESTIONS = { watch: 'watch', watch_on_load: 'watchOnLoad' };

// deps: { confirm, confirmed, sendAddon, grants }. Returns { watchWindow, saveWatchOnLoad, sendWatchState, watchLoad,
// gate, watchDeps }.
function createWatchWiring({ confirm, confirmed, sendAddon, grants }) {
  function watchWindow(kind) {
    return confirm.ask(T.q(WATCH_QUESTIONS[kind])).then(r => r.ok === true);
  }

  // The saved answer to "every time the panel opens" (P.WATCH_ON_LOAD): true or false, or null when never asked.
  function readWatchOnLoad() {
    try { const v = JSON.parse(fs.readFileSync(P.WATCH_ON_LOAD, 'utf8')); return typeof v.on === 'boolean' ? v.on : null; } catch { return null; }
  }
  function saveWatchOnLoad(on) {
    try { fs.mkdirSync(path.dirname(P.WATCH_ON_LOAD), { recursive: true }); fs.writeFileSync(P.WATCH_ON_LOAD, JSON.stringify({ on: on === true })); }
    catch (e) { log.error('watch-on-load', e.message); }
  }
  function sendWatchState() { return sendAddon({ type: 'watch_state', watch: confirmed.watch, watchOnLoad: readWatchOnLoad() }); }

  // The panel loaded: a first load asks for the saved answer; watching then starts on or off as that answer says.
  async function watchLoad() {
    gate.cancel();
    if (readWatchOnLoad() === null) saveWatchOnLoad(await watchWindow('watch_on_load'));
    confirmed.watch = readWatchOnLoad() === true;
    sendWatchState();
  }

  const gate = createWatchGate({
    showCard: (id, source) => sendAddon({ type: 'watch_ask', id, source }),
    hideCard: id => sendAddon({ type: 'watch_ask_done', id }),
    confirmWindow: () => watchWindow('watch'),
    setEnabled: on => { confirmed.watch = on; sendWatchState(); },
  });

  // What a watch needs from the helper; the host adds openLocal and callAddon (they live there).
  function watchDeps() {
    return {
      enabled: confirmed.watch,
      permission: { ask: source => gate.ask(source) },
      folderOf: real => grants.covering(real),
      runMs: 14 * 60 * 1000,    // the add-on's own limit is 10 minutes of watching, plus opening the video
      zoomMs: 4 * 60 * 1000,
    };
  }

  return { watchWindow, saveWatchOnLoad, sendWatchState, watchLoad, gate, watchDeps };
}

module.exports = { createWatchWiring };
