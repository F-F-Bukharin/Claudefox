'use strict';
// The background's own messages in English or Portuguese (Brazil): the errors the panel prints (chatDone), the notifications of
// a scheduled macro, the right-click menu titles, and what the helper hears about the language (hello, and { type: 'lang' }).
// The real background scripts run in a vm against a mocked browser.   node test/i18n-bg.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load } = require('./lib/locales');

const ext = path.join(__dirname, '..', 'extension');
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log(`PASS  ${name}`); } else { failed++; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); } };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ev = () => { const fns = []; return { addListener: f => fns.push(f), fns, fire: (...a) => fns.forEach(f => f(...a)) }; };

const local = {}, session = {};
const area = (o, ls) => ({
  get: async k => Object.fromEntries((Array.isArray(k) ? k : [k]).filter(x => x in o).map(x => [x, JSON.parse(JSON.stringify(o[x]))])),
  set: async v => { for (const k in v) o[k] = JSON.parse(JSON.stringify(v[k])); },
  remove: async k => { for (const x of [].concat(k)) delete o[x]; },
});
const menuCreated = [], menuUpdated = [], notes = [];
let native = null;
const missingHosts = new Set();   // helper names connectNative refuses (the fallback notice check)
const connectEv = ev(), panelIn = [];
const browser = {
  storage: { local: area(local), session: area(session), onChanged: ev() },
  runtime: {
    onConnect: connectEv, onMessage: ev(),
    getManifest: () => JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')),
    getURL: p => 'moz-extension://x/' + p,
    connectNative: name => {
      if (missingHosts.has(name)) throw new Error('No such native application ' + name);
      const onMsg = ev(), onDisc = ev();
      native = { sent: [], onMessage: onMsg, onDisconnect: onDisc, postMessage(m) { this.sent.push(m); }, disconnect() {} };
      return native;
    },
  },
  browserAction: { onClicked: ev(), setBadgeText() {}, setBadgeBackgroundColor() {} },
  sidebarAction: { toggle: async () => {}, open: async () => {} },
  menus: { create: i => { menuCreated.push(i); }, update: (id, o) => { menuUpdated.push([id, o]); return Promise.resolve(); }, onClicked: ev() },
  notifications: { create: (id, o) => { notes.push(o); return Promise.resolve(id); } },
  tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, create: async () => ({ id: 9 }), update: async () => ({}), remove: async () => {},
    executeScript: async () => [], onActivated: ev(), onUpdated: ev(), onCreated: ev(), onRemoved: ev() },
  webRequest: { onBeforeRequest: ev(), onSendHeaders: ev(), onHeadersReceived: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() },
  windows: { update: async () => {}, onCreated: ev(), getAll: async () => [] },
};
const ctx = vm.createContext({ browser, CFX_LOCALES: load(), fetch: async () => { throw new Error('offline'); }, console, URL, URLSearchParams,
  AbortController, TextEncoder, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, Promise });
ctx.window = ctx;
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')).background.scripts;
const panel = { name: 'panel', onMessage: ev(), onDisconnect: ev(), postMessage: m => panelIn.push(m) };
const g = expr => vm.runInContext(expr, ctx);
let seq = 0;
// Sends a chat from the panel in the state given and returns the error the panel is told.
async function chatError(state, extra) {
  await g('cfxState').set(Object.assign({ agent: 'active', signedIn: true, native: 'connected', claude: null }, state));
  const id = 'c' + (++seq);
  panelIn.length = 0;
  panel.onMessage.fire(Object.assign({ type: 'chat', id, text: 'hi' }, extra));
  await tick();
  const done = panelIn.find(m => m.type === 'chatDone' && m.id === id);
  return done && done.error;
}
const menuTitles = () => ['ask-selection', 'ask-page', 'ask-link'].map(id => {
  const up = menuUpdated.filter(u => u[0] === id).pop();
  return up ? up[1].title : (menuCreated.find(m => m.id === id) || {}).title;
});

(async () => {
  try {
    for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx, { filename: f });
    await tick(60);
    connectEv.fire(panel);
    await tick();
    const en = load().en, pt = load().pt_BR;

    // ---- English
    ok('en: the helper hears the language in hello', native && native.sent[0] && native.sent[0].type === 'hello' && native.sent[0].lang === 'en', JSON.stringify(native && native.sent[0]));
    ok('en: the three menu titles', JSON.stringify(menuTitles()) === JSON.stringify(['Ask Claude about this selection', 'Ask Claude about this page', 'Ask Claude about this link']), menuTitles().join(' | '));
    ok('en: stopped', await chatError({ agent: 'stopped' }) === 'Claude is stopped. Press Start first.');
    ok('en: not signed in', await chatError({ signedIn: false }) === 'Not signed in. Open the Profile page and sign in first.');
    ok('en: helper not connected', /^The helper is not connected\./.test(await chatError({ native: 'unknown' })));
    ok('en: Claude Code not installed', await chatError({ claude: { installed: false } }) === 'Claude Code is not installed on this PC.');
    ok('en: Claude Code not signed in', /^Claude Code is not signed in\./.test(await chatError({ claude: { installed: true, loggedIn: false } })));
    await g('cfxState').set({ agent: 'stopped' });
    notes.length = 0;
    g("startChat({ id: 'm1', text: 'x', scheduled: { macro: 'Daily', sites: [] } })"); await tick();
    ok('en: a scheduled macro that could not start says so in a notification', notes.some(n => n.message === 'Claudefox: Daily skipped: Claude is stopped. Press Start first.'), JSON.stringify(notes));
    notes.length = 0;
    await g("cfxMacros.finished({ scheduled: { macro: 'Daily' }, text: 'ok' }, { ok: true })");
    ok('en: finished notification', notes.some(n => n.message === 'Claudefox: Daily finished'), JSON.stringify(notes));

    // ---- Portuguese
    native.sent.length = 0;
    await g("cfxI18n.set('pt_BR')"); await tick();
    ok('pt_BR: the helper hears { type: "lang" }', native.sent.some(m => m.type === 'lang' && m.lang === 'pt_BR'), JSON.stringify(native.sent));
    ok('pt_BR: the three menu titles are updated, in Portuguese', JSON.stringify(menuTitles()) === JSON.stringify([pt.bg_menuSelection.message, pt.bg_menuPage.message, pt.bg_menuLink.message])
      && menuTitles().every((t, i) => t !== en['bg_menu' + ['Selection', 'Page', 'Link'][i]].message), menuTitles().join(' | '));
    ok('pt_BR: stopped', await chatError({ agent: 'stopped' }) === pt.bg_stopped.message && pt.bg_stopped.message !== en.bg_stopped.message);
    ok('pt_BR: not signed in', await chatError({ signedIn: false }) === pt.bg_notSignedIn.message);
    ok('pt_BR: helper not connected', await chatError({ native: 'unknown' }) === pt.bg_helperNotConnected.message);
    ok('pt_BR: Claude Code not installed', await chatError({ claude: { installed: false } }) === pt.bg_claudeNotInstalled.message);
    ok('pt_BR: Claude Code not signed in', await chatError({ claude: { installed: true, loggedIn: false } }) === pt.bg_claudeNotSignedIn.message);
    await g('cfxState').set({ agent: 'stopped' });
    notes.length = 0;
    g("startChat({ id: 'm2', text: 'x', scheduled: { macro: 'Daily', sites: [] } })"); await tick();
    ok('pt_BR: the skipped notification is in Portuguese', notes.some(n => n.message === pt.bg_macroSkipped.message.replace('$1', 'Daily').replace('$2', pt.bg_stopped.message)), JSON.stringify(notes));
    notes.length = 0;
    await g("cfxMacros.finished({ scheduled: { macro: 'Daily' }, text: 'ok' }, { ok: true })");
    ok('pt_BR: the finished notification is in Portuguese', notes.some(n => n.message === pt.bg_macroFinished.message.replace('$1', 'Daily')) && pt.bg_macroFinished.message !== en.bg_macroFinished.message, JSON.stringify(notes));
    notes.length = 0;
    await g("cfxMacros.finished({ scheduled: { macro: 'Daily' }, text: '' }, { ok: false, error: '' })");
    ok('pt_BR: the failed notification, with the default reason, is in Portuguese', notes.some(n => n.message === pt.bg_macroFailed.message.replace('$1', 'Daily').replace('$2', pt.bg_macroItFailed.message)), JSON.stringify(notes));

    // A new helper connection says the language in use in its hello.
    await g("cfxState").set({ agent: 'active' });
    g('disconnectNative()');
    ok('pt_BR: the helper line in Settings (nativeDetail) is in Portuguese', g('cfxState').get().nativeDetail === pt.bg_nativeDisconnected.message);
    g('connectNative()');
    ok('pt_BR: a new hello carries lang pt_BR', native.sent[0] && native.sent[0].type === 'hello' && native.sent[0].lang === 'pt_BR', JSON.stringify(native.sent[0]));
    // The notice that the helper's name changed (D3) is in Portuguese too.
    g('disconnectNative()');
    missingHosts.add('claudefox');
    g('connectNative()'); await tick();
    ok('pt_BR: the "re-run setup" notice for the old helper registration is in Portuguese', g('cfxState').get().nativeNotice === pt.bg_nativeRerun.message && pt.bg_nativeRerun.message === 'Execute Set up Claudefox.bat de novo para concluir a atualização.', g('cfxState').get().nativeNotice);
    missingHosts.clear();
    g('disconnectNative()');
    g('connectNative()');
    // Back to English: the titles follow, and the helper hears it.
    await g("cfxI18n.set('en')"); await tick();
    ok('en again: titles and the helper follow', menuTitles()[0] === en.bg_menuSelection.message && native.sent.some(m => m.type === 'lang' && m.lang === 'en'));
  } catch (e) { ok('runs (threw)', false, (e && e.stack || String(e)).split('\n').slice(0, 3).join(' / ')); }
  console.log(`\ni18n-bg: ${passed} checks passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
