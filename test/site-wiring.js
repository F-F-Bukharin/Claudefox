'use strict';
// The site gate wired into the add-on (page safety, A1): page tools, navigate, tab_open, tabs_list, the chat messages and the
// helper's page_read / confirmed_state. Runs the real background scripts against a mocked browser; the page operations are
// stubbed (cfxInPage), the card is answered through the gate like the panel does.   node test/site-wiring.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ext = path.join(__dirname, '..', 'extension');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) { passed++; console.log(`PASS  ${name}`); } else { failed++; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); } };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ev = () => { const fns = []; return { addListener: f => fns.push(f), removeListener: f => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); }, fns, fire: (...a) => fns.forEach(f => f(...a)) }; };

const store = {}, local = {};
let tabs = [], nextTab = 100, native = null;
const created = [], updated = [], ops = [];
let classifyAnswer = { found: true };
const resetTabs = () => {
  tabs = [
    { id: 1, windowId: 1, active: true, title: 'Start', url: 'https://start.example/', status: 'complete' },
    { id: 2, windowId: 1, active: false, title: 'Other', url: 'https://other.example/', status: 'complete' },
    { id: 3, windowId: 2, active: true, title: 'Win2', url: 'https://win2.example/', status: 'complete' },
    { id: 4, windowId: 1, active: false, title: 'Doc', url: 'file:///C:/docs/a.html', status: 'complete' },
    { id: 5, windowId: 1, active: false, title: 'Bad', url: 'https://blocked.example/', status: 'complete' },
  ];
};
resetTabs();
const connectEv = ev(), tabEv = { onActivated: ev(), onUpdated: ev(), onCreated: ev(), onRemoved: ev() };
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
  runtime: {
    onConnect: connectEv, onMessage: ev(),
    getManifest: () => JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')),
    connectNative: () => {
      const onMsg = ev(), onDisc = ev();
      native = { sent: [], onMessage: onMsg, onDisconnect: onDisc, postMessage(m) { this.sent.push(m); }, disconnect() {} };
      return native;
    },
  },
  browserAction: { onClicked: ev(), setBadgeText() {}, setBadgeBackgroundColor() {} },
  sidebarAction: { toggle: async () => {}, open: async () => {} },
  tabs: Object.assign({
    query: async q => tabs.filter(t => (!q.active || t.active) && (q.windowId == null || t.windowId === q.windowId) && (!q.lastFocusedWindow || t.windowId === 1)),
    get: async id => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('no tab'); return t; },
    create: async o => {
      created.push(o);
      const t = { id: nextTab++, windowId: 1, active: o.active !== false, url: o.url, title: '', status: 'complete' };
      tabs.push(t); tabEv.onCreated.fire(Object.assign({}, t)); return t;
    },
    update: async (id, o) => { updated.push([id, o]); return Object.assign(tabs.find(t => t.id === id) || {}, o); },
    remove: async ids => { for (const id of [].concat(ids)) { tabs = tabs.filter(t => t.id !== id); tabEv.onRemoved.fire(id, {}); } },
    reload: async () => {},
    executeScript: async () => [{ ok: true }],
    captureTab: async () => 'data:image/png;base64,AAAA',
  }, tabEv),
  webRequest: { onBeforeRequest: ev(), onSendHeaders: ev(), onHeadersReceived: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() },
  windows: { update: async () => {}, onCreated: ev(), getAll: async () => [{ id: 1, type: 'normal' }] },
};
const fetch = async () => ({ status: 200, ok: true, json: async () => ({ account: { email_address: 'f.work@example.com', full_name: 'F', uuid: 'u-1' } }) });
const ctx = vm.createContext({ browser, fetch, console, URL, URLSearchParams, AbortController, TextEncoder, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, Promise });
ctx.window = ctx;
for (const f of JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')).background.scripts) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx, { filename: f });
// The page operations: recorded, and classify answers what the scenario says.
ctx.cfxInPage = async (tab, op) => {
  ops.push(op + ':' + tab.id);
  if (op === 'classify') { if (classifyAnswer instanceof Error) throw classifyAnswer; return classifyAnswer; }
  if (op === 'ctype') return 'text/html';
  return { ok: true, op };
};
const g = name => vm.runInContext(name, ctx);
const gate = g('cfxSiteGate'), state = g('cfxState');

// ---- helpers
const panel = { name: 'panel', onMessage: ev(), onDisconnect: ev(), postMessage() {} };
const fromPanel = async m => { panel.onMessage.fire(m); await tick(); };
const helperSays = async m => { native.onMessage.fire(m); await tick(); };
const call = (tool, args) => ctx.cfxDebug.call(tool, args || {});
let seq = 0, mseq = 0;
async function armyCall(tool, args, worker, run) {
  const id = `c${++seq}`;
  native.onMessage.fire({ type: 'call', id, tool, args: args || {}, source: 'Army worker', army: { run: run || 'r1', worker: worker || 'w1' } });
  for (let i = 0; i < 300; i++) { const m = native.sent.find(x => x.type === 'result' && x.id === id); if (m) return m; await tick(10); }
  return { ok: false, error: 'no result' };
}
// A message with the usual start: the active tab is start.example.
const begin = o => (o && o.keep ? 0 : resetTabs(), gate.begin('m' + (++mseq), Object.assign({ tabUrl: 'https://start.example/', windowId: 1, text: '', newChat: true, allow: [] }, o)));
// Answers the cards the call raises, in order (the panel's job), and returns them with the call's result.
async function cards(p, choices) {
  const seen = [];
  let last = null;
  for (const choice of choices) {
    let ask = null;
    for (let i = 0; i < 100 && !ask; i++) { await tick(5); const a = state.get().siteAsk; if (a && a.id !== last) ask = a; }
    if (!ask) break;
    seen.push(ask); last = ask.id;
    gate.shown(ask.id); gate.answer(ask.id, choice);
  }
  return { seen, res: await p };
}
const noCard = () => !state.get().siteAsk;
const did = what => ops.some(o => o === what);
const clear = () => { ops.length = 0; updated.length = 0; created.length = 0; classifyAnswer = { found: true }; };
const refused = (res, re) => !res.ok && re.test(res.error);

(async () => {
  try {
    await tick(50);
    connectEv.fire(panel);
    await fromPanel({ type: 'signIn' });
    await helperSays({ type: 'hello', version: '0.11.0', clients: [] });
    await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'f.work@example.com' });
    let r, c;

    // 1. reading a tab outside the chat's sites asks, and a deny refuses
    begin(); clear();
    c = await cards(call('read_page', { tab_id: 2 }), ['deny']);
    check('read_page on a tab outside the list sets siteAsk (site, read) and is refused after a deny',
      c.seen.length === 1 && c.seen[0].site === 'other.example' && c.seen[0].action === 'read' && c.seen[0].kind === 'site' && refused(c.res, /did not allow other\.example/) && !did('read:2'), JSON.stringify([c.seen, c.res]));
    r = await call('read_page', { tab_id: 2 });
    check('the same call again is refused at once, with no new card', refused(r, /did not allow other\.example/) && noCard());

    // 2. inside the list it runs; an allow entry in the site list runs too
    clear(); r = await call('read_page', {});
    check('read_page on the message\'s own site runs with no card', r.ok && did('read:1') && noCard(), JSON.stringify(r));
    local.sites = { 'other.example': 'allow' };
    r = await call('find', { tab_id: 2, query: 'x' });
    check('a site marked allow in the site list runs with no card', r.ok && did('find:2') && noCard(), JSON.stringify(r));

    // 3. blocked and trusted
    local.sites = { 'blocked.example': 'block' };
    r = await call('get_page_text', { tab_id: 5 });
    check('a blocked site is refused with the blocked text', refused(r, /blocked\.example is blocked in your site list/) && !did('text:5'), JSON.stringify(r));
    await state.set({ trusted: true }); delete local.sites; begin(); clear();
    r = await call('read_page', { tab_id: 2 });
    check('trusted runs a read outside the list without a card', r.ok && did('read:2') && noCard(), JSON.stringify(r));
    local.sites = { 'other.example': 'block' };
    r = await call('read_page', { tab_id: 2 });
    check('trusted does not lift a block', refused(r, /is blocked in your site list/), JSON.stringify(r));
    await state.set({ trusted: false }); delete local.sites;
    await state.set({ unsafe: true }); begin(); clear();
    r = await call('read_page', { tab_id: 2 });
    check('Unsafe mode counts as trusted: a read outside the list runs without a card', r.ok && did('read:2') && noCard(), JSON.stringify(r));
    await state.set({ unsafe: false }); delete local.sites;

    // 3b. Automatic mode (the state key is still trusted): no site card, no risky card; blocks and Google sign-in stay
    // off-limits; with it off every one of these asks; Unsafe lifts the Google rule.
    await state.set({ trusted: true }); begin(); clear();
    r = await call('read_page', {});   // the router marks the message read, so risky steps can ask
    clear(); classifyAnswer = { found: true, submitsPost: true };
    r = await call('click', { selector: 'button' });
    check('Automatic: after a page read, a click that sends a form runs with no risky card', r.ok && did('click:1') && noCard(), JSON.stringify(r));
    clear(); classifyAnswer = { found: true, leavesTo: 'away.example' };
    r = await call('click', { selector: 'a' });
    check('Automatic: a click that leaves for another site runs with no risky card', r.ok && did('click:1') && noCard(), JSON.stringify(r));
    clear(); classifyAnswer = { found: true };
    r = await call('navigate', { url: 'https://new3.example/' });
    check('Automatic: navigate to another site after a page read asks nothing', r.ok && noCard() && updated.some(u => u[1].url === 'https://new3.example/'), JSON.stringify(r));
    local.sites = { 'away.example': 'block' };
    clear(); classifyAnswer = { found: true, leavesTo: 'away.example' };
    r = await call('click', { selector: 'a' });
    check('Automatic: a click that leaves for a blocked site is still refused', refused(r, /away\.example is blocked in your site list/) && !did('click:1') && noCard(), JSON.stringify(r));
    delete local.sites;
    clear();
    r = await call('navigate', { url: 'https://accounts.google.com/signin' });
    check('Automatic: Google sign-in pages stay off-limits for navigate', refused(r, /Google sign-in pages are hands-off/) && updated.length === 0, JSON.stringify(r));
    r = await call('tab_open', { url: 'https://accounts.google.com/' });
    check('Automatic: Google sign-in pages stay off-limits for tab_open', refused(r, /Google sign-in pages are hands-off/) && created.length === 0, JSON.stringify(r));
    await state.set({ trusted: false, unsafe: true }); begin(); clear();
    r = await call('navigate', { url: 'https://accounts.google.com/signin' });
    check('Unsafe mode lifts the Google rule: navigate to a sign-in page goes', r.ok && updated.some(u => u[1].url === 'https://accounts.google.com/signin'), JSON.stringify(r));
    await state.set({ trusted: false, unsafe: false }); begin(); clear();
    r = await call('read_page', {});
    clear(); classifyAnswer = { found: true, submitsPost: true };
    c = await cards(call('click', { selector: 'button' }), ['deny']);
    check('Automatic off: the same form send asks a risky card, and a deny stops the click', c.seen.length === 1 && c.seen[0].kind === 'risky' && c.seen[0].action === 'post' && !c.res.ok && !did('click:1'), JSON.stringify([c.seen, c.res]));
    begin(); clear();
    c = await cards(call('read_page', { tab_id: 2 }), ['deny']);
    check('Automatic off: a site outside the list asks the site card', c.seen.length === 1 && c.seen[0].kind === 'site' && !c.res.ok, JSON.stringify([c.seen, c.res]));
    // One rule for "is Automatic on": cfxAutomatic() in lib/pageTools.js (Automatic or Unsafe; never a scheduled macro's turn).
    const auto = () => g('cfxAutomatic')();
    await state.set({ trusted: false, unsafe: false });
    const off = auto();
    await state.set({ trusted: true });
    const onA = auto();
    await state.set({ trusted: false, unsafe: true });
    const onU = auto();
    gate.begin('sched1', { scheduled: ['start.example'] });
    const inSched = auto();
    gate.end('sched1');
    await state.set({ trusted: false, unsafe: false });
    check('cfxAutomatic: off when neither switch is on, on for Automatic and for Unsafe, off in a scheduled macro\'s turn', off === false && onA === true && onU === true && inSched === false, JSON.stringify([off, onA, onU, inSched]));

    clear(); classifyAnswer = { found: true };

    // 4. acting asks like reading
    begin(); clear();
    c = await cards(call('click', { tab_id: 2, selector: 'a' }), ['deny']);
    check('click on a tab outside the list asks (act) and a deny stops the click', c.seen.length === 1 && c.seen[0].action === 'act' && !c.res.ok && !did('click:2'), JSON.stringify([c.seen, c.res]));

    // 5. navigate
    begin(); clear();
    c = await cards(call('navigate', { url: 'https://new.example/p' }), ['message']);
    check('navigate to another site asks open, then goes (nothing read yet, so no leave card)',
      c.seen.length === 1 && c.seen[0].site === 'new.example' && c.seen[0].action === 'open' && c.res.ok && updated.some(u => u[0] === 1 && u[1].url === 'https://new.example/p'), JSON.stringify([c.seen, c.res, updated]));
    begin(); clear();
    r = await call('navigate', { url: 'https://start.example/other' });
    check('navigate inside the list asks nothing', r.ok && noCard() && updated.length === 1, JSON.stringify(r));
    r = await call('navigate', { url: 'reload' });
    check('reload asks nothing', r.ok && noCard());
    begin(); clear(); gate.markRead();
    c = await cards(call('navigate', { url: 'https://new2.example/' }), ['message', 'deny']);
    check('after a page read, navigate to another site also asks risky leave, and a deny keeps the tab where it is',
      c.seen.length === 2 && c.seen[1].kind === 'risky' && c.seen[1].action === 'leave' && c.seen[1].site === 'new2.example' && !c.res.ok && updated.length === 0, JSON.stringify([c.seen, c.res]));

    // 6. tab_open
    begin(); clear();
    c = await cards(call('tab_open', { url: 'https://fresh.example/' }), ['message']);
    check('tab_open to a new site asks open and then opens it', c.seen.length === 1 && c.seen[0].action === 'open' && c.seen[0].site === 'fresh.example' && c.res.ok && created.length === 1, JSON.stringify([c.seen, c.res]));
    begin(); clear(); gate.markRead();
    c = await cards(call('tab_open', { url: 'https://fresh2.example/' }), ['message', 'allow']);
    check('after a page read, tab_open to another site than the window\'s active tab also asks risky leave',
      c.seen.length === 2 && c.seen[1].kind === 'risky' && c.seen[1].action === 'leave' && c.res.ok && created.length === 1, JSON.stringify([c.seen, c.res]));
    begin(); clear(); gate.markRead();
    r = await call('tab_open', { url: 'https://start.example/b' });
    check('tab_open to the active tab\'s own site asks nothing', r.ok && noCard() && created.length === 1, JSON.stringify(r));

    // 7. a click, Enter or submitting type_text is classified once a page was read in this message
    begin(); clear(); classifyAnswer = { found: true, submitsPost: true };
    r = await call('click', { selector: 'button' });
    check('before any page read, a click is not classified and does not ask', r.ok && !ops.some(o => /^classify/.test(o)) && did('click:1') && noCard(), JSON.stringify(r));
    r = await call('read_page', {});   // the router marks the message read
    clear(); classifyAnswer = { found: true, submitsPost: true };
    c = await cards(call('click', { selector: 'button' }), ['deny']);
    check('after a page read, a click that submitsPost asks risky post for the tab\'s site, and a deny stops the click',
      c.seen.length === 1 && c.seen[0].kind === 'risky' && c.seen[0].action === 'post' && c.seen[0].site === 'start.example' && !c.res.ok && !did('click:1'), JSON.stringify([c.seen, c.res]));
    clear(); classifyAnswer = { found: true, leavesTo: 'away.example' };
    c = await cards(call('click', { selector: 'a' }), ['allow']);
    check('a click that leavesTo asks risky leave for that site, and Allow lets it through', c.seen.length === 1 && c.seen[0].action === 'leave' && c.seen[0].site === 'away.example' && c.res.ok && did('click:1'), JSON.stringify([c.seen, c.res]));
    clear(); classifyAnswer = { found: false };
    r = await call('click', { selector: 'nope' });
    check('classify found:false goes on without a card', r.ok && noCard() && did('click:1'), JSON.stringify(r));
    clear(); classifyAnswer = new Error('boom');
    r = await call('click', { selector: 'a' });
    check('a classify error refuses the call', refused(r, /Could not check what this action does, so Claude did not do it\./) && !did('click:1'), JSON.stringify(r));
    clear(); classifyAnswer = new Error('Unknown page operation: classify');
    r = await call('click', { selector: 'a' });
    check('"Unknown page operation" (an older page script) goes on', r.ok && did('click:1'), JSON.stringify(r));
    begin(); gate.markRead(); clear(); classifyAnswer = { found: true, submitsPost: true };   // a new message: the earlier deny is forgotten
    c = await cards(call('press_key', { key: 'Enter' }), ['deny']);
    check('press_key Enter is classified', c.seen.length === 1 && c.seen[0].action === 'post' && !did('press:1'), JSON.stringify(c.seen));
    clear(); r = await call('press_key', { key: 'a' });
    check('press_key with another key is not classified', r.ok && !ops.some(o => /^classify/.test(o)));
    begin(); gate.markRead(); clear(); classifyAnswer = { found: true, submitsPost: true };
    c = await cards(call('type_text', { text: 'x', submit: true }), ['deny']);
    check('type_text with submit is classified', c.seen.length === 1 && c.seen[0].action === 'post' && !did('type:1'), JSON.stringify(c.seen));
    clear(); r = await call('type_text', { text: 'x' });
    check('type_text without submit is not classified', r.ok && !ops.some(o => /^classify/.test(o)));

    // 8. network_log goes through the gate
    begin(); clear();
    c = await cards(call('network_log', { tab_id: 2 }), ['deny']);
    check('network_log on a tab outside the list asks (read)', c.seen.length === 1 && c.seen[0].site === 'other.example' && c.seen[0].action === 'read' && !c.res.ok, JSON.stringify([c.seen, c.res]));

    // 9. tabs_list: the chat window only, outside sites redacted
    begin({ text: '' }); clear(); local.sites = { 'blocked.example': 'block' };
    await g('cfxArmy').register(1, { run: 'rt', worker: 'w9' }, 0);
    r = await call('tabs_list');
    const byId = Object.fromEntries((r.result || []).map(t => [t.id, t]));
    check('tabs_list lists only the chat window\'s tabs', r.ok && [1, 2, 4, 5].every(i => byId[i]) && !byId[3] && r.result.length === 4, JSON.stringify(r.result && r.result.map(t => t.id)));
    check('tabs_list shows a listed site in full (with the army owner) and redacts outside and blocked sites',
      byId[1].url === 'https://start.example/' && byId[1].army === 'w9' && byId[2].url === undefined && byId[2].title === undefined && byId[2].site === 'other.example' && byId[5].url === undefined && byId[5].site === 'blocked.example', JSON.stringify(r.result));
    delete local.sites; g('cfxArmy').unregister(1);
    await state.set({ trusted: true });
    r = await call('tabs_list');
    check('trusted shows the window\'s tabs in full', r.ok && r.result.length === 4 && r.result.every(t => t.url), JSON.stringify(r.result));
    await state.set({ trusted: false });

    // 10. startChat tells the helper the sites and trusted; a card answer sends scope; the end ends the message
    const lastChat = () => [...native.sent].reverse().find(m => m.type === 'chat');
    await fromPanel({ type: 'chat', id: 'chat1', text: 'compare with https://news.example/x please' });
    let m = lastChat();
    check('startChat sends sites (the active tab\'s plus the text\'s) and trusted false in the chat message',
      m && m.id === 'chat1' && JSON.stringify(m.sites) === JSON.stringify(['start.example', 'news.example']) && m.trusted === false, JSON.stringify(m));
    native.sent.length = 0;
    c = await cards(call('read_page', { tab_id: 2 }), ['message']);
    const scope = native.sent.find(x => x.type === 'scope');
    check('answering "this message" sends scope with the message id, the new list and trusted',
      c.res.ok && scope && scope.id === 'chat1' && scope.sites.includes('other.example') && scope.trusted === false, JSON.stringify(scope));
    await helperSays({ type: 'chat_done', id: 'chat1', ok: true });
    check('chat_done ends the message: the gate\'s list is empty', gate.list().length === 0, JSON.stringify(gate.list()));
    await state.set({ trusted: true });
    await fromPanel({ type: 'chat', id: 'chat2', text: 'hi' });
    m = lastChat();
    check('startChat sends trusted true when the state says so', m && m.id === 'chat2' && m.trusted === true, JSON.stringify(m));
    await helperSays({ type: 'chat_done', id: 'chat2', ok: true });
    await state.set({ trusted: false, unsafe: true });
    await fromPanel({ type: 'chat', id: 'chat2u', text: 'hi' });
    m = lastChat();
    check('startChat sends trusted true in Unsafe mode', m && m.id === 'chat2u' && m.trusted === true && m.unsafe === true, JSON.stringify(m));
    await helperSays({ type: 'chat_done', id: 'chat2u', ok: true });
    await state.set({ trusted: true, unsafe: false });
    await fromPanel({ type: 'chat', id: 'chat3', text: 'improve', improve: true });
    m = lastChat();
    check('an improve chat sends sites [] and trusted false', m && m.id === 'chat3' && JSON.stringify(m.sites) === '[]' && m.trusted === false, JSON.stringify(m));
    await helperSays({ type: 'chat_done', id: 'chat3', ok: true });
    await state.set({ trusted: false });
    local.sites = { 'kept.example': 'allow' };
    await fromPanel({ type: 'chat', id: 'chat4', text: 'hi' });
    check('sites marked allow in storage are in the list sent', lastChat().sites.includes('kept.example'), JSON.stringify(lastChat().sites));
    delete local.sites;

    // 11. the helper's page_read marks the message read (chat4 is running)
    gate.begin('chat4', { tabUrl: 'https://start.example/', windowId: 1, text: '', newChat: true, allow: [] });
    const before = gate.isRead();
    await helperSays({ type: 'page_read' });
    check('a page_read message from the helper marks the message read', before === false && gate.isRead() === true);

    // 12. confirmed_state mirrors trusted; turning it off mid-turn sends scope
    await state.set({ trusted: true });
    await helperSays({ type: 'confirmed_state', unsafe: false, trusted: true });
    check('confirmed_state trusted true keeps trusted on', state.get().trusted === true);
    native.sent.length = 0;
    await helperSays({ type: 'confirmed_state', unsafe: false, trusted: false });
    const sc = native.sent.find(x => x.type === 'scope');
    check('confirmed_state trusted false turns state.trusted off', state.get().trusted === false);
    check('and, with a turn running, sends scope with trusted false', sc && sc.id === 'chat4' && sc.trusted === false, JSON.stringify(sc));
    await state.set({ trusted: true });
    await helperSays({ type: 'confirmed_state', unsafe: false });
    check('confirmed_state without trusted means off', state.get().trusted === false);

    // 13. an army worker is held to the run's list
    r = await armyCall('tab_open', { url: 'https://out.example/' }, 'w1', 'ra');
    check('an army tab_open outside the run\'s list gets the lead-sites text', refused(r, /Outside the sites the lead may use: out\.example\./) && created.length === 0, JSON.stringify(r));
    r = await armyCall('tab_open', { url: 'https://start.example/w' }, 'w1', 'ra');
    check('an army tab_open inside the list opens', r.ok && created.length === 1, JSON.stringify(r));
    const A = r.ok && r.result.tab_id;
    tabs.find(t => t.id === A).url = 'https://out.example/';
    clear(); r = await armyCall('read_page', { tab_id: A }, 'w1', 'ra');
    check('an army read on a tab that is now outside the list gets the same text', refused(r, /Outside the sites the lead may use: out\.example\./) && !did('read:' + A), JSON.stringify(r));

    // 14. wait_for passes the refusal through instead of waiting
    begin({ keep: true }); clear();
    c = await cards(call('wait_for', { tab_id: 2, text: 'x', timeout_ms: 500 }), ['deny']);
    check('wait_for passes the "did not allow" text through', refused(c.res, /did not allow other\.example/), JSON.stringify(c.res));
    local.sites = { 'other.example': 'block' };
    r = await call('wait_for', { tab_id: 2, text: 'x', timeout_ms: 500 });
    check('wait_for passes the blocked text through', refused(r, /is blocked in your site list/), JSON.stringify(r));
    delete local.sites;
    r = await armyCall('wait_for', { tab_id: A, text: 'x', timeout_ms: 500 }, 'w1', 'ra');
    check('wait_for passes the lead-sites text through', refused(r, /Outside the sites the lead may use/), JSON.stringify(r));

    // 15. reading a file: tab during a turn tells the helper
    await state.set({ localGrants: ['C:\\docs'] });
    gate.begin('chat4', { tabUrl: 'https://start.example/', windowId: 1, text: '', newChat: true, allow: [] });
    native.sent.length = 0;
    r = await call('read_page', { tab_id: 4 });
    check('reading a file: tab in a turn sends local_read with the message id (no site card)', r.ok && native.sent.some(x => x.type === 'local_read' && x.id === 'chat4') && noCard(), JSON.stringify([r, native.sent]));
    native.sent.length = 0;
    r = await call('read_page', { tab_id: 1 });
    check('reading a web tab does not send local_read', r.ok && !native.sent.some(x => x.type === 'local_read'));
  } catch (e) {
    check('no unexpected errors', false, e.stack);
  } finally {
    console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${passed} checks passed, 0 failed`);
    process.exit(failed ? 1 : 0);
  }
})();
