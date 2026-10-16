'use strict';
// The site card, the Automatic switch (Trusted mode's internal name) and the Sites list in the real panel (jsdom), and their background side: policy.js,
// state.js, bg-permissions.js and bg-panel.js run in one vm context. Optional DOM test: needs jsdom (npm i --no-save jsdom,
// or NODE_PATH pointing at one). Skips without it.   NODE_PATH=... node test/dom-sites.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(dir);
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const sent = [];
let onMsg;
let storageChanged = null;
const sitesStore = { 'youtube.com': 'allow', 'bank.example': 'block' };
w.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.11.0' }) },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({ sites: sitesStore }), set: async () => {} },
    onChanged: { addListener: f => { storageChanged = f; } },
  },
  tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
};
w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8'));
evalPanel(dom, dir, panelFiles);

const $ = id => w.document.getElementById(id);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
// One check: a throw inside it is a failed check, not the end of the run.
const check = async (name, fn) => { try { ok(name, !!(await fn())); } catch (e) { ok(name, false, String((e && e.message) || e)); } };
const base = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected',
  debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '', watch: false, watchOnLoad: null, watchAsk: null,
  siteAsk: null, trusted: false };
const push = s => onMsg({ type: 'state', state: Object.assign({}, base, s), log: [] });
const wait = ms => new Promise(r => setTimeout(r, ms));
const change = id => $(id).dispatchEvent(new w.Event('change'));
const sentOf = type => sent.filter(m => m.type === type);
const lastOf = type => sentOf(type).pop();
const btnIn = (node, text) => [...node.querySelectorAll('button')].find(b => b.textContent === text);
const rows = () => [...$('siteList').querySelectorAll('li')];
const rowFor = site => rows().find(li => li.querySelector('.mono').textContent === site);
const SITE = { id: 's1', site: 'youtube.com', action: 'read', kind: 'site' };
const RISKY = { id: 'r1', site: 'bank.example', action: 'post', kind: 'risky' };
const ACTIONS = { read: 'Read the page', act: 'Act on the page', open: 'Open the page', post: 'Submit a form', leave: 'Leave for this site' };
const AUTO_NOTE = 'Claude answers Yes by itself to the questions about pictures, other sites, form sends, uploads, form filling and folders. Google sign-in pages, blocked sites and protected folders stay off-limits. Pages can try to steer it.';

(async () => {
  try {
    await wait(50);
    await check('the site card sits in the chat page, hidden without a question', () => $('page-chat').contains($('siteCard')) && $('siteCard').hidden === true);
    push({ siteAsk: SITE });
    await check('a site question shows the card with the site named', () => $('siteCard').hidden === false && $('siteCardSite').textContent === 'youtube.com');
    await check('a site question shows three buttons with their texts', () => !$('siteMsg').hidden && !$('siteChat').hidden && !$('siteDeny').hidden && $('siteAllow').hidden
      && $('siteMsg').textContent === 'Allow this message' && $('siteChat').textContent === 'Allow this chat' && $('siteDeny').textContent === 'Deny');
    push({ siteAsk: RISKY });
    await check('a risky question shows two buttons: Allow and Deny', () => $('siteMsg').hidden && $('siteChat').hidden && !$('siteAllow').hidden && !$('siteDeny').hidden
      && $('siteAllow').textContent === 'Allow' && $('siteDeny').textContent === 'Deny');
    await check('each action has its line', () => Object.entries(ACTIONS).every(([action, text]) => {
      push({ siteAsk: Object.assign({}, SITE, { id: 'act-' + action, action }) });
      return $('siteCardAction').textContent === text;
    }));
    const before = sentOf('siteShown').length;
    push({ siteAsk: Object.assign({}, SITE, { id: 'once' }) });
    push({ siteAsk: Object.assign({}, SITE, { id: 'once' }) });
    await check('siteShown goes once per card id', () => sentOf('siteShown').slice(before).length === 1 && lastOf('siteShown').id === 'once');
    await check('each card button posts its choice for its question', () => [['siteMsg', SITE, 'message'], ['siteChat', SITE, 'chat'], ['siteDeny', SITE, 'deny'], ['siteAllow', RISKY, 'allow']]
      .every(([b, q, choice]) => {
        push({ siteAsk: q });
        sent.length = 0;
        $(b).click();
        const m = sent[0];
        return sent.length === 1 && m.type === 'siteAnswer' && m.id === q.id && m.choice === choice;
      }));
    push({ trusted: false });
    await check('the Automatic switch shows the state: off', () => $('trustedToggle').checked === false);
    push({ trusted: true });
    await check('the Automatic switch shows the state: on', () => $('trustedToggle').checked === true);
    await check('the Automatic switch posts setTrusted with on, both ways', () => {
      sent.length = 0;
      $('trustedToggle').checked = false; change('trustedToggle');
      $('trustedToggle').checked = true; change('trustedToggle');
      const t = sentOf('setTrusted');
      return t.length === 2 && t[0].on === false && t[1].on === true;
    });
    await check('the Automatic note reads exactly as specified', () => $('trustedNote').textContent === AUTO_NOTE);
    await check('the Automatic switch is labelled Automatic', () => w.document.querySelector('label[for="trustedToggle"]').textContent === 'Automatic');
    await check('the Automatic row sits directly under the Unsafe mode row and its note', () => {
      const row = $('trustedToggle').closest('.row');
      return !!row && row.previousElementSibling === $('unsafeNote') && $('unsafeNote').previousElementSibling.contains($('unsafeToggle'));
    });
    await wait(50);
    await check('the Sites list has a row per stored site, drawn from storage', () => rows().length === 2 && !!rowFor('youtube.com') && !!rowFor('bank.example'));
    await check('the current choice is marked on its row', () => btnIn(rowFor('youtube.com'), 'Allow').getAttribute('aria-pressed') === 'true'
      && btnIn(rowFor('youtube.com'), 'Block').getAttribute('aria-pressed') === 'false');
    await check('Block posts siteListSet with block', () => { sent.length = 0; btnIn(rowFor('youtube.com'), 'Block').click(); const m = lastOf('siteListSet'); return m.site === 'youtube.com' && m.value === 'block'; });
    await check('Allow posts siteListSet with allow', () => { btnIn(rowFor('bank.example'), 'Allow').click(); const m = lastOf('siteListSet'); return m.site === 'bank.example' && m.value === 'allow'; });
    await check('Remove posts siteListSet with null', () => { btnIn(rowFor('bank.example'), 'Remove').click(); const m = lastOf('siteListSet'); return m.site === 'bank.example' && m.value === null; });
    await check('Add site posts siteListSet with allow', () => { $('siteAdd').value = 'example.org'; $('siteAddBtn').click(); const m = lastOf('siteListSet'); return m.site === 'example.org' && m.value === 'allow'; });
    await check('a change to the stored sites redraws the list', () => { storageChanged({ sites: { newValue: { 'news.example': 'block' } } }, 'local'); return rows().length === 1 && !!rowFor('news.example'); });

    // The background side: policy.js (the CIZ constants), state.js, bg-permissions.js and bg-panel.js in one vm context.
    // The native helper, the other background files and the confirm window are stubs.
    const nativeSent = [], askCalls = [], siteCalls = [], confirmAnswer = { ok: true };
    let bgSites = {}, bgWrites = 0;
    const sb = {
      URL, console, setTimeout, askCalls, confirmAnswer,
      browser: {
        storage: {
          session: { get: async () => ({}), set: async () => {} },
          local: {
            get: async () => ({ sites: JSON.parse(JSON.stringify(bgSites)) }),
            set: async o => { bgWrites++; bgSites = JSON.parse(JSON.stringify(o.sites)); },
          },
        },
        runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} } },
      },
      sendNative: m => { nativeSent.push(m); return true; },
      disconnectNative() {}, failChats() {}, cizNetReset() {},
      pendingActions: new Map(),
      cizLocal: { cancelAll: async () => {}, remove: async () => {} },
      cizArmy: { closeAll: async () => {} },
      cizSiteGate: {
        shown: id => siteCalls.push(['shown', id]),
        answer: (id, choice) => siteCalls.push(['answer', id, choice]),
        cancel: () => siteCalls.push(['cancel']),
      },
    };
    sb.CIZ_LOCALES = require('./lib/locales').load();   // lib/i18n.js reads the texts from here
    const bgCtx = vm.createContext(sb);
    for (const f of ['lib/i18n.js', 'lib/policy.js', 'lib/state.js', 'lib/bg-permissions.js', 'lib/bg-panel.js']) vm.runInContext(fs.readFileSync(dir + f, 'utf8'), bgCtx, { filename: f });
    vm.runInContext('askConfirm = async p => { askCalls.push(p); return confirmAnswer; };', bgCtx);   // the confirm window: records the question
    const bg = code => vm.runInContext(code, bgCtx);
    const panelBg = msg => bg(`handlePanel(${JSON.stringify(msg)}, { postMessage() {} })`);
    await bg('cizState.load()');
    await bg('cizState.set({ agent: "active" })');
    await check('a full URL is kept as its host: lowercase, one leading www dropped', async () => {
      await panelBg({ type: 'siteListSet', site: 'https://www.YouTube.com/x', value: 'allow' });
      return JSON.stringify(bgSites) === '{"youtube.com":"allow"}';
    });
    await check('a bare host is kept as it is', async () => {
      await panelBg({ type: 'siteListSet', site: 'bank.example', value: 'block' });
      return JSON.stringify(bgSites) === '{"youtube.com":"allow","bank.example":"block"}';
    });
    await check('an empty site is ignored: nothing is written', async () => {
      const n = bgWrites;
      await panelBg({ type: 'siteListSet', site: '  ', value: 'allow' });
      return bgWrites === n;
    });
    await check('a site that is not a host is ignored, and logged as an error', async () => {
      const n = bgWrites;
      await panelBg({ type: 'siteListSet', site: 'not a site', value: 'allow' });
      return bgWrites === n && bg('cizState.log().some(e => e.kind === "error")');
    });
    await check('a null value removes the site', async () => {
      await panelBg({ type: 'siteListSet', site: 'https://www.bank.example/', value: null });
      return JSON.stringify(bgSites) === '{"youtube.com":"allow"}';
    });
    await check('Automatic on asks the confirm window, and is on after a yes', async () => {
      askCalls.length = 0; confirmAnswer.ok = true;
      await panelBg({ type: 'setTrusted', on: true });
      return askCalls.length === 1 && askCalls[0].kind === 'trusted' && bg('cizState.get().trusted') === true;
    });
    await check('the activity log says Automatic, not Trusted', () => bg('cizState.log().some(e => /^Automatic on:/.test(e.text))') && !bg('cizState.log().some(e => /Trusted/.test(e.text))'));
    await check('Automatic stays off when the confirm window says no', async () => {
      await bg('cizState.set({ trusted: false })');
      confirmAnswer.ok = false;
      await panelBg({ type: 'setTrusted', on: true });
      confirmAnswer.ok = true;
      return bg('cizState.get().trusted') === false;
    });
    await check('Automatic off tells the helper, and is off', async () => {
      await bg('cizState.set({ trusted: true })');
      nativeSent.length = 0;
      await panelBg({ type: 'setTrusted', on: false });
      return nativeSent.some(m => m.type === 'trusted_off') && bg('cizState.get().trusted') === false;
    });
    await check('Stop clears Automatic and the site question, tells the helper, and cancels the site gate', async () => {
      await bg('cizState.set({ trusted: true, siteAsk: { id: "s9", site: "youtube.com", action: "read", kind: "site" } })');
      nativeSent.length = 0; siteCalls.length = 0;
      await bg('stopAll("test")');
      return bg('cizState.get().trusted') === false && bg('cizState.get().siteAsk') === null
        && nativeSent.some(m => m.type === 'trusted_off') && siteCalls.some(c => c[0] === 'cancel');
    });
    await check('siteShown and a siteAnswer with a known choice reach the site gate', async () => {
      siteCalls.length = 0;
      await panelBg({ type: 'siteShown', id: 's9' });
      await panelBg({ type: 'siteAnswer', id: 's9', choice: 'chat' });
      return siteCalls.some(c => c[0] === 'shown' && c[1] === 's9') && siteCalls.some(c => c[0] === 'answer' && c[1] === 's9' && c[2] === 'chat');
    });
    await check('a siteAnswer with another choice does not reach the site gate', async () => {
      siteCalls.length = 0;
      await panelBg({ type: 'siteAnswer', id: 's9', choice: 'bogus' });
      return siteCalls.length === 0;
    });
  } catch (e) {
    fail++;
    console.log('FAIL  the test threw: ' + ((e && e.stack) || e));
  }
  console.log(fail ? `\n${fail} check(s) failed` : `\nAll ${pass} checks passed`);
  process.exit(fail ? 1 : 0);
})();
