'use strict';
// The settings and history scripts' own texts in English or Portuguese (Brazil), in the real panel under jsdom: a Sites button,
// a macro name error, the tools busy line, the accounts status line, the history group header, the empty history and a date.
// The English run pins the original texts; the Portuguese run takes its expected texts from _locales/pt_BR.
// Needs jsdom (npm i --no-save jsdom, or NODE_PATH). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { load } = require('./lib/locales');
const { html, files: panelFiles } = panelPage(EXT);
const MSG = load();
const fill = (key, ...subs) => {
  const m = (MSG.pt_BR[key] || {}).message;
  return m === undefined ? `(no pt_BR text for ${key})` : m.replace(/\$(\d+|\$)/g, (x, d) => (d === '$' ? '$' : subs[d - 1]));
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const T = Date.UTC(2026, 9, 12, 15, 30);   // one fixed moment for the history row
const base = { agent: 'active', signedIn: true, native: 'connected', claude: { installed: true, loggedIn: true }, chatModel: 'speed', filesMode: 'read', pending: 0 };
const clone = v => JSON.parse(JSON.stringify(v));

// The real panel in one language, over the given storage.local. send() delivers a state the way the background does.
function panel(lang, store) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let onMsg;
  const keysOf = k => (k == null ? Object.keys(store) : typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k));
  w.browser = {
    runtime: { connect: () => ({ postMessage() {}, onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.11.0' }) },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: {
        get: async k => { const o = {}; for (const x of keysOf(k)) if (x in store) o[x] = clone(store[x]); return o; },
        set: async o => { Object.assign(store, clone(o)); },
        remove: async k => { for (const x of [].concat(k)) delete store[x]; },
      },
    },
    downloads: { download: async () => 1 },
    tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  w.URL.createObjectURL = () => 'blob:settings-text';
  w.URL.revokeObjectURL = () => {};
  w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
  w.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
  evalPanel(dom, EXT, panelFiles, { lang });
  const send = state => onMsg({ type: 'state', state: { ...base, ...state }, log: [] });
  return { w, send, $: id => w.document.getElementById(id), close: () => w.close() };
}

async function checks(lang) {
  const en = lang === 'en';
  // The expected text: the English original, or the pt_BR message with its $n filled.
  const want = (key, enText, ...subs) => (en ? enText.replace(/\$(\d+)/g, (x, d) => subs[d - 1]) : fill(key, ...subs));
  const store = { sites: { 'example.org': 'allow' }, 'chats:a1': [{ id: 'c1', title: 'Nightly check', created: T, updated: T, group: 'Scheduled', sessionId: '' }] };
  const p = panel(lang, store);
  const { w, send, $ } = p;
  send({ accounts: [{ id: 'a1', email: 'one@example.com', active: true, loggedIn: true }], account: { email: 'one@example.com' } });
  await wait(40);
  const siteBtns = [...w.document.querySelectorAll('#siteList button')].map(b => b.textContent);
  ok(`${lang}: a Sites row button`, siteBtns.includes(want('set_allow', 'Allow')), siteBtns.join('|'));
  $('macroName').value = 'bad name!'; $('macroText').value = 'hi';
  $('macroSave').click(); await wait(80);
  const macroErr = $('macroErr').textContent;
  ok(`${lang}: a macro name error`, macroErr === want('set_macroNameRule', 'The name takes letters, numbers and dashes only (up to 30).'), macroErr);
  send({ accounts: [{ id: 'a1', email: 'one@example.com', active: true, loggedIn: true }], tools: { plugins: [], connectors: [], added: [], busy: 'adding', checked: false } });
  await wait(40);
  const busy = [...w.document.querySelectorAll('#toolsList .tempty')].map(d => d.textContent);
  ok(`${lang}: the tools busy line`, busy.includes(want('set_busyAdding', 'Adding…')), busy.join('|'));
  const line = $('acctChat').textContent;
  ok(`${lang}: the accounts status line`, line === want('set_chatUses', 'The chat uses $1.', 'one@example.com'), line);
  w.eval('histRender()'); await wait(80);
  const groups = [...w.document.querySelectorAll('#histList .hist-group')].map(e => e.textContent);
  ok(`${lang}: the history Scheduled header`, groups.includes(want('hist_scheduledHeader', 'Scheduled')), groups.join('|'));
  const date = w.document.querySelector('#histList .hist-date');
  const dateWant = new Date(T).toLocaleString(en ? [] : 'pt-BR', { dateStyle: 'medium', timeStyle: 'short' });
  ok(`${lang}: the history date`, !!date && date.textContent === dateWant, date && date.textContent);
  store['chats:a1'] = [];
  w.eval('histRender()'); await wait(80);
  const empty = $('histEmpty').textContent;
  const forAcct = en ? ' for one@example.com' : fill('hist_forAccount', 'one@example.com');
  ok(`${lang}: the empty history text`, empty === want('hist_noSaved', 'No saved chats yet$1.', forAcct), empty);
  if (!en) {
    const keys = ['set_allow', 'set_macroNameRule', 'set_busyAdding', 'set_chatUses', 'hist_scheduledHeader', 'hist_noSaved'];
    ok('pt_BR: those texts differ from English', keys.every(k => (MSG.pt_BR[k] || {}).message !== (MSG.en[k] || {}).message));
  }
  p.close();
}

(async () => {
  for (const lang of ['en', 'pt_BR']) await checks(lang);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
