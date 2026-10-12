'use strict';
// The right-click items and the reading chips (E1, E10). The background side (lib/bg-menus.js with the state, the site gate and the
// message switch) runs in a vm against a mocked browser. The panel (jsdom, the real panel.html and panel files) takes a draft into
// its own window's bar, unsent, and its starter chips follow the active tab. The panel part needs jsdom (npm i --no-save jsdom, or
// NODE_PATH pointing at one); without it that part is skipped.   node test/dom-menus.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ext = path.join(__dirname, '..', 'extension');
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log(`PASS  ${name}`); } else { failed++; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); } };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const json = v => JSON.stringify(v);
// A file that does not exist reads as empty: its checks FAIL and the run goes on (the negative gate takes lib/bg-menus.js out).
const read = f => { const p = path.join(ext, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
async function scenario(name, fn) { try { await fn(); } catch (e) { ok(`${name} (threw)`, false, e.message); } }

// ---------------------------------------------------------------- background: lib/bg-menus.js and what it reaches

const sessionStore = {};
const menuItems = [];
const counts = { opened: 0 };
let menuClick = null;
const bg = vm.createContext({
  CIZ_LOCALES: require('./lib/locales').load(),   // lib/i18n.js reads the texts from here
  console, setTimeout, clearTimeout,
  browser: {
    menus: {
      create: item => { menuItems.push(item); },
      onClicked: { addListener: f => { menuClick = f; } },
    },
    sidebarAction: { open: () => { counts.opened++; return Promise.resolve(); } },
    storage: { session: {
      get: async keys => {
        const out = {};
        for (const k of [].concat(keys)) if (k in sessionStore) out[k] = JSON.parse(JSON.stringify(sessionStore[k]));
        return out;
      },
      set: async o => { for (const k in o) sessionStore[k] = JSON.parse(JSON.stringify(o[k])); },
    } },
    runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
  },
});
for (const f of ['lib/i18n.js', 'lib/policy.js', 'lib/state.js', 'lib/siteGate.js', 'lib/bg-panel.js', 'lib/bg-menus.js']) {
  try { vm.runInContext(read(f), bg, { filename: f }); } catch (e) { ok(`loads ${f}`, false, e.message); }
}
const g = expr => vm.runInContext(expr, bg);
const idFor = ctx => (menuItems.find(i => i.contexts.length === 1 && i.contexts[0] === ctx) || {}).id;
const click = (ctx, info, tab) => menuClick({ menuItemId: idFor(ctx), ...info }, tab);
const beginSites = id => json(g(`cizSiteGate.begin('${id}', { newChat: true, tabUrl: '', text: '' })`));

// ---------------------------------------------------------------- background checks

async function backgroundPart() {
  await scenario('background', async () => {
    ok('three items: selection, page and link, each with its title and its context', json(menuItems.map(i => [i.title, i.contexts])) === json([
      ['Ask Claude about this selection', ['selection']], ['Ask Claude about this page', ['page']], ['Ask Claude about this link', ['link']]]),
      json(menuItems.map(i => [i.title, i.contexts])));
    const news = { id: 7, windowId: 2, title: 'A story', url: 'https://news.example/story?x=1' };
    click('selection', { selectionText: 'first line\nsecond line' }, news);
    ok('a selection click opens the sidebar inside the click', counts.opened === 1, `opened ${counts.opened}`);
    await tick();
    const d = g('cizState.get().draft');
    ok('a selection drafts its lines quoted, then its page site', !!d && d.text === '> first line\n> second line\n\n(from news.example)\n\n', json(d));
    ok('the draft names the window the click was in', !!d && d.windowId === 2, json(d));
    click('selection', { selectionText: 'x'.repeat(2500) }, news);
    await tick();
    ok('a selection is cut at 2,000 characters before it is quoted', g('cizState.get().draft').text === '> ' + 'x'.repeat(2000) + '\n\n(from news.example)\n\n');
    ok('a selection adds no site to the next message', beginSites('sel') === '[]');
    click('page', {}, { id: 8, windowId: 2, title: 'Start', url: 'https://start.example/' });
    await tick();
    ok('a page drafts its title and URL', g('cizState.get().draft').text === 'About this page: Start (https://start.example/)\n\n');
    ok('a page adds its site to the next message, even a new chat', beginSites('pg') === '["start.example"]');
    ok('and only to that message', beginSites('pg2') === '[]');
    click('page', {}, { id: 9, windowId: 2, title: '', url: 'https://plain.example/' });
    await tick();
    ok('a page with no title drafts its URL alone', g('cizState.get().draft').text === 'About this page: https://plain.example/\n\n');
    ok('and still adds its site', beginSites('pl') === '["plain.example"]');
    click('link', { linkText: 'the docs', linkUrl: 'https://docs.example/a' }, news);
    await tick();
    ok('a link drafts its text and URL', g('cizState.get().draft').text === 'About this link: the docs (https://docs.example/a)\n\n');
    ok("a link adds its own site, not the page's, to the next message", beginSites('ln') === '["docs.example"]');
    ok('every menu click opened the sidebar', counts.opened === 5, `opened ${counts.opened}`);
    await vm.runInContext(`handlePanel({ type: 'draftTaken' }, { postMessage() {} })`, bg);
    ok('draftTaken clears the draft', g('cizState.get().draft') === null);
    sessionStore.state = { draft: { text: 'left over', windowId: 1 } };
    await g('cizState.load()');
    ok('a restart drops a draft left over in the session', g('cizState.get().draft') === null);
  });
}

// ---------------------------------------------------------------- panel (jsdom): the draft and the starter chips

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { /* the panel part is skipped below */ }
const READY = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected', hostVersion: '0.4.0', claude: { installed: true, loggedIn: true, email: 'f.work@example.com', plan: 'pro' }, debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '' };
const WEB_LABELS = ['Summarize this page', 'Key points', 'Translate to Portuguese (Brazil)', '/tabs', '/help'];
const WEB_FILLS = ['Summarize this page', 'Give me the key points of this page', 'Translate this page to Portuguese (Brazil)', '/tabs', '/help'];
const PLAIN_LABELS = ['Summarize this page', '/tabs', '/help'];

function makePanel(tab, windowId) {
  const { panelPage, evalPanel } = require('./lib/panel-scripts');
  const { html, files } = panelPage(ext);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, sent = [], hooks = { tab, onMsg: null, activated: null };
  w.browser = {
    runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { hooks.onMsg = f; } } }), getManifest: () => ({ version: '0.4.0' }) },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [hooks.tab], onActivated: { addListener: f => { hooks.activated = f; } }, onUpdated: { addListener() {} } },
    windows: { getCurrent: async () => ({ id: windowId }) },
  };
  w.eval(read('lib/markdown.js') + '\n;window.cizMarkdown=cizMarkdown;');
  w.eval(read('lib/wall.js'));
  evalPanel(dom, ext, files);
  return {
    w, sent, hooks,
    $: id => w.document.getElementById(id),
    chips: () => [...w.document.querySelectorAll('.starters .chip')],
    deliver: state => hooks.onMsg({ type: 'state', state: { ...READY, ...state }, log: [] }),
    count: type => sent.filter(m => m.type === type).length,
  };
}

async function panelPart() {
  await scenario('panel: starter chips follow the active tab', async () => {
    const p = makePanel({ title: 'Start', url: 'https://start.example/' }, 1);
    await tick(50);
    p.deliver({});
    await tick();
    ok('a web page shows five reading chips, with their labels', json(p.chips().map(c => c.textContent)) === json(WEB_LABELS), json(p.chips().map(c => c.textContent)));
    ok('and their fills', json(p.chips().map(c => c.dataset.fill)) === json(WEB_FILLS), json(p.chips().map(c => c.dataset.fill)));
    p.chips()[1].click();
    await tick();
    ok('a reading chip sends its fill, as the other chips do', p.sent.some(m => m.type === 'chat' && m.text === WEB_FILLS[1]));
    p.hooks.tab = { title: 'Doc', url: 'file:///C:/docs/a.html' };
    await p.hooks.activated();
    await tick();
    ok('a non-web tab shows the three chips again, with their fills', json(p.chips().map(c => c.textContent)) === json(PLAIN_LABELS) && json(p.chips().map(c => c.dataset.fill)) === json(PLAIN_LABELS), json(p.chips().map(c => c.textContent)));
    p.hooks.tab = { title: 'Start', url: 'https://start.example/' };
    await p.hooks.activated();
    await tick();
    ok('back on a web page, the five come back', json(p.chips().map(c => c.textContent)) === json(WEB_LABELS));
  });
  await scenario("panel: a draft fills this window's bar, unsent, once", async () => {
    const p = makePanel({ title: 'Start', url: 'https://start.example/' }, 1);
    await tick(50);
    p.deliver({});
    await tick();
    const text = 'About this page: Start (https://start.example/)\n\n';
    const chats = p.count('chat');
    p.deliver({ draft: { text, windowId: 1 } });
    p.deliver({ draft: { text, windowId: 1 } });
    await tick();
    ok('the draft fills the bar', p.$('input').value === text, json(p.$('input').value));
    ok('the bar takes the focus', p.w.document.activeElement === p.$('input'));
    ok('nothing is sent with the draft', p.count('chat') === chats);
    ok('draftTaken is posted once, though two states carried the draft', p.count('draftTaken') === 1, `posted ${p.count('draftTaken')}`);
    p.deliver({ draft: { text: 'Other window', windowId: 2 } });
    await tick();
    ok('a draft for another window stays out of this bar', p.$('input').value === text && p.count('draftTaken') === 1);
    p.deliver({ draft: null });
    await tick();
    p.deliver({ draft: { text: 'Again', windowId: 1 } });
    await tick();
    ok('after a state with no draft, the next draft is taken', p.$('input').value === 'Again' && p.count('draftTaken') === 2, `posted ${p.count('draftTaken')}`);
  });
}

(async () => {
  await g('cizState.load()');   // what background.js does at startup: the state is read before anything else
  await backgroundPart();
  if (JSDOM) await panelPart(); else console.log('SKIP  panel part: jsdom not installed');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('ERROR', e.stack); process.exit(1); });
