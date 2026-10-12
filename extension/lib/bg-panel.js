'use strict';
// Claude in Zen: the background side of the panel. Panels connect by runtime port; handlePanel is the message switch.
// Also a chat reply's links and files: open a page or tab, download or store a file Claude made, screenshot a tab.

// ---------------------------------------------------------------- panel link

const panelPorts = new Set();

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  port.onMessage.addListener(msg => handlePanel(msg, port).catch(err => {
    cizState.addLog('error', `${msg && msg.type}: ${err.message || err}`);
  }));
  port.postMessage({ type: 'state', state: cizState.get(), log: cizState.log() });
  port.postMessage({ type: 'chatRuns', ids: [...chatRuns.keys()], queued: chatQueue.map(q => q.id) });
  // The helper replies with watch_state and asks the first-run question once. With no helper port yet, connectNative sends it (bg-chat.js).
  if (nativePort) sendNative({ type: 'watch_load' }); else watchLoadWanted = true;
  refreshArmyToday();   // the army card shows today's runs, even when Zen stayed open past midnight
});

try { if (browser.windows && browser.windows.onRemoved) browser.windows.onRemoved.addListener(id => chatWindowGone(id)); } catch {}

function postToPanels(msg) {
  for (const p of panelPorts) {
    try { p.postMessage(msg); } catch {}
  }
}

function pushToPanels(state, log) {
  for (const p of panelPorts) {
    try { p.postMessage({ type: 'state', state, log }); } catch {}
  }
}

async function handlePanel(msg, port) {
  switch (msg.type) {
    case 'signIn':     return signIn();   // a click: never "auto"
    case 'signOut':    return signOut();
    case 'stop':       return stopAll('Stop button');
    case 'start':      return startAgent();
    case 'setFiles':   return setFiles(!!msg.value, msg.mode, msg.folder);
    case 'pickFolder': return pickFolder();
    case 'retryNative': nativeRetries = 0; return connectNative();
    case 'checkClaude': return requestClaudeStatus(true);
    case 'accounts':      return sendNative({ type: 'accounts' });
    case 'accountUse':    return accountAction('account_use', msg.id, msg.retry);
    case 'switchAccount':                                   // 0.4 panels: "Log out and add another account"
    case 'accountAdd':    return accountAction('account_add');
    case 'accountSignIn': return accountAction('account_signin', msg.id);
    case 'accountRemove': return accountAction('account_remove', msg.id);
    case 'accountCancel': return sendNative({ type: 'account_cancel' });
    case 'updateAddon':
      if (cizState.get().linked) {
        // Linked to the project folder: a reload picks up every change, and reconnecting restarts the helper too.
        await cizState.addLog('info', 'Reloading from your project folder…');
        setTimeout(() => browser.runtime.reload(), 300);
        return;
      }
      if (!sendNative({ type: 'update_addon' })) return cizState.addLog('error', 'Update failed: the helper is not connected.');
      await cizState.set({ updating: true });
      return cizState.addLog('info', 'Building the add-on from your project folder…');
    case 'clearLog':   return cizState.clearLog();
    case 'openLink':   return openLink(String(msg.url || ''));
    case 'openTab':    return openTab(Number(msg.id));
    case 'openFile':   return openFile(String(msg.id || ''));
    case 'downloadFile': return downloadFile(String(msg.id || ''), !!msg.saveAs, String(msg.format || ''));
    case 'snapTab':    return snapTab(port, String(msg.req || ''), msg.windowId);
    case 'setOutput': {
      const value = msg.value === 'store' ? 'store' : 'download';
      try { await browser.storage.local.set({ outputMode: value }); } catch {}
      await cizState.set({ outputMode: value });
      return cizState.addLog('info', value === 'store' ? 'Files: stored in the output folder' : 'Files: downloaded, as before');
    }
    case 'setCaveman':
      try { await browser.storage.local.set({ caveman: !!msg.value }); } catch {}
      await cizState.set({ caveman: !!msg.value });
      return cizState.addLog('info', msg.value ? 'Caveman mode on: short replies' : 'Caveman mode off');
    // Settings > Tools and plugins: the helper does the work (host/lib/plugins.js)
    case 'tools':       return sendNative({ type: 'tools' });
    case 'toolsCheck':  return toolsSend({ type: 'tools_check' }, 'Checking every tool server…');
    case 'toolSet':     return toolsSend({ type: 'tool_set', kind: msg.kind === 'plugin' ? 'plugin' : 'server', id: String(msg.id || ''), value: !!msg.value },
      `${msg.value ? 'Turned on' : 'Turned off'} ${String(msg.label || msg.id || 'a tool').slice(0, 60)}`);
    case 'toolSignIn':  return toolsSend({ type: 'tool_signin', name: String(msg.name || '') });
    case 'toolCancel':  return sendNative({ type: 'tool_cancel' });
    case 'toolAdd':     return toolsSend({ type: 'tool_add', name: String(msg.name || '').slice(0, 60), target: String(msg.target || '').slice(0, 2000),
      header: String(msg.header || '').slice(0, 4100), on: !!msg.on }, `Adding ${String(msg.name || '').slice(0, 40)}…`);
    case 'toolRemove':  return toolsSend({ type: 'tool_remove', name: String(msg.name || '') }, `Removing ${String(msg.name || '').slice(0, 40)}…`);
    case 'pluginInstall': return toolsSend({ type: 'plugin_install', spec: String(msg.spec || '').slice(0, 200), source: String(msg.source || '').slice(0, 600) },
      `Installing ${String(msg.spec || '').slice(0, 60)}…`);
    case 'pluginUninstall': return toolsSend({ type: 'plugin_uninstall', id: String(msg.id || '') });
    case 'openClaude': return browser.tabs.create({ url: CIZ.CLAUDE_ORIGIN + '/' });
    case 'devCall':    return devCall(msg.tool);
    case 'call':       return panelCall(msg, port);
    case 'chat':       return startChat(msg);
    case 'chatCancel': return cancelChat(String(msg.id || ''));
    case 'chatUnqueue': return chatUnqueue(String(msg.id || ''));
    case 'selfApply':   return sendNative({ type: 'self_apply', id: String(msg.id || '') });
    case 'selfDiscard': return sendNative({ type: 'self_discard', id: String(msg.id || '') });
    case 'newChat':    if (typeof msg.windowId === 'number') winSessions.delete(msg.windowId); return cizState.set({ chatSession: '' });
    case 'histLog':    return cizState.addLog('info', String(msg.text || '').slice(0, 200));
    case 'setModel':   return setModel(msg.value === 'quality' ? 'quality' : 'speed');
    case 'setPlus':    return cizState.set({ chatPlus: !!msg.value });
    case 'setArmy':    return setArmy(!!msg.value);
    case 'setUnsafe': return setUnsafe(!!msg.value);
    case 'setWatch':       return setWatch(!!msg.value);
    case 'setWatchOnLoad': return setWatchOnLoad(!!msg.value);
    case 'watchShown':     return sendNative({ type: 'watch_shown', id: String(msg.id || '').slice(0, 40) });
    case 'watchAnswer':    return sendNative({ type: 'watch_answer', id: String(msg.id || '').slice(0, 40), allow: !!msg.allow });
    case 'downloadShown':  return sendNative({ type: 'download_shown', id: String(msg.id || '').slice(0, 40) });
    case 'downloadAnswer': return sendNative({ type: 'download_answer', id: String(msg.id || '').slice(0, 40), allow: !!msg.allow });
    case 'siteShown':      if (typeof cizSiteGate !== 'undefined') cizSiteGate.shown(String(msg.id || '').slice(0, 40)); return;
    case 'siteAnswer':
      if (typeof cizSiteGate !== 'undefined' && ['message', 'chat', 'deny', 'allow'].includes(msg.choice)) cizSiteGate.answer(String(msg.id || '').slice(0, 40), msg.choice);
      return;
    case 'setTrusted':     return setTrusted(!!msg.on);
    case 'siteListSet':    return siteListSet(msg.site, msg.value);
    case 'localGrantRemove': return cizLocal.remove(String(msg.folder || '').slice(0, 1000));
    case 'modUpdate':
      if (!sendNative({ type: 'mod_update', id: String(msg.id || ''), enabled: msg.enabled, broken: msg.broken })) return cizState.addLog('error', 'Mods: the helper is not connected, so the change was not saved.');
      return;
    case 'modsAllOff':
      if (!sendNative({ type: 'mods_all_off' })) return cizState.addLog('error', 'Mods: the helper is not connected, so nothing was turned off.');
      return;
    case 'modsRefresh':
      if (!sendNative({ type: 'mods' })) return cizState.addLog('error', 'Mods: the helper is not connected, so the folder was not checked.');
      return;
  }
}

// Chat test commands from the panel. Only the test tools are allowed here;
// real tool calls arrive from Claude over the native channel.
async function panelCall(msg, port) {
  const allowed = ['ping', 'tabs_list'];
  const out = allowed.includes(msg.tool)
    ? await dispatch(msg.tool, msg.args || {}, 'panel')
    : { ok: false, error: `Not available from the panel: ${msg.tool}` };
  try { port.postMessage(Object.assign({ type: 'callResult', id: msg.id }, out)); } catch {}
}

// Panel "Try it" buttons: real router calls, result summarised in the log.
async function devCall(tool) {
  if (!['ping', 'tabs_list'].includes(tool)) return;
  const out = await dispatch(tool, {}, 'panel');
  if (!out.ok) return cizState.addLog('error', `${tool}: ${out.error}`);
  if (tool === 'ping') return cizState.addLog('info', `ping → pong (v${out.result.version})`);
  const n = out.result.length;
  const active = out.result.find(t => t.active);
  return cizState.addLog('info', `tabs_list → ${n} tab${n === 1 ? '' : 's'}${active ? `; active: "${(active.title || active.url || '').slice(0, 60)}"` : ''}`);
}

// ---------------------------------------------------------------- links and files from the chat
// Replies can link to web pages, to open tabs (zen://tab/<id>) and to files Claude made (zen://file/<id>).

async function openLink(url) {
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return;
  await browser.tabs.create({ url, active: true });
}

async function openTab(id) {
  try {
    const t = await browser.tabs.get(id);
    cizArmy.show(id);   // Show on a worker's row: the user's own switch, which the army must not undo
    await browser.tabs.update(id, { active: true });
    try { await browser.windows.update(t.windowId, { focused: true }); } catch {}
  } catch { await cizState.addLog('error', `Tab ${id} is not open any more.`); }
}

async function openFile(id, pdf) {
  if (!/^f[0-9a-z]+$/.test(id)) return;
  await browser.tabs.create({ url: browser.runtime.getURL(`viewer.html${pdf ? '?pdf=1' : ''}#${id}`), active: true });
}

// format: '' (the file's own format), or docx, xlsx, html, md, txt, csv, pdf. Word and Excel files are built here
// from what Claude wrote (lib/docx.js); a PDF opens the file viewer, which saves the page as PDF.
async function downloadFile(id, saveAs, format) {
  const f = await cizFiles.get(id);
  if (!f) return cizState.addLog('error', 'That file is gone (deleted, or pushed out by newer files).');
  const ext = ((/\.([a-z0-9]{1,8})$/i.exec(f.name) || [])[1] || '').toLowerCase();
  const want = String(format || ext).toLowerCase();
  if (want === 'pdf') return openFile(id, true);
  let out;
  try { out = cizExport(f, want); } catch (e) {
    return cizState.addLog('error', `Could not make ${f.name}${want !== ext ? ` as .${want}` : ''}: ${e.message}`);
  }
  // Settings > Saving files: "Store in output folder" keeps a made file in Claude in Zen's data folder (…\claude-in-zen\output); Save as always asks.
  if (!saveAs && cizState.get().outputMode === 'store') {
    const r = await storeOutput(out);
    if (r.ok) {
      await cizState.addLog('action', `Stored ${r.name} in the output folder`);
      return postToPanels({ type: 'outputSaved', id, name: r.name, path: r.path });
    }
    await cizState.addLog('warn', `Could not store ${out.name} (${r.error}), so it was downloaded instead`);
  }
  const blob = typeof out.data === 'string' ? new Blob([out.data], { type: `${out.mime};charset=utf-8` }) : new Blob([out.data], { type: out.mime });
  const url = URL.createObjectURL(blob);
  try {
    const dl = await browser.downloads.download({ url, filename: `Claude in Zen/${cizSafeFileName(out.name)}`, conflictAction: 'uniquify', saveAs });
    await cizState.addLog('info', `Saved ${out.name} to Downloads\\Claude in Zen`);
    postToPanels({ type: 'downloaded', id, downloadId: dl });
  } catch (e) {
    if (!/cancel/i.test(e.message)) await cizState.addLog('error', `Download failed: ${e.message}`);
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}

// Settings > Saving files: the helper writes the file into the output folder in Claude in Zen's data folder (…\claude-in-zen\output). Resolves
// { ok: true, name, path } or { ok: false, error }; a helper that is missing, stops or is slow means a download instead.
function storeOutput(out) {
  if (!nativePort) connectNative();
  if (!nativePort) return Promise.resolve({ ok: false, error: 'the helper is not connected' });
  return new Promise(resolve => {
    const req = ++outputSeq;
    const done = r => { clearTimeout(timer); outputWaiters.delete(req); resolve(r); };
    const timer = setTimeout(() => done({ ok: false, error: 'the helper did not answer' }), 60000);
    let data;
    try {
      const bytes = typeof out.data === 'string' ? new TextEncoder().encode(out.data) : new Uint8Array(out.data);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      data = btoa(bin);
    } catch (e) { return done({ ok: false, error: `could not read the file (${e.message})` }); }
    outputWaiters.set(req, done);
    if (!sendNative({ type: 'save_output', req, name: out.name, data })) done({ ok: false, error: 'the helper is not connected' });
  });
}

// The + menu's "Screenshot of this tab": a PNG of the current tab, attached to the next message.
async function snapTab(port, req, windowId) {
  const reply = m => { try { port.postMessage(Object.assign({ type: 'snap', req }, m)); } catch {} };
  try {
    const [tab] = await browser.tabs.query(typeof windowId === 'number' ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
    if (!tab) return reply({ error: 'No tab to capture.' });
    const gate = cizUrlBlocked(tab.url || '', { unsafe: !!cizState.get().unsafe });
    if (gate.blocked) return reply({ error: `This tab can't be captured: ${gate.reason}.` });
    const data = await browser.tabs.captureTab(tab.id, { format: 'png' });
    let host = 'tab';
    try { host = new URL(tab.url).hostname.replace(/^www\./, '') || 'tab'; } catch {}
    reply({ data: String(data).replace(/^data:image\/png;base64,/, ''), name: `screenshot ${host}.png`, mime: 'image/png' });
  } catch (e) { reply({ error: `Screenshot failed: ${e.message}` }); }
}

function toolsSend(msg, note) {
  if (!sendNative(msg)) return cizState.addLog('error', 'Tools: the helper is not connected.');
  if (note) return cizState.addLog('info', note);
}

// create_file (lib/pageTools.js) asks which chat turn a new file belongs to, then tells the panels about it.
function cizFileContext() { const [id] = chatRuns.keys(); return { msg: id || '' }; }
function cizOnFileCreated(file) {
  cizState.addLog('action', `Claude made ${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`);
  postToPanels({ type: 'fileCreated', file });
}

// The file viewer page asks for downloads this way.
browser.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'downloadFile') return downloadFile(String(msg.id || ''), !!msg.saveAs, String(msg.format || ''));
});
