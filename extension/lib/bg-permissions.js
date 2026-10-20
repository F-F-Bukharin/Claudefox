'use strict';
// Claudefox: Stop and Start, the helper's confirm window, and the permission switches: file tools, unsafe mode,
// watch, Automatic (the state key `trusted`), the Sites list and the army. A question left open in the confirm window counts as no.

// ---------------------------------------------------------------- Stop
// Rule 1: Stop cancels pending actions, disconnects the native host and
// disables file tools. Nothing else.

async function stopAll(source) {
  // Everything is cut in this first step, before any await: a tool call, a worker's call or a folder question that
  // arrives while the tabs close below already finds the agent stopped and the helper gone. (set() changes the state
  // at once; only saving it waits.)
  if (typeof cfxFillCancel === 'function') cfxFillCancel();
  const stopped = cfxState.set({ agent: 'stopped', filesEnabled: false, unsafe: false, watch: false, watchAsk: null, downloadAsk: null, trusted: false, siteAsk: null, fillAsk: null, uploadAsk: null, pending: 0 });
  for (const [id, a] of pendingActions) {
    try { a.controller.abort(new Error('Stopped')); } catch {}
    pendingActions.delete(id);
  }
  sendNative({ type: 'watch_off' });   // before the helper goes: watching off, and a waiting card is cancelled
  if (typeof cfxWatchCancelAll === 'function') cfxWatchCancelAll();   // a video being watched stops, and its window closes
  sendNative({ type: 'download_off' });   // a picture card waiting is cancelled, and a download in progress stops
  sendNative({ type: 'trusted_off' });   // Automatic goes off with the other switches
  disconnectNative(t('bg_nativeUserStopped'));   // the helper exits, which kills any running Claude Code turn and its tool server
  endConfirms('Stopped.');       // an open confirm window counts as no (the helper closes it)
  if (typeof cfxSiteGate !== 'undefined') cfxSiteGate.cancel();   // an open site card counts as no
  if (typeof cfxUploadGate !== 'undefined') cfxUploadGate.cancel();   // an open upload card counts as no
  failChats(t('bg_stoppedShort'));
  cfxNetReset();                 // forget recorded requests, stop watching consoles, the network log's listeners go
  await stopped;
  await cfxLocal.cancelAll();    // an open folder question counts as no
  await cfxArmy.closeAll();      // every army worker's tab goes too
  await cfxState.addLog('stop', `Stopped (${source}). Pending actions and chat cancelled, army tabs closed, folder questions answered no, helper disconnected, file tools off, Unsafe mode off, network log cleared.`);
}

async function startAgent() {
  await cfxState.set({ agent: 'active' });
  cfxNetLogStart();
  await cfxState.addLog('info', 'Agent resumed');
  connectNative();
}

// "Choose folder…": the helper opens a folder window and answers with pick_folder_result.
async function pickFolder() {
  if (cfxState.get().folderPicking) return;
  if (!sendNative({ type: 'pick_folder' })) return cfxState.addLog('error', 'Choosing a folder needs the helper. Type the path instead.');
  await cfxState.set({ folderPicking: true });
}

// The helper's confirm window (host/lib/confirm.js): a Windows window outside Zen that nothing here can answer for
// the user, a mod included. Unsafe mode and file tools go on only after a yes there, and the helper gives chat turns
// only what was allowed. Resolves { ok, error }.
const confirmWaiters = new Map();   // id -> done(result)
let confirmSeq = 0;
function askConfirm(payload) {
  return new Promise(resolve => {
    const id = `k${++confirmSeq}`;
    const done = r => {
      clearTimeout(timer);
      confirmWaiters.delete(id);
      if (!confirmWaiters.size) cfxState.set({ confirmPending: null }).catch(() => {});
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: 'No answer from the confirm window.' }), 150000);
    confirmWaiters.set(id, done);
    if (!sendNative(Object.assign({ type: 'confirm', id }, payload))) return done({ ok: false, error: 'The helper is not connected, and it shows the confirm window. Press Start first.' });
    cfxState.set({ confirmPending: { kind: String(payload.kind) } }).catch(() => {});
  });
}
// Stop, or the helper went away: open questions count as no.
function endConfirms(why) { for (const done of [...confirmWaiters.values()]) done({ ok: false, error: why }); }

// keepOldOnNo (a folder picked while file tools are on): a no in the confirm window leaves file tools on for the folder
// they had, because the helper still has that one allowed. Returns { kept: true } then.
async function setFiles(value, mode, folder, { keepOldOnNo = false } = {}) {
  const m = mode === 'write' ? 'write' : 'read';
  const f = String(folder == null ? cfxState.get().filesFolder : folder).trim().slice(0, 1000);
  if (!value) {
    const was = cfxState.get().filesEnabled;
    await cfxState.set({ filesEnabled: false, filesMode: m, filesFolder: f });
    sendNative({ type: 'files_off' });
    if (was) await cfxState.addLog('info', 'File tools off');
    return;
  }
  if (cfxState.get().agent !== 'active') return;
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(f)) {
    await cfxState.set({ filesEnabled: false, filesMode: m, filesFolder: f });
    return cfxState.addLog('error', 'File tools need a full folder path, like C:\\Users\\you\\Documents\\notes. Left off.');
  }
  const r = await askConfirm({ kind: 'files', mode: m, folder: f });
  if (!r.ok && keepOldOnNo && cfxState.get().filesEnabled) {
    await cfxState.addLog('info', `Kept ${cfxState.get().filesFolder}: ${f} was not allowed (${r.error || 'not allowed in the confirm window.'})`);
    return { kept: true };
  }
  if (!r.ok) {
    await cfxState.set({ filesEnabled: false, filesMode: m, filesFolder: f });
    return cfxState.addLog('error', `File tools stay off: ${r.error || 'not allowed in the confirm window.'}`);
  }
  await cfxState.set({ filesEnabled: true, filesMode: m, filesFolder: f });
  await cfxState.addLog('info', `File tools on (${m === 'write' ? 'read and write' : 'read only'}) for ${f}`);
}

// Unsafe mode lets Claude act on Google sign-in pages, to debug the sign-in bug. It lasts for this
// session only: Stop, an add-on restart or a Zen restart turns it off. Passwords, 2FA codes and
// payment details are refused in every mode.
async function setUnsafe(value) {
  if (!value) {
    sendNative({ type: 'unsafe_off' });
    if (cfxState.get().unsafe) {
      await cfxState.set({ unsafe: false });
      await cfxState.addLog('info', 'Unsafe mode off');
    }
    return;
  }
  if (cfxState.get().agent !== 'active') return cfxState.addLog('error', 'Press Start first, then turn on Unsafe mode.');
  const r = await askConfirm({ kind: 'unsafe' });
  if (!r.ok) return cfxState.addLog('info', `Unsafe mode stays off: ${r.error || 'not allowed in the confirm window.'}`);
  await cfxState.set({ unsafe: true });
  await cfxState.addLog('warn', 'Unsafe mode on: Claude may act on Google sign-in pages. It still never types passwords, 2FA codes or payment details.');
}

// Automatic mode (the state key and messages are still `trusted`): the asks for pictures, sites, form sends, uploads, form
// filling and folders are answered Yes by themselves. Blocked sites, Google sign-in pages and protected folders stay refused.
// Session only: Stop, an add-on restart or a Zen restart turns it off, and the helper is told when it does.
async function setTrusted(on) {
  if (!on) {
    sendNative({ type: 'trusted_off' });
    await cfxState.set({ trusted: false });
    return;
  }
  if (cfxState.get().agent !== 'active') return cfxState.addLog('error', 'Press Start first, then turn on Automatic mode.');
  const r = await askConfirm({ kind: 'trusted' });
  if (!r.ok) return cfxState.addLog('info', `Automatic mode stays off: ${r.error || 'not allowed in the confirm window.'}`);
  await cfxState.set({ trusted: true });
  await cfxState.addLog('warn', 'Automatic on: Claude answers Yes by itself to pictures, other sites, form sends, uploads, form filling and folders until you press Stop or restart Zen. Google sign-in pages, blocked sites and protected folders stay off-limits. Pages can try to steer it.');
}

// The Sites list (storage.local sites): a site is its host, lowercase, with one leading www. dropped. Value 'allow' or 'block';
// null removes the site.
function listSiteOf(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  try { return new URL(t.includes('://') ? t : 'https://' + t).hostname.replace(/^www\./, ''); } catch { return ''; }
}
async function siteListSet(site, value) {
  const text = String(site || '').trim();
  if (!text) return;
  const host = listSiteOf(text);
  if (!host) return cfxState.addLog('error', `Sites: "${text.slice(0, 80)}" is not a site. Type a host name such as example.org.`);
  if (value !== 'allow' && value !== 'block' && value !== null) return;
  const { sites } = await browser.storage.local.get('sites');
  const next = Object.assign({}, sites);
  if (value === null) delete next[host]; else next[host] = value;
  await browser.storage.local.set({ sites: next });
}

// Watch videos (the watch_video tool). The switch lasts for this session: Stop, an add-on restart or a Zen restart turns
// it off. Turning it on asks the helper's confirm window; the helper keeps the switch in step with watch_state.
async function setWatch(value) {
  if (!value) {
    sendNative({ type: 'watch_off' });
    if (typeof cfxWatchCancelAll === 'function') cfxWatchCancelAll();
    if (cfxState.get().watch) {
      await cfxState.set({ watch: false });
      await cfxState.addLog('info', 'Watch videos off');
    }
    return;
  }
  if (cfxState.get().agent !== 'active') return cfxState.addLog('error', 'Press Start first, then turn on watching.');
  const r = await askConfirm({ kind: 'watch' });
  if (!r.ok) return cfxState.addLog('info', `Watch videos stays off: ${r.error || 'not allowed in the confirm window.'}`);
  await cfxState.set({ watch: true });
  await cfxState.addLog('info', 'Watch videos on for this session.');
}

// The saved option "Start with watching on". Off is saved at once. On asks the confirm window; the helper saves the answer
// (a no saves Off) and replies with watch_state, which sets watchOnLoad.
async function setWatchOnLoad(value) {
  if (!value) {
    sendNative({ type: 'watch_set_on_load', value: false });
    return cfxState.set({ watchOnLoad: false });
  }
  const r = await askConfirm({ kind: 'watch_on_load' });
  if (!r.ok) return cfxState.addLog('info', `Watching every time the panel opens stays off: ${r.error || 'not allowed in the confirm window.'}`);
}

// The army switch (Quality only): Opus 5.5 at max effort may send up to five Haiku workers to background tabs.
// Remembered across restarts. Turning it on picks Quality.
async function setArmy(value) {
  try { await browser.storage.local.set(value ? { armyOn: true, armyModel: 'quality' } : { armyOn: false }); } catch {}
  await cfxState.set({ chatArmy: value, ...(value ? { chatModel: 'quality' } : {}) });
  return cfxState.addLog('info', value ? 'Army on: Opus 5.5 may send Haiku workers to background tabs' : 'Army off');
}

// Today's local date, YYYY-MM-DD: the army run counter starts over each day.
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Speed or Quality. With the army switch on, the mode is remembered with it, so a restart comes back as it was left.
async function setModel(model) {
  await cfxState.set({ chatModel: model });
  if (cfxState.get().chatArmy) { try { await browser.storage.local.set({ armyModel: model }); } catch {} }
}

// Today's army runs, read again: the count starts over at midnight even while Zen stays open (startup, every half
// hour, and whenever a panel opens).
async function refreshArmyToday() {
  let count, tokens;
  try {
    const r = (await browser.storage.local.get('armyRuns')).armyRuns;
    count = r && r.day === localDay() ? Number(r.count) || 0 : 0;
    const t = (await browser.storage.local.get('armyTokens')).armyTokens;
    tokens = t && t.date === localDay() ? Number(t.tokens) || 0 : 0;
  } catch { return; }
  const s = cfxState.get();
  if (s.armyToday !== count || s.armyTokensToday !== tokens) await cfxState.set({ armyToday: count, armyTokensToday: tokens });
}

// A new army run: count it for today. 5 a day is the recommended most; the panel warns past that, nothing blocks.
async function countArmyRun() {
  const day = localDay();
  let count = 0;
  try {
    const r = (await browser.storage.local.get('armyRuns')).armyRuns;
    count = r && r.day === day ? Number(r.count) || 0 : 0;
  } catch { count = cfxState.get().armyToday || 0; }
  count++;
  try { await browser.storage.local.set({ armyRuns: { day, count } }); } catch {}
  await cfxState.set({ armyToday: count });
  return count;
}

// The tokens an army turn used (its input and output, from the helper's stats), added to today's count (storage.local armyTokens).
async function countArmyTokens(n) {
  const day = localDay();
  let tokens = 0;
  try {
    const r = (await browser.storage.local.get('armyTokens')).armyTokens;
    tokens = r && r.date === day ? Number(r.tokens) || 0 : 0;
  } catch { tokens = cfxState.get().armyTokensToday || 0; }
  tokens += n;
  try { await browser.storage.local.set({ armyTokens: { date: day, tokens } }); } catch {}
  await cfxState.set({ armyTokensToday: tokens });
  return tokens;
}
