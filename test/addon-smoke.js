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
const local = { sites: { 'shop.example': 'allow', 'accounts.google.com': 'allow', 'docs.google.com': 'allow' } };   // fixture: the site gate lets the hosts these tests use through
const tabs = [
  { id: 1, windowId: 1, active: true, title: 'Shop', url: 'https://shop.example/', status: 'complete' },
  { id: 2, windowId: 1, active: false, title: 'Sign in', url: 'https://accounts.google.com/signin/v2', status: 'complete' },
  { id: 3, windowId: 1, active: false, title: 'Config', url: 'about:config', status: 'complete' },
  { id: 4, windowId: 1, active: false, title: 'xpi', url: 'file:///C:/Users/H/Mods/claude-in-zen/claude-in-zen.xpi', status: 'complete' },
  { id: 5, windowId: 1, active: false, title: 'other', url: 'file:///C:/Users/H/notes/claude-in-zen-notes.txt', status: 'complete' },
  { id: 6, windowId: 1, active: false, title: 'Lista 3 - Google Docs', url: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit', status: 'complete' },
];
const webRequest = { onBeforeRequest: ev(), onSendHeaders: ev(), onHeadersReceived: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() };
const removed = [];
const injected = [];
let native = null;   // the fake helper port
const connectEv = ev();
const winCreated = ev();
let normalWindows = [{ id: 1, type: 'normal' }];   // the Zen windows open now
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
    onMessage: ev(),
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
    onActivated: ev(), onUpdated: ev(), onCreated: ev(), onRemoved: ev(),
  },
  webRequest,
  windows: { update: async () => {}, onCreated: winCreated,
    getAll: async o => normalWindows.filter(w => !o || !o.windowTypes || o.windowTypes.includes(w.type)) },
};
const fetched = [];
let claudeEmail = 'f.work@example.com';   // the claude.ai session the add-on reads
const fetch = async url => {
  fetched.push(String(url));
  if (String(url).includes('9222')) throw new Error('refused');
  if (/docs\.google\.com\/document\/d\/[^/]+\/export\?format=md/.test(url)) {
    return { status: 200, ok: true, headers: { get: () => 'text/markdown; charset=utf-8' }, text: async () => '# Lista 3\n\n1. Calcule a velocidade média.\n2. Explique a segunda lei.' };
  }
  return { status: 200, ok: true, json: async () => ({ account: { email_address: claudeEmail, full_name: 'F', uuid: 'u-1' } }) };
};

const ctx = vm.createContext({ browser, fetch, console, URL, URLSearchParams, AbortController, TextEncoder, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, Promise });
ctx.window = ctx;
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')).background.scripts;   // the real load order
for (const f of SCRIPTS) {
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

// The helper's confirm window answers (host/lib/confirm.js): the last question the add-on sent gets this answer.
const answerConfirm = async ok => {
  const q = [...native.sent].reverse().find(m => m.type === 'confirm');
  native.onMessage.fire({ type: 'confirm_result', id: q && q.id, ok, error: ok ? '' : 'The answer in the confirm window was no.' });
  await tick();
  return q;
};
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
    check('sign-in from the claude.ai session', g('cizState').get().signedIn && g('cizState').get().account.email === 'f.work@example.com');
    check('sign-in is remembered, without cookies', local.rememberedAccount && local.rememberedAccount.email === 'f.work@example.com' && Object.keys(local.rememberedAccount).sort().join() === 'at,email,name,uuid');

    // a fresh start (new session storage) signs back in on its own
    const ctx2 = vm.createContext({ browser: Object.assign({}, browser, { storage: { local: browser.storage.local, session: (() => { const s2 = {}; return {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in s2).map(k => [k, s2[k]])),
      set: async o => Object.assign(s2, JSON.parse(JSON.stringify(o))) }; })() } }),
      fetch, console, URL, URLSearchParams, AbortController, TextEncoder, setTimeout, clearTimeout, setInterval: () => 0, Promise });
    ctx2.window = ctx2;
    const nativeBefore = native;
    for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx2, { filename: f });
    await tick(80);
    check('restart signs back in from the remembered account', vm.runInContext('cizState', ctx2).get().signedIn === true);
    native = nativeBefore;

    await helperSays({ type: 'hello', version: '0.4.0', clients: [] });
    check('helper connected, Claude Code status asked', g('cizState').get().native === 'connected' && native.sent.some(m => m.type === 'claude_status'));
    await fromPanel({ type: 'checkClaude' });
    await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'f.work@example.com', configDirectory: 'C:\\x\\claude' });
    check('check link logs what it found', g('cizState').log().some(e => /signed in as f.work@example.com \(profile: C:\\x\\claude\)/.test(e.text)));
    // The tools list reaches the panel with the helper's reason for a blocked shell; a refused switch is logged.
    await helperSays({ type: 'tools', plugins: [{ id: 'desktop-commander@test', label: 'Desktop Commander', local: true, on: false, blocked: 'It gives Claude a shell.',
      servers: [{ name: 'plugin:desktop-commander:desktop-commander', label: 'desktop-commander', transport: 'stdio', local: true, on: false, blocked: 'It gives Claude a shell.' }] }], connectors: [], added: [] });
    await helperSays({ type: 'tool_result', action: 'set', ok: false, error: 'Desktop Commander: It gives Claude a shell.', name: 'desktop-commander@test', label: 'Desktop Commander' });
    const tl = g('cizState').get().tools;
    check('tools: a blocked shell keeps its reason on the way to the panel, and a refused switch is logged', tl && tl.plugins[0].blocked === 'It gives Claude a shell.' && tl.plugins[0].servers[0].blocked === 'It gives Claude a shell.'
      && !tl.plugins[0].on && g('cizState').log().some(e => e.kind === 'error' && /^Desktop Commander: It gives Claude a shell\.$/.test(e.text)), JSON.stringify(tl && tl.plugins[0]));

    r = await call('tabs_list');
    check('tabs_list works', r.ok && r.result.length === 6);
    r = await call('read_page', { tab_id: 2 });
    check('Google sign-in tab refused', !r.ok && /Google sign-in/.test(r.error) && !injected.includes(2));
    r = await call('get_page_text', { tab_id: 3 });
    check('about: page refused (screenshot only)', !r.ok && /browser page.*screenshot shows it/.test(r.error) && !injected.includes(3));
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
    check('second message waits in the queue while busy, not refused', panelIn.some(m => m.type === 'chatQueued' && m.id === 'p2') && !panelIn.some(m => m.type === 'chatDone' && m.id === 'p2') && native.sent.filter(m => m.type === 'chat').length === 1);
    await fromPanel({ type: 'chatUnqueue', id: 'p2' });   // the x on the waiting bubble
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

    // Improve Claude in Zen (the + menu): an empty message is fine; it runs Opus max with no tab and no files. The
    // proposal reaches the panel, and Apply and Discard go to the helper.
    await fromPanel({ type: 'chat', id: 'imp1', text: '', improve: true });
    const imp = native.sent.find(m => m.type === 'chat' && m.id === 'imp1');
    check('an improve message goes to the helper as selfimprove: no tab, no files, no resume', !!imp && imp.improve === true && imp.model === 'selfimprove' && imp.files === '' && imp.tab === null && imp.resume === '' && imp.unsafe === false && imp.caveman === false);
    await helperSays({ type: 'chat_event', id: 'imp1', event: { kind: 'proposal', id: 'abc123def456', changed: 1, added: 1, removed: 0, files: [], blocked: [], tests: { ok: true, summary: 'All test files passed', tail: '' }, canApply: true, diff: '', diffFile: '' } });
    await helperSays({ type: 'chat_done', id: 'imp1', ok: true, sessionId: '' });
    check('the proposal reaches the panel', panelIn.some(m => m.type === 'chatEvent' && m.id === 'imp1' && m.event.kind === 'proposal'));
    await fromPanel({ type: 'selfApply', id: 'abc123def456' });
    check('Apply goes to the helper as self_apply', native.sent.some(m => m.type === 'self_apply' && m.id === 'abc123def456'));
    await helperSays({ type: 'self_result', id: 'abc123def456', ok: true, text: 'Applied 1 file.', files: ['extension/panel.js'] });
    check('the result reaches the panel', panelIn.some(m => m.type === 'selfResult' && m.id === 'abc123def456' && m.ok === true));
    await fromPanel({ type: 'selfDiscard', id: 'abc123def456' });
    check('Discard goes to the helper as self_discard', native.sent.some(m => m.type === 'self_discard' && m.id === 'abc123def456'));
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

    // accounts (Google-style list: switch, add, retry after a usage limit)
    await helperSays({ type: 'accounts', login: null, accounts: [
      { id: 'main', email: 'me@example.com', loggedIn: true, active: true },
      { id: 'a1', email: 'other@example.com', loggedIn: true, active: false }] });
    check('the accounts list is kept for the panel', g('cizState').get().accounts.length === 2 && g('cizState').get().accounts[1].email === 'other@example.com');
    await fromPanel({ type: 'accountUse', id: 'a1', retry: 'try that again' });
    check('switch asks the helper', native.sent.some(m => m.type === 'account_use' && m.id === 'a1'));
    check('a switch in progress is marked for the panel', g('cizState').get().accountBusy === 'a1');
    await helperSays({ type: 'account_result', action: 'use', id: 'a1', ok: true, email: 'other@example.com' });
    check('switch done: logged, conversation reset, message retried',
      g('cizState').get().chatSession === '' && g('cizState').log().some(e => /Chat now uses other@example.com/.test(e.text))
      && panelIn.some(m => m.type === 'retry' && m.text === 'try that again'));
    check('a finished switch clears the mark and says which account the chat uses', g('cizState').get().accountBusy === '' && g('cizState').get().accountNote.ok === true && /now uses other@example.com/.test(g('cizState').get().accountNote.text));
    await fromPanel({ type: 'accountUse', id: 'a1' });
    await helperSays({ type: 'account_result', action: 'use', id: 'a1', ok: false, error: 'Claude is still answering. Switch accounts after it finishes.' });
    check('a refused switch is shown in Profile too', g('cizState').get().accountBusy === '' && g('cizState').get().accountNote.ok === false && /still answering/.test(g('cizState').get().accountNote.text));
    const addonEmail = () => (g('cizState').get().account || {}).email;
    claudeEmail = 'other@example.com';
    await fromPanel({ type: 'accountUse', id: 'a1' });
    await helperSays({ type: 'account_result', action: 'use', id: 'a1', ok: true, email: 'other@example.com' });
    check('a switch re-reads claude.ai, so the add-on follows an account already signed in there', addonEmail() === 'other@example.com', addonEmail());
    claudeEmail = 'f.work@example.com';
    browser.tabs.onUpdated.fire(1, { status: 'loading' }, { url: 'https://claude.ai/chats' });
    await tick();
    check('a claude.ai page still loading changes nothing', addonEmail() === 'other@example.com');
    browser.tabs.onUpdated.fire(1, { status: 'complete' }, { url: 'https://claude.ai/chats' });
    await tick();
    check('a claude.ai page that loads moves the add-on to the account claude.ai is on', addonEmail() === 'f.work@example.com', addonEmail());
    claudeEmail = 'other@example.com';
    browser.tabs.onUpdated.fire(1, { status: 'complete' }, { url: 'https://example.com/' });
    await tick();
    check('a page that is not claude.ai does not change the add-on', addonEmail() === 'f.work@example.com');
    browser.tabs.onUpdated.fire(1, { status: 'complete' }, { url: 'https://claude.ai/chats' });
    await tick();
    check('the next claude.ai page follows the account again', addonEmail() === 'other@example.com', addonEmail());
    claudeEmail = 'f.work@example.com';
    await fromPanel({ type: 'accountUse', id: 'a1' });
    await helperSays({ type: 'account_result', action: 'use', id: 'a1', ok: true, email: 'other@example.com' });
    check('the chat switch leaves the add-on as the account claude.ai is on, and says the note', addonEmail() === 'f.work@example.com' && g('cizState').get().accountNote.ok === true);
    await fromPanel({ type: 'accountAdd' });
    check('add asks the helper', native.sent.some(m => m.type === 'account_add'));
    await helperSays({ type: 'account_result', action: 'login_started', id: 'a2', ok: true, isNew: true });
    check('an open sign-in window reaches the panel', (g('cizState').get().accountLogin || {}).id === 'a2');
    await helperSays({ type: 'account_result', action: 'login', id: 'a2', ok: true, email: 'third@example.com' });
    check('a finished sign-in clears it and says who', g('cizState').get().accountLogin === null && g('cizState').log().some(e => /Signed in as third@example.com/.test(e.text)));

    // Choose folder: a folder window answers, and the folder picked becomes the file tools folder
    await fromPanel({ type: 'pickFolder' });
    check('Choose folder asks the helper for a folder window', native.sent.some(m => m.type === 'pick_folder') && g('cizState').get().folderPicking === true);
    await helperSays({ type: 'pick_folder_result', ok: true, path: '', cancelled: true });
    check('a cancelled folder window changes nothing', g('cizState').get().folderPicking === false && g('cizState').get().filesFolder !== 'C:\\Users\\F\\Notes');
    await fromPanel({ type: 'pickFolder' });
    await helperSays({ type: 'pick_folder_result', ok: true, path: 'C:\\Users\\F\\Notes', cancelled: false });
    check('the folder picked becomes the file tools folder', g('cizState').get().filesFolder === 'C:\\Users\\F\\Notes' && g('cizState').get().folderPicking === false);
    await fromPanel({ type: 'pickFolder' });
    await helperSays({ type: 'pick_folder_result', ok: false, error: 'The folder window did not finish. Type the path instead.' });
    check('a folder window that fails says so and stops waiting', g('cizState').get().folderPicking === false && g('cizState').log().some(e => /did not finish/.test(e.text)));

    // file tools setting (sign-out check is at the end)
    await fromPanel({ type: 'setFiles', value: true, mode: 'write', folder: 'notes' });
    check('relative folder refused', g('cizState').get().filesEnabled === false);
    await fromPanel({ type: 'setFiles', value: true, mode: 'write', folder: 'C:\\Users\\F\\notes' });
    const waitingFiles = g('cizState').get();
    check('file tools wait for the helper\'s confirm window before they go on', waitingFiles.filesEnabled === false && waitingFiles.confirmPending && waitingFiles.confirmPending.kind === 'files');
    const fq = await answerConfirm(true);
    check('a yes in the confirm window turns file tools on for that folder and mode', g('cizState').get().filesEnabled && g('cizState').get().filesMode === 'write'
      && fq.kind === 'files' && fq.mode === 'write' && fq.folder === 'C:\\Users\\F\\notes' && g('cizState').get().confirmPending === null, JSON.stringify(fq));
    await fromPanel({ type: 'setPlus', value: true });
    await fromPanel({ type: 'chat', id: 'pp', text: 'plus' });
    check('Speed Plus sends speedplus', native.sent.find(m => m.type === 'chat' && m.id === 'pp').model === 'speedplus');
    await helperSays({ type: 'chat_done', id: 'pp', ok: true });
    await fromPanel({ type: 'setModel', value: 'quality' });
    await fromPanel({ type: 'chat', id: 'p4', text: 'list files' });
    const withFiles = native.sent.find(m => m.type === 'chat' && m.id === 'p4');
    check('chat carries the file mode, folder and Quality', withFiles.files === 'write' && withFiles.folder === 'C:\\Users\\F\\notes' && withFiles.model === 'quality');

    // A folder picked while file tools are on goes through the confirm window before it replaces the old one; a no keeps the old folder.
    await fromPanel({ type: 'pickFolder' });
    await helperSays({ type: 'pick_folder_result', ok: true, path: 'C:\\Users\\F\\Other', cancelled: false });
    const pickAsk = await answerConfirm(false);
    check('a picked folder asks the confirm window while file tools are on', !!pickAsk && pickAsk.kind === 'files' && pickAsk.folder === 'C:\\Users\\F\\Other' && pickAsk.mode === 'write', JSON.stringify(pickAsk));
    check('a no for the picked folder keeps file tools on, for the old folder', g('cizState').get().filesEnabled === true && g('cizState').get().filesFolder === 'C:\\Users\\F\\notes' && g('cizState').get().filesMode === 'write'
      && g('cizState').get().confirmPending === null, JSON.stringify([g('cizState').get().filesEnabled, g('cizState').get().filesFolder]));
    check('the log says the old folder was kept', g('cizState').log().some(e => /Kept C:\\Users\\F\\notes/.test(e.text) && /C:\\Users\\F\\Other/.test(e.text)), g('cizState').log().slice(-3).map(e => e.text).join(' | '));
    await fromPanel({ type: 'pickFolder' });
    await helperSays({ type: 'pick_folder_result', ok: true, path: 'C:\\Users\\F\\Other', cancelled: false });
    await answerConfirm(true);
    check('a yes for the picked folder moves file tools to it', g('cizState').get().filesEnabled === true && g('cizState').get().filesFolder === 'C:\\Users\\F\\Other');

    // The helper says what it allowed, and the switches follow it (a restarted helper has forgotten them).
    await helperSays({ type: 'confirmed_state', unsafe: false, trusted: false, files: { mode: 'read', folder: 'C:\\Users\\F\\Mirror' } });
    check('confirmed_state with files turns file tools on for that mode and folder', g('cizState').get().filesEnabled === true && g('cizState').get().filesMode === 'read' && g('cizState').get().filesFolder === 'C:\\Users\\F\\Mirror');
    await helperSays({ type: 'confirmed_state', unsafe: false, trusted: false, files: null });
    check('confirmed_state with no files turns file tools off and keeps the remembered mode and folder', g('cizState').get().filesEnabled === false && g('cizState').get().filesMode === 'read' && g('cizState').get().filesFolder === 'C:\\Users\\F\\Mirror');
    check('the log says the helper did not keep the file tools', g('cizState').log().some(e => /File tools are off: the helper restarted and did not keep them/.test(e.text)));
    const logLen = g('cizState').log().length;
    await helperSays({ type: 'confirmed_state', unsafe: false, trusted: false, files: null });
    check('a state that changes nothing logs nothing', g('cizState').log().length === logLen);
    await helperSays({ type: 'error', error: 'A reply was too large to send.' });
    check('an error from the helper is logged', g('cizState').log().some(e => e.kind === 'error' && e.text === 'Helper: A reply was too large to send.'));

    // Unsafe mode: Claude may read the Google sign-in tab only while it is on
    await fromPanel({ type: 'setUnsafe', value: true });
    await answerConfirm(false);
    check('a no in the confirm window keeps Unsafe mode off', g('cizState').get().unsafe === false && g('cizState').get().confirmPending === null);
    await fromPanel({ type: 'setUnsafe', value: true });
    const uq = await answerConfirm(true);
    check('Unsafe mode turns on from the panel after a yes in the confirm window', g('cizState').get().unsafe === true && uq.kind === 'unsafe');
    r = await call('read_page', { tab_id: 2 });
    check('Unsafe mode lets Claude read the Google sign-in tab', r.ok && injected.includes(2));
    r = await call('get_page_text', { tab_id: 3 });
    check('Unsafe mode still refuses about: pages', !r.ok && /browser page.*screenshot shows it/.test(r.error));
    await helperSays({ type: 'confirmed_state', unsafe: false, trusted: false, files: null });
    check('confirmed_state with Unsafe mode off turns it off, and says why', g('cizState').get().unsafe === false && g('cizState').log().some(e => /Unsafe mode is off: the helper restarted and did not keep it/.test(e.text)));
    await fromPanel({ type: 'setUnsafe', value: true });
    await answerConfirm(true);
    await helperSays({ type: 'confirmed_state', unsafe: true, trusted: false, files: null });
    check('confirmed_state with Unsafe mode on keeps it on', g('cizState').get().unsafe === true);

    // ---- watch switch (Task 9): the switch, the saved option and the card messages (the helper decides; see lib/watchgate.js)
    await fromPanel({ type: 'setWatch', value: true });
    const wq0 = await answerConfirm(false);
    check('watch: a no in the confirm window keeps watching off and leaves no question open', g('cizState').get().watch === false && g('cizState').get().confirmPending === null && (wq0 || {}).kind === 'watch');
    await fromPanel({ type: 'setWatch', value: true });
    const wq = await answerConfirm(true);
    check('watch: a yes in the confirm window turns watching on for this session', g('cizState').get().watch === true && (wq || {}).kind === 'watch');
    check('watch: the log says it is on for this session', g('cizState').log().some(e => e.text === 'Watch videos on for this session.'));
    await fromPanel({ type: 'setWatch', value: false });
    check('watch: the switch off sends watch_off to the helper and clears the flag', native.sent.some(m => m.type === 'watch_off') && g('cizState').get().watch === false);
    await fromPanel({ type: 'setWatchOnLoad', value: true });
    const ol0 = await answerConfirm(false);
    check('watch: a no to saving On leaves the saved option as it was and sends no watch_set_on_load', g('cizState').get().watchOnLoad === null && (ol0 || {}).kind === 'watch_on_load' && !native.sent.some(m => m.type === 'watch_set_on_load'));
    await fromPanel({ type: 'setWatchOnLoad', value: true });
    const ol = await answerConfirm(true);
    await helperSays({ type: 'watch_state', watch: false, watchOnLoad: true });
    check("watch: a yes to saving On takes the option from the helper's reply", g('cizState').get().watchOnLoad === true && (ol || {}).kind === 'watch_on_load');
    await fromPanel({ type: 'setWatchOnLoad', value: false });
    check('watch: turning the option off is sent at once and sets it to false', native.sent.some(m => m.type === 'watch_set_on_load' && m.value === false) && g('cizState').get().watchOnLoad === false);
    check('watch: the panel load asked the helper for the watch state, once', native.sent.filter(m => m.type === 'watch_load').length === 1);
    await helperSays({ type: 'watch_ask', id: 'w1', source: 'clip.mp4' });
    check('watch: a card from the helper sets the waiting question', (g('cizState').get().watchAsk || {}).id === 'w1' && (g('cizState').get().watchAsk || {}).source === 'clip.mp4');
    await fromPanel({ type: 'watchShown', id: 'w1' });
    await fromPanel({ type: 'watchAnswer', id: 'w1', allow: true });
    check('watch: the card shown and the answer reach the helper with the same id', native.sent.some(m => m.type === 'watch_shown' && m.id === 'w1') && native.sent.some(m => m.type === 'watch_answer' && m.id === 'w1' && m.allow === true));
    await helperSays({ type: 'watch_ask_done', id: 'other' });
    check('watch: a done for another card is ignored', (g('cizState').get().watchAsk || {}).id === 'w1');
    await helperSays({ type: 'watch_ask_done', id: 'w1' });
    check('watch: the helper ends the card', g('cizState').get().watchAsk === null);
    await fromPanel({ type: 'setWatch', value: true });
    await answerConfirm(true);
    await helperSays({ type: 'watch_ask', id: 'w2', source: 'clip2.mp4' });
    check('watch: switched on again, with a card waiting (checked at Stop)', g('cizState').get().watch === true && (g('cizState').get().watchAsk || {}).id === 'w2');

    // Google Docs: read through the export, with the user's session
    r = await call('get_page_text', { tab_id: 6 });
    check('Google Docs are read through their export', r.ok && /Google Doc, read through its export/.test(r.result.text) && /Calcule a velocidade/.test(r.result.text) && r.result.title === 'Lista 3'
      && fetched.some(u => u === 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=md'), r.error || '');

    // Network log: the redirect chain of a sign-in, with cookie names and flags, never values or tokens
    const wrq = (n, d) => webRequest[n].fire(Object.assign({ tabId: 1, requestId: 'r1', timeStamp: 1000, method: 'GET', type: 'main_frame', frameId: 0 }, d));
    wrq('onBeforeRequest', { url: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmail.google.com&token=SECRET123&hl=pt-BR' });
    wrq('onSendHeaders', { requestHeaders: [{ name: 'Cookie', value: 'NID=abc123secret; SID=zzz' }] });
    wrq('onHeadersReceived', { statusCode: 302, responseHeaders: [{ name: 'Set-Cookie', value: 'GAPS=1:topsecretvalue; Domain=accounts.google.com; Secure; HttpOnly; SameSite=None; Max-Age=63072000' }] });
    wrq('onBeforeRedirect', { statusCode: 302, redirectUrl: 'https://accounts.google.com/CheckCookie?checkedDomains=youtube&continue=x' });
    wrq('onBeforeRequest', { timeStamp: 1200, url: 'https://accounts.google.com/CheckCookie?checkedDomains=youtube&continue=x' });
    wrq('onSendHeaders', { requestHeaders: [{ name: 'Cookie', value: 'NID=abc123secret' }] });
    wrq('onBeforeRedirect', { statusCode: 302, redirectUrl: 'https://support.google.com/accounts/topic/7189049?hl=pt-BR' });
    wrq('onBeforeRequest', { timeStamp: 1500, url: 'https://support.google.com/accounts/topic/7189049?hl=pt-BR' });
    wrq('onCompleted', { statusCode: 200 });
    webRequest.onBeforeRequest.fire({ tabId: 1, requestId: 'img1', timeStamp: 1600, method: 'GET', type: 'image', url: 'https://support.google.com/logo.png' });
    r = await call('network_log', { tab_id: 1 });
    const nl = r.ok ? r.result.text : '';
    check('network log shows the redirect chain hop by hop', r.ok && r.result.entries === 3 && /302 page https:\/\/accounts\.google\.com\/ServiceLogin.*-> https:\/\/accounts\.google\.com\/CheckCookie/.test(nl)
      && /-> https:\/\/support\.google\.com\/accounts\/topic\/7189049/.test(nl) && /200 page https:\/\/support\.google\.com/.test(nl), nl);
    check('network log keeps cookie names and flags, never values or tokens', /cookies sent: NID, SID/.test(nl) && /GAPS \(Domain=accounts\.google\.com, Secure, HttpOnly, SameSite=None, persistent\)/.test(nl)
      && /token=\[hidden\]/.test(nl) && !/SECRET123|abc123secret|topsecretvalue|zzz/.test(nl));
    check('pages only by default; images need detail "all"', !/logo\.png/.test(nl));
    r = await call('console_log', { tab_id: 1 });
    check('console log starts listening on the tab', r.ok && injected.includes(1) && /listening/i.test(r.result.text));
    r = await call('console_log', { tab_id: 2 });
    check('console log follows the Google sign-in rule', r.ok === g('cizState').get().unsafe);

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
    check('Stop turns Unsafe mode off too', s.unsafe === false);
    check('watch switch: Stop turns watching off, ends the card and sends watch_off to the helper', s.watch === false && s.watchAsk === null && port.sent.filter(m => m.type === 'watch_off').length === 2);
    check('Stop forgets the network log', !g('cizNet').size && !g('cizConsoleTabs').size);
    const w = await waiting;
    check('Stop aborts the running page action at once', !w.ok && w.error === 'Stopped' && Date.now() - tStop < 500 && s.pending === 0, `${Date.now() - tStop} ms`);
    r = await call('tabs_list');
    check('tools refused while stopped', !r.ok && /stopped/.test(r.error));
    await fromPanel({ type: 'setFiles', value: true, mode: 'read', folder: 'C:\\x' });
    check('file tools cannot be turned on while stopped', g('cizState').get().filesEnabled === false);
    await fromPanel({ type: 'start' });
    check('Start reconnects the helper', g('cizState').get().agent === 'active' && native !== port);
    // Opening Zen turns the agent on; a Stop lasts while Zen stays open
    await fromPanel({ type: 'stop' });
    normalWindows.push({ id: 2, type: 'normal' }); winCreated.fire({ id: 2, type: 'normal' }); await tick(30);
    check('a second window keeps a Stop', g('cizState').get().agent === 'stopped');
    normalWindows = normalWindows.filter(w => w.id !== 2);
    winCreated.fire({ id: 7, type: 'popup' }); await tick(30);
    check('a popup window does not turn the agent on', g('cizState').get().agent === 'stopped');
    const beforeOpen = native;
    normalWindows = [{ id: 3, type: 'normal' }];   // Zen was closed and is opened again
    winCreated.fire({ id: 3, type: 'normal' }); await tick(30);
    check('opening Zen again turns the agent on by itself', g('cizState').get().agent === 'active' && native !== beforeOpen && !native.disconnected);
    check('opening Zen is logged', g('cizState').log().some(e => /Zen opened: the agent is on/.test(e.text)));
    const beforeSecond = native;
    normalWindows.push({ id: 4, type: 'normal' }); winCreated.fire({ id: 4, type: 'normal' }); await tick(30);
    check('a second window does not reconnect the helper', native === beforeSecond && g('cizState').get().agent === 'active');
    // Settings > Saving files: "Store in output folder" keeps a made file through the helper. Without the helper, or when Save as is asked, the file downloads as before.
    const downloads = [];
    browser.downloads = { download: async o => { downloads.push(o); return downloads.length; } };
    const made = await g('cizFiles').add({ name: 'notes.txt', content: 'Olá, mundo', title: 'Notes', source: 'Claude', conv: 'c-out', msg: 'm-out' });
    await fromPanel({ type: 'setOutput', value: 'store' });
    check('the output setting is kept', g('cizState').get().outputMode === 'store' && local.outputMode === 'store');
    let sentAt = native.sent.length;
    await fromPanel({ type: 'downloadFile', id: made.id });
    const saveMsg = native.sent.slice(sentAt).find(m => m.type === 'save_output');
    check('a stored file goes to the helper with its bytes', !!saveMsg && saveMsg.name === 'notes.txt' && Buffer.from(saveMsg.data, 'base64').toString('utf8') === 'Olá, mundo', saveMsg ? saveMsg.name : 'no save_output sent');
    check('nothing is downloaded while the helper stores it', downloads.length === 0);
    await helperSays({ type: 'output_saved', req: saveMsg.req, ok: true, name: 'notes.txt', path: 'C:\\Users\\H\\AppData\\Local\\claude-in-zen\\output\\notes.txt' });
    check('the stored path reaches the panel', panelIn.some(m => m.type === 'outputSaved' && m.name === 'notes.txt' && /output\\notes\.txt$/.test(m.path)));
    check('a stored file is logged, and not downloaded', g('cizState').log().some(e => /Stored notes\.txt in the output folder/.test(e.text)) && downloads.length === 0);
    sentAt = native.sent.length;
    await fromPanel({ type: 'downloadFile', id: made.id });   // the helper takes the file...
    const inFlight = native.sent.slice(sentAt).some(m => m.type === 'save_output');
    native.onDisconnect.fire({ error: null });   // ...then stops before it answers
    await tick();
    check('a helper that stops before it answers means a download', inFlight && downloads.length === 1 && downloads[0].filename === 'Claude in Zen/notes.txt' && downloads[0].saveAs === false, downloads.map(d => d.filename).join(','));
    check('the fallback says why', g('cizState').log().some(e => /Could not store notes\.txt \(the helper stopped\), so it was downloaded instead/.test(e.text)));
    const realConnect = browser.runtime.connectNative;
    browser.runtime.connectNative = () => { throw new Error('No such native application claude_in_zen'); };
    await fromPanel({ type: 'downloadFile', id: made.id });
    await tick();
    browser.runtime.connectNative = realConnect;
    check('with no helper installed the file is downloaded', downloads.length === 2 && downloads[1].filename === 'Claude in Zen/notes.txt');
    await fromPanel({ type: 'setOutput', value: 'download' });
    await fromPanel({ type: 'downloadFile', id: made.id });
    await tick();
    check('download now (the default) saves to Claude in Zen, as before', downloads.length === 3 && downloads[2].filename === 'Claude in Zen/notes.txt' && downloads[2].saveAs === false && local.outputMode === 'download');
    await fromPanel({ type: 'setOutput', value: 'store' });
    const savesBefore = native.sent.filter(m => m.type === 'save_output').length;
    await fromPanel({ type: 'downloadFile', id: made.id, saveAs: true });
    await tick();
    check('Save as asks where to put the file, even in store mode', downloads.length === 4 && downloads[3].saveAs === true && native.sent.filter(m => m.type === 'save_output').length === savesBefore);
    await fromPanel({ type: 'setOutput', value: 'download' });
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
