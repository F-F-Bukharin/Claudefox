'use strict';
// Claudefox: background page (MV2, persistent). This file is the entry: startup, and the state the concerns share.
// The Zen-opened rule and the toolbar button are here too. The concerns are lib/bg-*.js, listed before this file in
// manifest.json background.scripts, so the startup below runs after all of them have loaded.

let nativePort = null;
// Settings > Saving files: a request to the helper to store a file, by request number -> its resolve (storeOutput).
const outputWaiters = new Map();
let outputSeq = 0;
const pendingActions = new Map();   // id -> { cmd, controller, startedAt }
let nextActionId = 1;

// ---------------------------------------------------------------- startup

// The language (lib/i18n.js): the helper's confirm windows follow it, so it hears when Settings > Language changes it.
cfxI18n.onChange(lang => { sendNative({ type: 'lang', lang }); });

const booted = (async function init() {
  await cfxState.load();
  cfxState.onChange(pushToPanels);
  cfxState.onChange(updateBadge);
  await cfxState.set({ pending: 0 });
  cfxArmy.install();
  try { const pref = await browser.storage.local.get('caveman'); await cfxState.set({ caveman: !!pref.caveman }); } catch {}
  // The army switch comes back as it was left: on, in the mode it was in (Speed hides the octopus, so the army waits
  // there until the user picks Quality again).
  try {
    const on = (await browser.storage.local.get('armyOn')).armyOn === true;
    const model = (await browser.storage.local.get('armyModel')).armyModel;
    await cfxState.set(on ? { chatArmy: true, chatModel: model === 'speed' ? 'speed' : 'quality' } : { chatArmy: false });
  } catch {}
  await refreshArmyToday();
  setInterval(refreshArmyToday, 30 * 60 * 1000);
  try { await cfxLocal.init(); } catch {}   // the allowed folders, and whether Zen lets the add-on into file: pages
  try { const o = await browser.storage.local.get('outputMode'); await cfxState.set({ outputMode: o.outputMode === 'store' ? 'store' : 'download' }); } catch {}
  if (cfxState.get().agent === 'active') cfxNetLogStart();   // the network log watches only while the agent is active
  await cfxState.addLog('info', 'Add-on started');
  resumeSignIn('startup');
  closeInstallerTabs();
  probeDebugPort();
  setInterval(probeDebugPort, 20000);
  if (cfxState.get().agent === 'active') connectNative();
  updateBadge(cfxState.get());
})();

// Opening Zen turns the agent on. A window counts as "Zen opened" when it is the only normal window, so
// a Stop lasts while Zen stays open, and a second window does not undo it or reconnect the helper.
browser.windows.onCreated.addListener(win => {
  if (!win || win.type !== 'normal') return;
  booted.then(async () => {
    const normal = await browser.windows.getAll({ windowTypes: ['normal'] });
    if (normal.length !== 1) return;
    if (cfxState.get().agent === 'active') return connectNative();
    await cfxState.set({ agent: 'active' });
    cfxNetLogStart();
    await cfxState.addLog('info', 'Zen opened: the agent is on.');
    connectNative();
  }).catch(e => cfxState.addLog('error', `Auto-start failed: ${e.message || e}`));
});

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle().catch(() => browser.sidebarAction.open().catch(() => {}));
});

// Alt+Shift+X (the stop-claude command in the manifest): the same Stop as the panel's Stop button.
// A browser stub without commands (the older vm tests) skips the listener.
if (browser.commands) browser.commands.onCommand.addListener(name => { if (name === 'stop-claude') stopAll('keyboard shortcut'); });
