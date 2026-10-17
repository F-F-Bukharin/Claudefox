'use strict';
// The download_image card in the real panel.html/panel.js (jsdom), and the add-on's answer to a download_ask in the real
// bg-chat.js (vm): a site the user blocked is answered No at once, with no card. Optional DOM test: needs jsdom (npm i
// --no-save jsdom, or NODE_PATH pointing at one). Skips without it.   NODE_PATH=... node test/dom-download.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
// A check that throws (a missing element, say) is one FAIL, and the rest still run.
const attempt = (name, fn) => { try { ok(name, fn()); } catch (e) { ok(name, false, String(e.message || e).split('\n')[0]); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const ASK = { id: '3', host: 'example.com', name: 'cat.gif', folder: '/home/u/Art' };

async function panelPart() {
  const { html, files: panelFiles } = panelPage(dir);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  let onMsg;
  w.browser = {
    runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.11.0' }) },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;');
  w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8'));
  evalPanel(dom, dir, panelFiles);
  const $ = id => w.document.getElementById(id);
  const base = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected',
    debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '', watch: false, watchOnLoad: null, watchAsk: null, downloadAsk: null };
  const push = async s => { onMsg({ type: 'state', state: Object.assign({}, base, s), log: [] }); await wait(20); };
  const sentOf = type => sent.filter(m => m.type === type);

  await push({});
  attempt('the download card is hidden by default', () => $('downloadCard').hidden === true);
  await push({ downloadAsk: ASK });
  attempt('the card shows the host, the name and the folder', () => {
    const t = $('downloadCard').textContent;
    return $('downloadCard').hidden === false && t.includes('Claude wants to save a picture from example.com') && t.includes('cat.gif') && t.includes('/home/u/Art');
  });
  await push({ downloadAsk: ASK });
  attempt('downloadShown goes once per card id', () => sentOf('downloadShown').length === 1 && sentOf('downloadShown')[0].id === '3');
  attempt('Allow posts downloadAnswer with allow true', () => { $('downloadAllow').click(); return sentOf('downloadAnswer').some(m => m.id === '3' && m.allow === true); });
  await push({ downloadAsk: Object.assign({}, ASK, { id: '4' }) });
  attempt('Deny posts downloadAnswer with allow false', () => { $('downloadDeny').click(); return sentOf('downloadAnswer').some(m => m.id === '4' && m.allow === false); });
  await push({ downloadAsk: null });
  attempt('the card hides when the state clears', () => $('downloadCard').hidden === true);
}

async function addonPart() {
  const nativeSent = [];
  let bgSites = {};
  const sb = {
    URL, console, setTimeout, __sent: nativeSent,
    browser: {
      storage: {
        session: { get: async () => ({}), set: async () => {} },
        local: { get: async () => ({ sites: JSON.parse(JSON.stringify(bgSites)) }), set: async () => {} },
      },
      runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => ({ version: '0.11.0' }) },
      tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    },
    cfxSiteGate: { begin: () => [], list: () => [], cancel() {}, markRead() {} },
    cfxLocal: { cancelAll: async () => {} },
    cfxArmy: { closeAll: async () => {} },
    cfxNetReset() {}, disconnectNative() {}, failChats() {},
  };
  const bgCtx = vm.createContext(sb);
  for (const f of ['lib/state.js', 'lib/bg-chat.js']) vm.runInContext(fs.readFileSync(dir + f, 'utf8'), bgCtx, { filename: f });
  vm.runInContext('sendNative = m => { __sent.push(m); return true; };', bgCtx);   // the native port: recorded, not sent
  const bg = code => vm.runInContext(code, bgCtx);
  const msg = o => bg(`onNativeMessage(${JSON.stringify(o)})`);
  await bg('cfxState.load()');   // background.js loads the session state at start-up; the vm does the same

  attempt('the download card state is null by default', () => bg('cfxState.get().downloadAsk') === null);
  bgSites = { 'example.com': 'block' };
  await msg({ type: 'download_ask', id: '6', host: 'img.example.com', name: 'cat.gif', folder: '/home/u/Art' });
  attempt('a blocked site (or its parent domain) is answered No at once', () => nativeSent.some(m => m.type === 'download_answer' && m.id === '6' && m.allow === false));
  attempt('a blocked site shows no card', () => bg('cfxState.get().downloadAsk') === null);
  bgSites = {};
  await msg({ type: 'download_ask', id: '7', host: 'example.com', name: 'cat.gif', folder: '/home/u/Art' });
  attempt('an allowed site sets the card state', () => {
    const d = bg('cfxState.get().downloadAsk');
    return !!d && d.id === '7' && d.host === 'example.com' && d.name === 'cat.gif' && d.folder === '/home/u/Art';
  });
  attempt('an allowed site is not answered by the add-on', () => !nativeSent.some(m => m.type === 'download_answer' && m.id === '7'));
  await msg({ type: 'download_ask', id: null });
  attempt('a download_ask with no id clears the card', () => bg('cfxState.get().downloadAsk') === null);
}

(async () => {
  try { await panelPart(); } catch (e) { ok('the panel loads with the card', false, String(e.message || e).split('\n')[0]); }
  try { await addonPart(); } catch (e) { ok('bg-chat loads and answers download_ask', false, String(e.message || e).split('\n')[0]); }
  console.log(fail ? `${fail} failed, ${pass} passed` : `All ${pass} checks passed`);
  process.exit(fail ? 1 : 0);
})();
