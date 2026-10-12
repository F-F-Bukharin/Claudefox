'use strict';
// One chat per window (U5) and the queue (U4): two real panels in jsdom, each with its own window id, wired to the real background
// scripts in a vm (the helper is a recorder). Needs jsdom (npm i --no-save jsdom, or NODE_PATH). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EXT = path.join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(EXT);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x ? '  ' + x : '')); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const clone = v => JSON.parse(JSON.stringify(v));
const ev = () => { const fns = []; return { addListener: f => fns.push(f), removeListener() {}, fns, fire: (...a) => fns.forEach(f => f(...a)) }; };

// ---- the background, in a vm
const session = {}, local = {};
const tabs = [
  { id: 1, windowId: 1, active: true, title: 'One', url: 'https://one.example/', status: 'complete' },
  { id: 2, windowId: 1, active: false, title: 'One b', url: 'https://oneb.example/', status: 'complete' },
  { id: 3, windowId: 2, active: true, title: 'Two', url: 'https://two.example/', status: 'complete' },
];
const connectEv = ev(), tabEv = { onActivated: ev(), onUpdated: ev(), onCreated: ev(), onRemoved: ev() }, winRemoved = ev();
let native = null;
const store = (o, kind) => ({
  get: async k => Object.fromEntries((k == null ? Object.keys(o) : [].concat(typeof k === 'object' && !Array.isArray(k) ? Object.keys(k) : k)).filter(x => x in o).map(x => [x, clone(o[x])])),
  set: async v => { for (const k in v) o[k] = clone(v[k]); },
  remove: async k => { for (const x of [].concat(k)) delete o[x]; },
});
const browser = {
  storage: { local: store(local), session: store(session) },
  extension: { isAllowedFileSchemeAccess: async () => true },
  runtime: {
    onConnect: connectEv, onMessage: ev(), getManifest: () => JSON.parse(fs.readFileSync(EXT + 'manifest.json', 'utf8')),
    connectNative: () => { const onMsg = ev(), onDisc = ev(); native = { sent: [], onMessage: onMsg, onDisconnect: onDisc, postMessage(m) { this.sent.push(m); }, disconnect() {} }; return native; },
  },
  browserAction: { onClicked: ev(), setBadgeText() {}, setBadgeBackgroundColor() {} },
  sidebarAction: { toggle: async () => {}, open: async () => {} },
  tabs: Object.assign({
    query: async q => tabs.filter(t => (!q.active || t.active) && (q.windowId == null || t.windowId === q.windowId) && (!q.lastFocusedWindow || t.windowId === 1)),
    get: async id => tabs.find(t => t.id === id), create: async () => ({}), update: async () => ({}), remove: async () => {}, reload: async () => {},
    executeScript: async () => [{ ok: true }], captureTab: async () => 'data:image/png;base64,AAAA',
  }, tabEv),
  webRequest: { onBeforeRequest: ev(), onSendHeaders: ev(), onHeadersReceived: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() },
  windows: { update: async () => {}, onCreated: ev(), onRemoved: winRemoved, getAll: async () => [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }] },
};
const fetch = async () => ({ status: 200, ok: true, json: async () => ({ account: { email_address: 'f.work@example.com', full_name: 'F', uuid: 'u-1' } }) });
const ctx = vm.createContext({ browser, fetch, console, URL, URLSearchParams, AbortController, TextEncoder, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, Promise });
ctx.window = ctx;
for (const f of JSON.parse(fs.readFileSync(EXT + 'manifest.json', 'utf8')).background.scripts) vm.runInContext(fs.readFileSync(EXT + f, 'utf8'), ctx, { filename: f });
const g = name => vm.runInContext(name, ctx);
const helperSays = async m => { native.onMessage.fire(m); await wait(30); };
const chatsToHelper = () => native.sent.filter(m => m.type === 'chat');
const fromPanels = [];   // everything the panels sent to the background
let panels = [];

// ---- a panel for one window, wired to the background by a port
function makePanel(windowId) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const P = { w, windowId, $: id => w.document.getElementById(id), got: [], bg: null };
  w.browser = {
    runtime: { connect: () => {
      P.bg = { name: 'panel', onMessage: ev(), onDisconnect: ev(), postMessage: m => { const c = clone(m); P.got.push(c); if (P.onMsg) P.onMsg(c); } };
      return { postMessage: m => { fromPanels.push(clone(m)); P.bg.onMessage.fire(clone(m)); }, onMessage: { addListener: f => { P.onMsg = f; } } };
    }, getManifest: () => ({ version: '0.11.0' }) },
    storage: { session: browser.storage.session, local: browser.storage.local },
    windows: { getCurrent: async () => ({ id: windowId }) },
    tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    downloads: { download: async () => 1 },
  };
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
  w.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
  evalPanel(dom, EXT, panelFiles);
  connectEv.fire(P.bg);
  P.say = async text => { P.$('input').value = text; P.$('composer').dispatchEvent(new w.Event('submit', { cancelable: true })); await wait(40); };
  P.bubbles = () => [...P.$('messages').querySelectorAll('.msg.user')];
  P.queued = () => [...P.$('messages').querySelectorAll('.msg.user.queued')];
  P.text = () => P.$('messages').textContent;
  panels.push(P);
  return P;
}

(async () => {
  await wait(50);
  const first = makePanel(1);
  await wait(50);
  await new Promise(r => { const bgPort = first.bg; bgPort.onMessage.fire({ type: 'signIn' }); setTimeout(r, 50); });
  await helperSays({ type: 'hello', version: '0.11.0', clients: [] });
  await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'f.work@example.com' });
  const A = first, B = makePanel(2);
  await wait(60);

  // ---- U5: each panel names its window; each window has its own chat, tab and storage key
  await A.say('hello from one');
  await B.say('hello from two');
  ok('each panel sends its window id with the message', fromPanels.filter(m => m.type === 'chat').map(m => m.windowId).join() === '1,2', JSON.stringify(fromPanels.filter(m => m.type === 'chat')));
  ok('window 1\'s message runs on window 1\'s active tab, and the gate\'s window is window 1', chatsToHelper()[0].tab.id === 1 && g('cizSiteGate').windowId() === 1, JSON.stringify(chatsToHelper()[0]));
  ok('window 2\'s message waits: the helper got only the first', chatsToHelper().length === 1);
  await helperSays({ type: 'chat_event', id: chatsToHelper()[0].id, event: { kind: 'text', text: 'answer one' } });
  await helperSays({ type: 'chat_done', id: chatsToHelper()[0].id, ok: true, sessionId: 'sess-1' });
  ok('then window 2\'s message starts on window 2\'s active tab, and the gate\'s window is window 2', chatsToHelper().length === 2 && chatsToHelper()[1].tab.id === 3 && g('cizSiteGate').windowId() === 2, JSON.stringify(chatsToHelper()[1]));
  ok('window 2 starts its own chat (no session of window 1)', chatsToHelper()[1].resume === '', JSON.stringify(chatsToHelper()[1].resume));
  await helperSays({ type: 'chat_event', id: chatsToHelper()[1].id, event: { kind: 'text', text: 'answer two' } });
  await helperSays({ type: 'chat_done', id: chatsToHelper()[1].id, ok: true, sessionId: 'sess-2' });
  await wait(450);
  const k1 = session['win:1'], k2 = session['win:2'];
  ok('win:<id> keeps each window\'s own chat in storage.session', k1 && k2 && JSON.stringify(k1.chat).includes('hello from one') && !JSON.stringify(k1.chat).includes('hello from two') && JSON.stringify(k2.chat).includes('hello from two') && !JSON.stringify(k2.chat).includes('hello from one'));
  ok('the panels show only their own chat', /answer one/.test(A.text()) && !/answer two/.test(A.text()) && /answer two/.test(B.text()) && !/answer one/.test(B.text()));
  await A.say('again in one');
  ok('a follow-up resumes its own window\'s session', chatsToHelper()[2].resume === 'sess-1', JSON.stringify(chatsToHelper()[2].resume));
  await helperSays({ type: 'chat_done', id: chatsToHelper()[2].id, ok: true, sessionId: 'sess-1' });
  await wait(450);
  const A2 = makePanel(1);
  await wait(120);
  ok('reopening a window\'s panel shows its own chat', /hello from one/.test(A2.text()) && /again in one/.test(A2.text()) && !/hello from two/.test(A2.text()));
  panels = panels.filter(p => p !== A);   // the first panel of window 1 is gone

  // ---- U4: the queue
  await A2.say('running one');
  const run = chatsToHelper()[3];
  ok('an answer runs: the hint says so, in every window', A2.$('composerHint').textContent === 'Claude is answering · stops after 1 hour' && B.$('composerHint').textContent === 'Claude is answering · stops after 1 hour', A2.$('composerHint').textContent + '|' + B.$('composerHint').textContent);
  ok('Send stays enabled while answering', A2.$('sendBtn').disabled === false);
  await A2.say('wait 1');
  await A2.say('wait 2');
  await B.say('wait b');
  ok('messages sent while Claude answers show as pending bubbles with a x', A2.queued().length === 2 && A2.queued().every(b => b.querySelector('button.qx')) && B.queued().length === 1);
  ok('nothing new reached the helper yet', chatsToHelper().length === 4 && g('chatQueue').length === 3);
  A2.queued()[1].querySelector('button.qx').click();
  await wait(40);
  ok('x removes a queued message, in the panel and in the queue', A2.queued().length === 1 && !/wait 2/.test(A2.text()) && g('chatQueue').length === 2, g('chatQueue').length);
  native.sent.push({ type: 'marker' });
  A2.$('messages').querySelector('.msg.pending button.link').click();   // Cancel of the running answer
  await wait(40);
  ok('Cancel of the running answer does not drop the queue', native.sent.some(m => m.type === 'chat_cancel') && g('chatQueue').length === 2);
  await helperSays({ type: 'chat_done', id: run.id, ok: false, error: 'Cancelled.' });
  ok('the queued messages go out in order, one at a time, across windows', chatsToHelper().length === 5 && chatsToHelper()[4].text === 'wait 1' && A2.queued().length === 0);
  await helperSays({ type: 'chat_done', id: chatsToHelper()[4].id, ok: true, sessionId: 'sess-1b' });
  ok('the next one (window 2\'s) starts after it, on window 2\'s tab', chatsToHelper().length === 6 && chatsToHelper()[5].text === 'wait b' && chatsToHelper()[5].tab.id === 3 && B.queued().length === 0, JSON.stringify(chatsToHelper()[5]));
  ok('the queued follow-up resumed its own window\'s newest session', chatsToHelper()[4].resume === 'sess-1', JSON.stringify(chatsToHelper()[4].resume));
  await A2.say('queued behind b');
  await B.say('queued 2 behind b');
  ok('Stop clears all queues and says why under the bubbles', (await (async () => { A2.bg.onMessage.fire({ type: 'stop' }); await wait(60); return true; })()) && g('chatQueue').length === 0 && A2.queued().length === 0 && B.queued().length === 0 && /Not sent/.test(A2.text()) && /Not sent/.test(B.text()), A2.text().slice(-200));
  ok('after Stop nothing more reaches the helper', chatsToHelper().length === 6);

  // ---- the header's log button opens the Action log
  ok('the Action log sits in Settings > Advanced, closed to begin with', B.$('advancedBody').hidden === true);
  B.$('logBtn').click();
  ok('the log button in the header opens the Action log', B.$('page-settings').hidden === false && B.$('advancedBody').hidden === false && B.$('page-chat').hidden === true);

  // ---- a closed window takes its saved chat and waiting messages with it
  ok('window 2 has a saved chat before it closes', !!session['win:2']);
  winRemoved.fire(2);
  await wait(30);
  ok('closing a window drops its win:<id> key', !('win:2' in session) && !!session['win:1']);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL crashed: ' + (e && e.stack || e)); process.exit(1); });
