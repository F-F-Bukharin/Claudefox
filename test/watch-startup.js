'use strict';
// Zen restarts: the saved "Start with watching on" must reach the helper even when the restored panel connects before the
// helper is connected. The panel's watch_load waits for connectNative, which sends it after hello. Stop then Start, with the
// panel still open, sends no watch_load, as before.   node test/watch-startup.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ext = path.join(__dirname, '..', 'extension');
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ev = () => { const fns = []; return { addListener: f => fns.push(f), fns, fire: (...a) => fns.forEach(f => f(...a)) }; };

// ---- mocked browser
const store = { state: { agent: 'stopped' } };   // Zen has just opened: the agent is off until its window appears
const local = {};
const tabs = [
  { id: 1, windowId: 1, active: true, title: 'Shop', url: 'https://shop.example/', status: 'complete' },
  { id: 2, windowId: 1, active: false, title: 'Sign in', url: 'https://accounts.google.com/signin/v2', status: 'complete' },
  { id: 3, windowId: 1, active: false, title: 'Config', url: 'about:config', status: 'complete' },
  { id: 4, windowId: 1, active: false, title: 'xpi', url: 'file:///C:/Users/you/Mods/claudefox/claudefox.xpi', status: 'complete' },
  { id: 5, windowId: 1, active: false, title: 'other', url: 'file:///C:/Users/you/notes/claudefox-notes.txt', status: 'complete' },
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
const call = (tool, args) => ctx.cfxDebug.call(tool, args || {});

(async () => {
  await tick(60);   // the add-on has booted: the agent is off, so no helper port yet
  connectEv.fire({ name: 'panel', onMessage: ev(), onDisconnect: ev(), postMessage: () => {} });   // the restored panel connects first
  await tick();
  check('a panel that connects before the helper is connected sends nothing yet', native === null);
  winCreated.fire({ id: 1, type: 'normal' });   // Zen's window opens: the agent turns on and the helper is connected
  await tick(60);
  const types = () => (native ? native.sent.map(m => m.type).join(',') : 'no port');
  check('the helper is connected: hello, then the saved watch_load', types() === 'hello,watch_load', types());
  await helperSays({ type: 'watch_state', watch: true, watchOnLoad: true });
  check('after a Zen restart the saved On reaches the switch', g('cfxState').get().watch === true && g('cfxState').get().watchOnLoad === true);
  connectEv.fire({ name: 'panel', onMessage: ev(), onDisconnect: ev(), postMessage: () => {} });   // a panel that opens with the helper up
  await tick();
  check('a panel that opens with the helper up is asked at once', native.sent.filter(m => m.type === 'watch_load').length === 2, types());
  await vm.runInContext("cfxState.set({ agent: 'stopped' })", ctx);
  native.onDisconnect.fire({});   // Stop
  await tick();
  await vm.runInContext("cfxState.set({ agent: 'active' })", ctx);
  vm.runInContext('connectNative()', ctx);   // Start, with the panel still open
  await tick(20);
  check('Start after Stop sends hello and no watch_load, as before', types() === 'hello', types());
  const failed = results.filter(r => !r).length;
  console.log(failed ? `${failed} check(s) failed` : `All ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
