'use strict';
// Macros (E7) and scheduled macros (E8): a real panel in jsdom wired to the real background scripts in a vm (the helper, alarms and
// notifications are recorders). Needs jsdom (npm i --no-save jsdom, or NODE_PATH). Skips without it.
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
  { id: 9, windowId: 1, active: false, title: 'News', url: 'https://news.example/a', status: 'complete' },
  { id: 10, windowId: 1, active: false, title: 'Evil', url: 'https://evil.example/', status: 'complete' },
];
const connectEv = ev(), tabEv = { onActivated: ev(), onUpdated: ev(), onCreated: ev(), onRemoved: ev() }, winRemoved = ev();
let native = null;
const alarms = new Map(), alarmEv = ev(), notes = [], longTimers = [];
const storageChanged = ev();
const store = (o, kind) => ({
  get: async k => Object.fromEntries((k == null ? Object.keys(o) : [].concat(typeof k === 'object' && !Array.isArray(k) ? Object.keys(k) : k)).filter(x => x in o).map(x => [x, clone(o[x])])),
  set: async v => { const ch = {}; for (const k in v) { ch[k] = { oldValue: o[k], newValue: clone(v[k]) }; o[k] = clone(v[k]); } if (kind === 'local') storageChanged.fire(ch, 'local'); },
  remove: async k => { for (const x of [].concat(k)) delete o[x]; },
});
const browser = {
  storage: { local: store(local, 'local'), session: store(session), onChanged: storageChanged },
  alarms: { create: (name, info) => { alarms.set(name, info); }, clear: async n => alarms.delete(n), getAll: async () => [...alarms].map(([name, i]) => Object.assign({ name }, i)), onAlarm: alarmEv },
  notifications: { create: async (id, o) => { notes.push(o); return id; } },
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
const ctx = vm.createContext({ CFX_LOCALES: require('./lib/locales').load(), browser, fetch, console, URL, URLSearchParams, AbortController, TextEncoder, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout: (fn, ms, ...a) => ms === 30 * 60 * 1000 ? longTimers.push(fn) : setTimeout(fn, ms, ...a), clearTimeout, setInterval: () => 0, Promise });
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
  w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;');
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
  const A = makePanel(1);
  await wait(50);
  A.bg.onMessage.fire({ type: 'signIn' });
  await wait(50);
  await helperSays({ type: 'hello', version: '0.11.0', clients: [] });
  await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'f.work@example.com' });
  await wait(60);
  const $ = A.$;
  const macros = () => local.macros || [];
  // ---- Settings → Macros
  const fill = async f => {
    $('macroName').value = f.name || ''; $('macroText').value = f.text == null ? 'Do the thing' : f.text; $('macroArmy').value = f.army || '';
    $('macroSites').value = f.sites || ''; $('macroSched').value = f.sched || 'none'; $('macroAt').value = f.at || ''; $('macroEvery').value = f.every || '';
    $('macroSave').click(); await wait(80);
  };
  const err = () => $('macroErr').textContent;
  await fill({ name: 'bad name!' });
  ok('a name with a space or a symbol is refused', macros().length === 0 && /letters, numbers/i.test(err()), err());
  await fill({ name: 'tabs' });
  ok('a built-in command name is refused', macros().length === 0 && /built-in/i.test(err()), err());
  await fill({ name: 'daily-news', text: 'Summarize the news' });
  ok('a valid macro is saved in storage.local macros', macros().length === 1 && macros()[0].name === 'daily-news' && macros()[0].text === 'Summarize the news' && !macros()[0].schedule, JSON.stringify(local.macros));
  await fill({ name: 'daily-news', text: 'again' });
  ok('a second macro with the same name is refused', macros().length === 1 && /already/i.test(err()), err());
  await fill({ name: 'nosites', sched: 'daily', at: '08:30' });
  ok('a schedule needs sites', macros().length === 1 && /sites/i.test(err()), err());
  await fill({ name: 'bad-hours', sched: 'every', every: '25', sites: 'news.example' });
  await fill({ name: 'bad-hours', sched: 'every', every: '0', sites: 'news.example' });
  ok('every N hours takes 1 to 24 only', macros().length === 1 && /1 to 24/.test(err()), err());
  await fill({ name: 'morning', text: 'Read the headlines', sched: 'daily', at: '08:30', sites: 'News.example, https://www.other.example/path' });
  await fill({ name: 'hourly', text: 'Check the board', sched: 'every', every: '6', sites: 'news.example' });
  await fill({ name: 'shopcheck', text: 'Compare prices', army: 'shop a\n\nshop b\n' });
  const m = Object.fromEntries(macros().map(x => [x.name, x]));
  ok('sites are normalised, the schedule kept, army tasks one per line', JSON.stringify(m.morning.sites) === '["news.example","other.example"]' && m.morning.schedule.kind === 'daily' && m.morning.schedule.at === '08:30'
    && m.hourly.schedule.hours === 6 && JSON.stringify(m.shopcheck.army) === '["shop a","shop b"]', JSON.stringify(local.macros));
  ok('the Macros list shows them', /morning/.test($('macroList').textContent) && /shopcheck/.test($('macroList').textContent));

  // ---- alarms
  const al = alarms.get('macro:morning'), ah = alarms.get('macro:hourly');
  const when = al && new Date(al.when);
  ok('a daily macro gets an alarm at the next HH:MM, every day', al && al.when > Date.now() - 1000 && al.when <= Date.now() + 25 * 3600e3 && when.getHours() === 8 && when.getMinutes() === 30 && al.periodInMinutes === 1440, JSON.stringify(al));
  ok('an every-N-hours macro gets an alarm of N x 60 minutes', ah && ah.periodInMinutes === 360 && ah.delayInMinutes === 360, JSON.stringify(ah));
  ok('a macro with no schedule has no alarm', !alarms.has('macro:shopcheck') && !alarms.has('macro:daily-news'));
  $('macroList').querySelector('[data-name="hourly"] .macro-del').click();
  await wait(80);
  ok('removing a macro removes its alarm', !alarms.has('macro:hourly') && !macros().some(x => x.name === 'hourly'));
  await fill({ name: 'hourly', text: 'Check the board', sched: 'every', every: '6', sites: 'news.example' });

  // ---- /name
  await A.say('/daily-news');
  let c = chatsToHelper();
  ok('/name sends the macro text', c.length === 1 && c[0].text === 'Summarize the news' && c[0].model !== 'army', JSON.stringify(c[0]));
  await helperSays({ type: 'chat_done', id: c[0].id, ok: true, sessionId: '11111111-1111-1111-1111-111111111111' });
  await A.say('/shopcheck');
  c = chatsToHelper();
  ok('a macro with army tasks sends in Quality with the army on and lists the tasks', c.length === 2 && c[1].model === 'army' && /Compare prices/.test(c[1].text) && /1\. shop a/.test(c[1].text) && /2\. shop b/.test(c[1].text), JSON.stringify(c[1]));
  await helperSays({ type: 'chat_done', id: c[1].id, ok: true });
  await A.say('/nonesuch');
  ok('an unknown name still says unknown command', /Unknown command \/nonesuch/.test(A.text()));

  // ---- scheduled runs
  await g('cfxState').set({ unsafe: true, trusted: true, filesEnabled: true, filesMode: 'write', filesFolder: 'C:/x' });
  const fire = async n => { alarmEv.fire({ name: 'macro:' + n }); await wait(80); };
  const lastNote = () => (notes[notes.length - 1] || {}).message || '';
  await fire('morning');
  c = chatsToHelper();
  const s1 = c[2];
  ok('an alarm runs the macro as a scheduled turn with its sites, no files, unsafe or trusted', c.length === 3 && s1.text === 'Read the headlines' && s1.model === 'speed' && s1.files === '' && s1.unsafe === false && s1.trusted === false
    && JSON.stringify(s1.sites) === '["news.example","other.example"]' && s1.scheduled === true && s1.tab === null && s1.resume === '', JSON.stringify(s1));
  const call = async (tool, args) => { await helperSays({ type: 'call', id: 'k' + Math.random(), tool, args }); return native.sent[native.sent.length - 1]; };
  let r = await call('click', { tab_id: 9, selector: 'a' });
  ok('a scheduled turn\'s click is refused', r.ok === false && r.error === 'Scheduled macros only read pages.', JSON.stringify(r));
  r = await call('create_file', { name: 'x.md', content: 'x' });
  ok('file tools are refused too', r.ok === false && r.error === 'Scheduled macros only read pages.', JSON.stringify(r));
  r = await call('read_page', { tab_id: 10 });
  ok('a read outside its sites is refused with no card', r.ok === false && r.error === "Outside this scheduled macro's sites: evil.example." && !g('cfxState').get().siteAsk, JSON.stringify(r));
  r = await call('read_page', { tab_id: 9 });
  ok('a read inside its sites runs', !/Outside this|Scheduled macros/.test(r.error || '') && !g('cfxState').get().siteAsk, JSON.stringify(r));
  await helperSays({ type: 'chat_event', id: s1.id, event: { kind: 'text', text: 'Digest: all quiet' } });
  await helperSays({ type: 'chat_done', id: s1.id, ok: true, sessionId: '22222222-2222-2222-2222-222222222222' });
  await wait(60);
  const ck = Object.keys(local).find(k => /^chats:/.test(k));
  const ent = ck && local[ck].find(x => x.group === 'Scheduled');
  ok('the result goes to history under Scheduled', ent && /morning/.test(ent.title) && JSON.stringify(local['chat:' + ent.id]).includes('Digest: all quiet'), JSON.stringify(local[ck]));
  ok('a notification says it finished', lastNote() === 'Claudefox: morning finished', lastNote());
  ok('a scheduled turn leaves the chat\'s own session alone', g('cfxState').get().chatSession !== '22222222-2222-2222-2222-222222222222');
  $('histBtn').click(); await wait(120);
  ok('the History drawer shows a Scheduled group', /Scheduled/.test($('histList').textContent) && /morning/.test($('histList').textContent), $('histList').textContent);
  $('histClose').click();

  // skipped: stopped
  const before = chatsToHelper().length, nBefore = notes.length;
  await g('cfxState').set({ agent: 'stopped' });
  await fire('morning');
  ok('a run is skipped while stopped, and logged', chatsToHelper().length === before && notes.length === nBefore + 1 && /^Claudefox: morning skipped: .*stopped/i.test(lastNote()) && g('cfxState').log().some(l => /morning/.test(l.text) && /skipped/i.test(l.text)), lastNote());
  await g('cfxState').set({ agent: 'active' });
  // skipped: usage limit within 2 hours
  await fire('hourly');
  c = chatsToHelper();
  await helperSays({ type: 'chat_done', id: c[c.length - 1].id, ok: false, limit: true, error: 'Usage limit reached' });
  ok('a usage limit hit is remembered (limitHitAt)', Date.now() - local.limitHitAt < 5000, String(local.limitHitAt));
  const n2 = chatsToHelper().length;
  await fire('morning');
  ok('a run is skipped after a usage limit hit in the last 2 hours', chatsToHelper().length === n2 && /skipped: .*limit/i.test(lastNote()), lastNote());
  local.limitHitAt = Date.now() - 3 * 3600e3;
  await fire('morning');
  ok('a limit hit 3 hours ago does not skip', chatsToHelper().length === n2 + 1, String(chatsToHelper().length));
  await helperSays({ type: 'chat_done', id: chatsToHelper()[n2].id, ok: true });
  // busy: waits behind a running answer, then skipped after 30 minutes
  await A.say('keep busy');
  const busyId = chatsToHelper()[n2 + 1].id;
  const n3 = chatsToHelper().length;
  await fire('morning');
  ok('while another answer runs the scheduled run waits in the queue', chatsToHelper().length === n3 && g('chatQueue').some(q => q.msg.scheduled) && longTimers.length === 1, String(longTimers.length));
  longTimers.shift()();
  await wait(60);
  ok('after 30 minutes of waiting the run is skipped and logged', !g('chatQueue').some(q => q.msg.scheduled) && /skipped: .*30 minutes/i.test(lastNote()), lastNote());
  await fire('morning');
  await helperSays({ type: 'chat_done', id: busyId, ok: true });
  ok('a run that waits less than 30 minutes starts when the answer ends', chatsToHelper().length === n3 + 1 && chatsToHelper()[n3].scheduled === true, String(chatsToHelper().length));
  await helperSays({ type: 'chat_done', id: chatsToHelper()[n3].id, ok: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL  crashed: ' + (e && e.stack || e)); process.exit(1); });
