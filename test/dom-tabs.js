'use strict';
// The "@" tab picker (E9) in the real panel under jsdom, and what a send does in the background: "@" at a word start lists this
// window's tabs, a choice is inserted as @[title](tab:id), a send names those tabs as [tab id: title (site)] and their sites go with
// the chat message, and /research compares the mentioned tabs. Needs jsdom (npm i --no-save jsdom, or NODE_PATH). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EXT = path.join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(EXT);
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const sent = []; let onMsg;
// Window 5 has four tabs (one is not a web page); window 6 has one more, which the picker must not list.
const TABS = [
  { id: 11, windowId: 5, title: 'Example Domain', url: 'https://example.com/' },
  { id: 12, windowId: 5, title: 'Inteli Portal', url: 'https://www.portal.inteli.edu.br/aulas' },
  { id: 13, windowId: 5, title: 'Pesquisa  Example [docs]', url: 'https://example.org/busca' },
  { id: 15, windowId: 5, title: 'New Tab', url: 'about:newtab' },
  { id: 14, windowId: 6, title: 'Other window', url: 'https://other.example.net/' },
];
w.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => onMsg = f } }), getManifest: () => ({ version: '0.11.0' }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  windows: { getCurrent: async () => ({ id: 5 }) },
  tabs: { query: async q => TABS.filter(t => q.windowId == null || t.windowId === q.windowId), onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
};
w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
w.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
evalPanel(dom, EXT, panelFiles);
const $ = id => w.document.getElementById(id);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const chatsSent = () => sent.filter(m => m.type === 'chat');
const base = { agent: 'active', signedIn: true, native: 'connected', claude: { installed: true, loggedIn: true }, accounts: [{ id: 'a1', email: 'one@example.com', active: true }], chatModel: 'speed', chatArmy: false, filesMode: 'read', pending: 0 };
onMsg({ type: 'state', state: base, log: [] });
// ---- the background scripts under vm (as test/site-wiring.js runs them): what a chat message with tabSites does
const EXTD = path.join(__dirname, '..', 'extension');
function makeBg() {
  const store = {}, local = {};
  const ev = () => { const fns = []; return { addListener: f => fns.push(f), removeListener() {}, fns, fire: (...a) => fns.forEach(f => f(...a)) }; };
  const bgTabs = [
    { id: 11, windowId: 5, active: true, title: 'Example Domain', url: 'https://example.com/', status: 'complete' },
    { id: 12, windowId: 5, active: false, title: 'Inteli Portal', url: 'https://www.portal.inteli.edu.br/aulas', status: 'complete' },
  ];
  const connectEv = ev();
  const nat = { sent: [], onMessage: ev(), onDisconnect: ev(), postMessage(m) { this.sent.push(m); }, disconnect() {} };
  const tabEv = { onActivated: ev(), onUpdated: ev(), onCreated: ev(), onRemoved: ev() };
  const browser = {
    storage: { local: {
      get: async k => (k in local ? { [k]: JSON.parse(JSON.stringify(local[k])) } : {}),
      set: async o => { for (const k in o) local[k] = JSON.parse(JSON.stringify(o[k])); },
      remove: async k => { delete local[k]; },
    }, session: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, JSON.parse(JSON.stringify(store[k]))])),
      set: async o => { for (const k in o) store[k] = JSON.parse(JSON.stringify(o[k])); },
    } },
    extension: { isAllowedFileSchemeAccess: async () => true },
    runtime: { onConnect: connectEv, onMessage: ev(), getManifest: () => JSON.parse(fs.readFileSync(path.join(EXTD, 'manifest.json'), 'utf8')), connectNative: () => nat },
    browserAction: { onClicked: ev(), setBadgeText() {}, setBadgeBackgroundColor() {} },
    sidebarAction: { toggle: async () => {}, open: async () => {} },
    tabs: Object.assign({
      query: async q => bgTabs.filter(t => (!q.active || t.active) && (q.windowId == null || t.windowId === q.windowId) && (!q.lastFocusedWindow || t.windowId === 5)),
      get: async id => bgTabs.find(x => x.id === id),
      create: async () => ({}), update: async () => ({}), remove: async () => {}, reload: async () => {}, executeScript: async () => [{ ok: true }], captureTab: async () => 'data:image/png;base64,AAAA',
    }, tabEv),
    webRequest: { onBeforeRequest: ev(), onSendHeaders: ev(), onHeadersReceived: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() },
    windows: { update: async () => {}, onCreated: ev(), getAll: async () => [{ id: 5, type: 'normal' }] },
  };
  const fetch = async () => ({ status: 200, ok: true, json: async () => ({ account: { email_address: 'f.work@example.com', full_name: 'F', uuid: 'u-1' } }) });
  const ctx = vm.createContext({ browser, fetch, console, URL, URLSearchParams, AbortController, TextEncoder, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, Promise });
  ctx.window = ctx;
  for (const f of JSON.parse(fs.readFileSync(path.join(EXTD, 'manifest.json'), 'utf8')).background.scripts) vm.runInContext(fs.readFileSync(path.join(EXTD, f), 'utf8'), ctx, { filename: f });
  const panelPort = { name: 'panel', onMessage: ev(), onDisconnect: ev(), postMessage() {} };
  return {
    nat,
    start: async () => { await tick(50); connectEv.fire(panelPort); await fromPanel(panelPort, { type: 'signIn' }); native({ type: 'hello', version: '0.11.0', clients: [] }); await tick(); native({ type: 'claude_status', installed: true, loggedIn: true, email: 'f.work@example.com' }); await tick(); },
    fromPanel: m => fromPanel(panelPort, m),
    done: async id => { native({ type: 'chat_done', id, ok: true }); await tick(); },
    lastChat: () => [...nat.sent].reverse().find(m => m.type === 'chat'),
  };
  function native(m) { nat.onMessage.fire(m); }
}
async function fromPanel(port, m) { port.onMessage.fire(m); await tick(); }
const pickerOpen = () => !!$('tabMenu') && !$('tabMenu').hidden;
const pickerIds = () => (pickerOpen() ? [...$('tabMenu').querySelectorAll('button')].map(b => b.dataset.tab) : null);
const pickerSel = () => { const b = pickerOpen() && $('tabMenu').querySelector('button[aria-selected="true"]'); return b ? b.dataset.tab : null; };
const typed = (v, caret = v.length) => { const el = $('input'); el.value = v; el.setSelectionRange(caret, caret); el.dispatchEvent(new w.Event('input')); };
const key = k => $('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const bubbles = () => [...$('messages').querySelectorAll('.msg.user .body')].map(e => e.textContent.trim());
const messagesText = () => $('messages').textContent;
(async () => {
  try {
    await tick(50);   // the window id is read first
    typed('@'); await tick();
    ok('"@" at the start of the text opens the picker with this window\'s web tabs only', JSON.stringify(pickerIds()) === '["11","12","13"]', JSON.stringify(pickerIds()));
    ok('each choice shows its title and its site', /Inteli Portal/.test(($('tabMenu') || { textContent: '' }).textContent) && /portal\.inteli\.edu\.br/.test(($('tabMenu') || { textContent: '' }).textContent));
    typed('a@b'); await tick();
    ok('"a@b" does not open the picker', !pickerOpen());
    typed('@domain'); await tick();
    ok('the picker narrows by title', JSON.stringify(pickerIds()) === '["11"]', JSON.stringify(pickerIds()));
    typed('@inteli.edu'); await tick();
    ok('the picker narrows by site', JSON.stringify(pickerIds()) === '["12"]', JSON.stringify(pickerIds()));
    typed('@'); await tick();
    key('ArrowDown'); key('ArrowDown');
    const down2 = pickerSel();
    key('ArrowUp');
    ok('ArrowDown and ArrowUp move the highlight', down2 === '13' && pickerSel() === '12', down2 + ' ' + pickerSel());
    key('Escape');
    ok('Escape closes the picker and keeps the text', !pickerOpen() && $('input').value === '@');
    typed('see @pesq'); await tick();
    const before = bubbles().length;
    key('Enter');
    ok('Enter inserts @[title](tab:id) and a space, and does not send', $('input').value === 'see @[Pesquisa Example docs](tab:13) ' && !pickerOpen() && bubbles().length === before, JSON.stringify($('input').value));
    const n0 = chatsSent().length;
    typed('see @[Inteli Portal](tab:12) and @[Other window](tab:14) what is due?'); await tick();
    key('Enter'); await tick(60);
    const c = chatsSent().slice(n0).pop() || {};
    ok('a send names this window\'s tab as [tab id: title (site)] and leaves the other window\'s mention', c.text === 'see [tab 12: Inteli Portal (portal.inteli.edu.br)] and @[Other window](tab:14) what is due?', JSON.stringify(c.text));
    ok('the chat message carries the sites of the tabs it names', JSON.stringify(c.tabSites) === '["portal.inteli.edu.br"]', JSON.stringify(c.tabSites));
    const n1 = chatsSent().length;
    typed('/research'); key('Enter'); await tick();
    ok('/research with no tab mentioned says so and sends nothing', messagesText().includes('Mention at least one tab with @') && chatsSent().length === n1);
    typed('/research @por'); await tick();
    key('Enter'); await tick();
    ok('/research picks a tab from the @ picker', $('input').value === '/research @[Inteli Portal](tab:12) ', JSON.stringify($('input').value));
    key('Enter'); await tick(60);
    const r = chatsSent()[n1] || {};
    ok('/research sends the compare text with the tab as [tab id: title (site)], its site, and no army forced', r.text === 'Read these tabs and compare them.\n\n[tab 12: Inteli Portal (portal.inteli.edu.br)]' && JSON.stringify(r.tabSites) === '["portal.inteli.edu.br"]' && r.army === undefined, JSON.stringify(r));
    // The long title, in the picker (80) and in a send (100)
    TABS.push({ id: 16, windowId: 5, title: 'X'.repeat(130), url: 'https://long.example/' });
    typed('@long'); await tick(); key('Enter');
    ok('the picker cuts a title at 80 characters', $('input').value === '@[' + 'X'.repeat(80) + '](tab:16) ', $('input').value.length + '');
    const n2 = chatsSent().length;
    typed('@[whatever](tab:16) summarize'); await tick(); key('Enter'); await tick(60);
    const lt = (chatsSent().slice(n2).pop() || {}).text || '';
    ok('a send cuts a title at 100 characters', lt === '[tab 16: ' + 'X'.repeat(100) + ' (long.example)] summarize', lt.length + '');
    // The background: the chat message's tabSites join the sites sent to the helper, and /research picks the model by the switches.
    const bg = makeBg();
    await bg.start();
    await bg.fromPanel(Object.assign({ windowId: 5 }, { type: 'chat', id: 'tb1', text: c.text, tabSites: c.tabSites }));
    const m1 = bg.lastChat() || {};
    ok('the helper\'s chat message lists the open page\'s site and the mentioned tab\'s site', m1.id === 'tb1' && JSON.stringify(m1.sites) === '["example.com","portal.inteli.edu.br"]', JSON.stringify(m1.sites));
    await bg.done('tb1');
    await bg.fromPanel({ type: 'chat', id: 'tb2', text: 'x', windowId: 5, tabSites: ['!!!', 'OTHER.example.org'] });
    ok('tabSites are cleaned like sites (lower case, junk dropped)', JSON.stringify((bg.lastChat() || {}).sites) === '["example.com","other.example.org"]', JSON.stringify((bg.lastChat() || {}).sites));
    await bg.done('tb2');
    await bg.fromPanel({ type: 'chat', id: 'tb3', text: r.text, windowId: 5, tabSites: r.tabSites });
    ok('/research on the default switches runs in Speed', (bg.lastChat() || {}).model === 'speed', JSON.stringify((bg.lastChat() || {}).model));
    await bg.done('tb3');
    await bg.fromPanel({ type: 'setModel', value: 'quality' }); await bg.fromPanel({ type: 'setArmy', value: true });
    await bg.fromPanel({ type: 'chat', id: 'tb4', text: r.text, windowId: 5, tabSites: r.tabSites });
    ok('/research with Quality and the army on runs the army', /^army/.test((bg.lastChat() || {}).model || ''), JSON.stringify((bg.lastChat() || {}).model));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  } catch (e) { console.log('ERROR', e.stack); process.exit(1); }
})();
