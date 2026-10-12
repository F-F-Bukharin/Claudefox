'use strict';
// Claude in Zen: background page (MV2, persistent). This file is the entry: startup, and the state the concerns share.
// The Zen-opened rule and the toolbar button are here too. The concerns are lib/bg-*.js, listed before this file in
// manifest.json background.scripts, so the startup below runs after all of them have loaded.

let nativePort = null;
// Settings > Saving files: a request to the helper to store a file, by request number -> its resolve (storeOutput).
const outputWaiters = new Map();
let outputSeq = 0;
const pendingActions = new Map();   // id -> { cmd, controller, startedAt }
let nextActionId = 1;

// ---------------------------------------------------------------- startup

const booted = (async function init() {
  await cizState.load();
  cizState.onChange(pushToPanels);
  cizState.onChange(updateBadge);
  await cizState.set({ pending: 0 });
  cizArmy.install();
  try { const pref = await browser.storage.local.get('caveman'); await cizState.set({ caveman: !!pref.caveman }); } catch {}
  // The army switch comes back as it was left: on, in the mode it was in (Speed hides the octopus, so the army waits
  // there until the user picks Quality again).
  try {
    const on = (await browser.storage.local.get('armyOn')).armyOn === true;
    const model = (await browser.storage.local.get('armyModel')).armyModel;
    await cizState.set(on ? { chatArmy: true, chatModel: model === 'speed' ? 'speed' : 'quality' } : { chatArmy: false });
  } catch {}
  await refreshArmyToday();
  setInterval(refreshArmyToday, 30 * 60 * 1000);
  try { await cizLocal.init(); } catch {}   // the allowed folders, and whether Zen lets the add-on into file: pages
  try { const o = await browser.storage.local.get('outputMode'); await cizState.set({ outputMode: o.outputMode === 'store' ? 'store' : 'download' }); } catch {}
  if (cizState.get().agent === 'active') cizNetLogStart();   // the network log watches only while the agent is active
  await cizState.addLog('info', 'Add-on started');
  resumeSignIn('startup');
  closeInstallerTabs();
  probeDebugPort();
  setInterval(probeDebugPort, 20000);
  if (cizState.get().agent === 'active') connectNative();
  updateBadge(cizState.get());
})();

// Opening Zen turns the agent on. A window counts as "Zen opened" when it is the only normal window, so
// a Stop lasts while Zen stays open, and a second window does not undo it or reconnect the helper.
browser.windows.onCreated.addListener(win => {
  if (!win || win.type !== 'normal') return;
  booted.then(async () => {
    const normal = await browser.windows.getAll({ windowTypes: ['normal'] });
    if (normal.length !== 1) return;
    if (cizState.get().agent === 'active') return connectNative();
    await cizState.set({ agent: 'active' });
    cizNetLogStart();
    await cizState.addLog('info', 'Zen opened: the agent is on.');
    connectNative();
  }).catch(e => cizState.addLog('error', `Auto-start failed: ${e.message || e}`));
});

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle().catch(() => browser.sidebarAction.open().catch(() => {}));
});
