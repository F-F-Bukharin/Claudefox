'use strict';
// Runs the add-on's background scripts (policy, state, tools, background) against a mocked
// browser API and checks the router gates, the chat relay and Stop.   node test/addon-smoke.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ext = path.join(__dirname, '..', 'extension');
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ev = () => { const fns = []; return { addListener: f => fns.push(f), fns, fire: (...a) => fns.forEach(f => f(...a)) }; };

// ---- mocked browser
const store = {};
const local = {};
const tabs = [
  { id: 1, windowId: 1, active: true, title: 'Shop', url: 'https://shop.example/', status: 'complete' },
  { id: 2, windowId: 1, active: false, title: 'Sign in', url: 'https://accounts.google.com/signin/v2', status: 'complete' },
  { id: 3, windowId: 1, active: false, title: 'Config', url: 'about:config', status: 'complete' },
  { id: 4, windowId: 1, active: false, title: 'xpi', url: 'file:///C:/Users/H/Mods/claude-in-zen/claude-in-zen.xpi', status: 'complete' },
  { id: 5, windowId: 1, active: false, title: 'other', url: 'file:///C:/Users/H/notes/claude-in-zen-notes.txt', status: 'complete' },
];
const removed = [];
const injected = [];
let native = null;   // the fake helper port
const connectEv = ev();
const browser = {
  storage: { local: {
    get: async k => (k in local ? { [k]: JSON.parse(JSON.stringify(local[k])) } : {}),
    set: async o => { for (const k in o) local[k] = JSON.parse(JSON.stringify(o[k])); },
    remove: async k => { delete local[k]; },
  }, session: {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, JSON.parse(JSON.stringify(store[k]))])),
    set: async o => { for (const k in o) store[k] = JSON.parse(JSON.stringify(o[k])); },
  } },
  runtime: {
    onConnect: connectEv,
    getManifest: () => JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')),
    connectNative: () => {
      const onMsg = ev(), onDisc = ev();
      native = { sent: [], onMessage: onMsg, onDisconnect: onDisc, disconnected: false,
        postMessage(m) { if (this.disconnected) throw new Error('closed'); this.sent.push(m); },
        disconnect() { this.disconnected = true; } };
      return native;
    },
  },
  browserAction: { onClicked: ev(), setBadgeText() {}, setBadgeBackgroundColor() {} },
  sidebarAction: { toggle: async () => {}, open: async () => {} },
  tabs: {
    query: async q => tabs.filter(t => (!q.active || t.active)),
    get: async id => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('no tab'); return t; },
    create: async o => { const t = { id: 9, windowId: 1, url: o.url, title: '', status: 'complete' }; tabs.push(t); return t; },
    update: async (id, o) => Object.assign(tabs.find(t => t.id === id), o),
    remove: async ids => { removed.push(...[].concat(ids)); },
    executeScript: async (id, o) => { injected.push(id); return [o.code.includes('"exists"') ? false : { ok: true, from: id }]; },
    onActivated: ev(), onUpdated: ev(),
  },
  windows: { update: async () => {} },
};
const fetch = async url => {
  if (String(url).includes('9222')) throw new Error('refused');
  return { status: 200, ok: true, json: async () => ({ account: { email_address: 'personalworksacc@gmail.com', full_name: 'F', uuid: 'u-1' } }) };
};

const ctx = vm.createContext({ browser, fetch, console, URL, AbortController, setTimeout, clearTimeout, setInterval: () => 0, Promise });
ctx.window = ctx;
for (const f of ['lib/policy.js', 'lib/state.js', 'lib/tools.js', 'background.js']) {
  vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx, { filename: f });
}

// ---- fake panel
const panelIn = [];
const panelOnMsg = ev();
const panel = { name: 'panel', onMessage: panelOnMsg, onDisconnect: ev(), postMessage: m => panelIn.push(m) };
const fromPanel = async m => { panelOnMsg.fire(m); await tick(); };
const helperSays = async m => { native.onMessage.fire(m); await tick(); };
const g = name => vm.runInContext(name, ctx);   // top-level const/let live in the script scope, not on the global
const call = (tool, args) => ctx.cizDebug.call(tool, args || {});

(async () => {
  try {
    await tick(50);
    connectEv.fire(panel);
    await tick();
    check('startup closes the leftover .xpi tab only', removed.includes(4) && !removed.includes(5) && !removed.includes(1), removed.join(','));
    check('panel gets state and chat runs on connect', panelIn.some(m => m.type === 'state') && panelIn.some(m => m.type === 'chatRuns'));

    let r = await call('tabs_list');
    check('tools refused before sign-in', !r.ok && /Not signed in/.test(r.error));
    await fromPanel({ type: 'signIn' });
    check('sign-in from the claude.ai session', g('cizState').get().signedIn && g('cizState').get().account.email === 'personalworksacc@gmail.com');
    check('sign-in is remembered, without cookies', local.rememberedAccount && local.rememberedAccount.email === 'personalworksacc@gmail.com' && Object.keys(local.rememberedAccount).sort().join() === 'at,email,name,uuid');

    // a fresh start (new session storage) signs back in on its own
    const ctx2 = vm.createContext({ browser: Object.assign({}, browser, { storage: { local: browser.storage.local, session: (() => { const s2 = {}; return {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in s2).map(k => [k, s2[k]])),
      set: async o => Object.assign(s2, JSON.parse(JSON.stringify(o))) }; })() } }),
      fetch, console, URL, AbortController, setTimeout, clearTimeout, setInterval: () => 0, Promise });
    ctx2.window = ctx2;
    const nativeBefore = native;
    for (const f of ['lib/policy.js', 'lib/state.js', 'lib/tools.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx2, { filename: f });
    await tick(80);
    check('restart signs back in from the remembered account', vm.runInContext('cizState', ctx2).get().signedIn === true);
    native = nativeBefore;

    await helperSays({ type: 'hello', version: '0.4.0', clients: [] });
    check('helper connected, Claude Code status asked', g('cizState').get().native === 'connected' && native.sent.some(m => m.type === 'claude_status'));
    await fromPanel({ type: 'checkClaude' });
    await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'personalworksacc@gmail.com', configDirectory: 'C:\\x\\claude' });
    check('check link logs what it found', g('cizState').log().some(e => /signed in as personalworksacc@gmail.com \(profile: C:\\x\\claude\)/.test(e.text)));

    r = await call('tabs_list');
    check('tabs_list works', r.ok && r.result.length === 5);
    r = await call('read_page', { tab_id: 2 });
    check('Google sign-in tab refused', !r.ok && /Google sign-in/.test(r.error) && !injected.includes(2));
    r = await call('get_page_text', { tab_id: 3 });
    check('about: page refused', !r.ok && /off-limits/.test(r.error) && !injected.includes(3));
    r = await call('navigate', { tab_id: 1, url: 'https://accounts.google.com/ServiceLogin' });
    check('navigate to Google sign-in refused', !r.ok && /Refused/.test(r.error));
    r = await call('tab_open', { url: 'file:///C:/secret.txt' });
    check('open file: URL refused', !r.ok && /off-limits/.test(r.error));
    r = await call('read_page', { tab_id: 1 });
    check('normal page reaches the page code', r.ok && injected.includes(1));
    r = await call('tab_close', {});
    check('tab_close needs a tab_id', !r.ok && /tab_id/.test(r.error));

    // chat relay
    await fromPanel({ type: 'chat', id: 'p1', text: 'hi' });
    const sent = native.sent.find(m => m.type === 'chat');
    check('chat goes to the helper, Speed by default', sent && sent.id === 'p1' && sent.text === 'hi' && sent.files === '' && sent.model === 'speed');
    await fromPanel({ type: 'chat', id: 'p2', text: 'again' });
    check('second message refused while busy', panelIn.some(m => m.type === 'chatDone' && m.id === 'p2' && !m.ok));
    await helperSays({ type: 'chat_event', id: 'p1', event: { kind: 'text', text: 'Hel' } });
    await helperSays({ type: 'chat_event', id: 'zzz', event: { kind: 'text', text: 'stray' } });
    check('stream reaches the panel, strays dropped', panelIn.some(m => m.type === 'chatEvent' && m.event.text === 'Hel') && !panelIn.some(m => m.type === 'chatEvent' && m.id === 'zzz'));
    await helperSays({ type: 'chat_done', id: 'p1', ok: true, sessionId: 'abc' });
    check('session kept for follow-ups', g('cizState').get().chatSession === 'abc');
    await fromPanel({ type: 'chat', id: 'p3', text: 'more' });
    check('follow-up resumes the session', native.sent.find(m => m.type === 'chat' && m.id === 'p3').resume === 'abc');
    await fromPanel({ type: 'chatCancel', id: 'p3' });
    check('cancel is passed on', native.sent.some(m => m.type === 'chat_cancel' && m.id === 'p3'));
    await helperSays({ type: 'chat_done', id: 'p3', ok: false, error: 'Claude AI usage limit reached', limit: true });
    check('limit flag reaches the panel', panelIn.some(m => m.type === 'chatDone' && m.id === 'p3' && m.limit));
    await fromPanel({ type: 'newChat' });
    check('/clear drops the session', g('cizState').get().chatSession === '');

    // update when linked to the project folder: a plain reload
    let reloaded = 0; browser.runtime.reload = () => { reloaded++; };
    await helperSays({ type: 'hello', version: '0.5.0', clients: [], sourceVersion: '0.5.0', canUpdate: true, linked: true });
    await fromPanel({ type: 'updateAddon' });
    await tick(400);
    check('linked update reloads instead of building', reloaded === 1 && !native.sent.some(m => m.type === 'update_addon'));
    await helperSays({ type: 'hello', version: '0.5.0', clients: [], sourceVersion: '0.5.0', canUpdate: true, linked: false });
    await fromPanel({ type: 'updateAddon' });
    check('unlinked update asks the helper to build', native.sent.some(m => m.type === 'update_addon'));
    await helperSays({ type: 'update_result', ok: true, version: '0.5.0' });

    // account switch
    await fromPanel({ type: 'switchAccount' });
    check('switch asks the helper', native.sent.some(m => m.type === 'claude_switch') && g('cizState').get().switching === true);
    await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'other@example.com' });
    await helperSays({ type: 'claude_switch_done', ok: true });
    check('switch done: logged, flag cleared', !g('cizState').get().switching && g('cizState').log().some(e => /now signed in as other@example.com/.test(e.text)));

    // file tools setting (sign-out check is at the end)
    await fromPanel({ type: 'setFiles', value: true, mode: 'write', folder: 'notes' });
    check('relative folder refused', g('cizState').get().filesEnabled === false);
    await fromPanel({ type: 'setFiles', value: true, mode: 'write', folder: 'C:\\Users\\F\\notes' });
    check('full folder turns file tools on', g('cizState').get().filesEnabled && g('cizState').get().filesMode === 'write');
    await fromPanel({ type: 'setPlus', value: true });
    await fromPanel({ type: 'chat', id: 'pp', text: 'plus' });
    check('Speed Plus sends speedplus', native.sent.find(m => m.type === 'chat' && m.id === 'pp').model === 'speedplus');
    await helperSays({ type: 'chat_done', id: 'pp', ok: true });
    await fromPanel({ type: 'setModel', value: 'quality' });
    await fromPanel({ type: 'chat', id: 'p4', text: 'list files' });
    const withFiles = native.sent.find(m => m.type === 'chat' && m.id === 'p4');
    check('chat carries the file mode, folder and Quality', withFiles.files === 'write' && withFiles.folder === 'C:\\Users\\F\\notes' && withFiles.model === 'quality');

    // Stop
    const port = native;
    const waiting = call('wait_for', { tab_id: 1, text: 'never shows', timeout_ms: 60000 });
    await tick(100);
    check('a long page action shows as pending', g('cizState').get().pending === 1);
    const tStop = Date.now();
    await fromPanel({ type: 'stop' });
    const s = g('cizState').get();
    check('Stop ends the open answer in the panel', panelIn.some(m => m.type === 'chatDone' && m.id === 'p4' && m.error === 'Stopped.'));
    check('Stop disconnects the helper and turns file tools off', port.disconnected && s.agent === 'stopped' && s.filesEnabled === false);
    const w = await waiting;
    check('Stop aborts the running page action at once', !w.ok && w.error === 'Stopped' && Date.now() - tStop < 500 && s.pending === 0, `${Date.now() - tStop} ms`);
    r = await call('tabs_list');
    check('tools refused while stopped', !r.ok && /stopped/.test(r.error));
    await fromPanel({ type: 'setFiles', value: true, mode: 'read', folder: 'C:\\x' });
    check('file tools cannot be turned on while stopped', g('cizState').get().filesEnabled === false);
    await fromPanel({ type: 'start' });
    check('Start reconnects the helper', g('cizState').get().agent === 'active' && native !== port);
    await fromPanel({ type: 'signOut' });
    check('signing out forgets the remembered account', !local.rememberedAccount && !g('cizState').get().signedIn);
  } catch (e) {
    check('no unexpected errors', false, e.stack);
  } finally {
    const failed = results.filter(r => !r).length;
    console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  }
})();
