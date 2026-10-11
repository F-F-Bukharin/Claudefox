'use strict';
// The army in the add-on background: the worker tab registry and guard (lib/army.js), focus protection, the
// army switch and run counter, and screenshots that never switch tabs. Runs the real background scripts against a
// mocked browser API, like addon-smoke.   node test/army-addon.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ext = path.join(__dirname, '..', 'extension');
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ev = () => { const fns = []; return { addListener: f => fns.push(f), removeListener: f => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); }, fns, fire: (...a) => fns.forEach(f => f(...a)) }; };

// ---- mocked browser, with spies on the calls that could move the user's focus
const store = {};
const local = {};
let tabs = [
  { id: 1, windowId: 1, active: true, title: 'Shop', url: 'https://shop.example/', status: 'complete' },
  { id: 2, windowId: 1, active: false, title: 'News', url: 'https://news.example/', status: 'complete' },
];
let nextTab = 100;
const created = [], updated = [], removed = [], injected = [];
let visibleCaptures = 0;
let capture = async () => 'data:image/png;base64,AAAA';
let native = null;
const connectEv = ev();
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
  tabs: Object.assign({
    query: async q => tabs.filter(t => (!q.active || t.active)),
    get: async id => { const t = tabs.find(x => x.id === id); if (!t) throw new Error('no tab'); return t; },
    create: async o => {
      created.push(o);
      const t = { id: nextTab++, windowId: 1, active: o.active !== false, url: o.url, title: '', status: 'complete' };
      tabs.push(t);
      tabEv.onCreated.fire(Object.assign({}, t));
      return t;
    },
    update: async (id, o) => { updated.push([id, o]); return Object.assign(tabs.find(t => t.id === id) || {}, o); },
    remove: async ids => {
      for (const id of [].concat(ids)) { removed.push(id); tabs = tabs.filter(t => t.id !== id); tabEv.onRemoved.fire(id, {}); }
    },
    executeScript: async (id, o) => { injected.push(id); return [{ ok: true, from: id }]; },
    captureTab: (...a) => capture(...a),
    captureVisibleTab: async () => { visibleCaptures++; return 'data:image/png;base64,AAAA'; },
  }, tabEv),
  webRequest: { onBeforeRequest: ev(), onSendHeaders: ev(), onHeadersReceived: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() },
  windows: { update: async () => { updated.push(['window']); }, onCreated: ev(), getAll: async () => [{ id: 1, type: 'normal' }] },
};
const fetch = async url => {
  if (String(url).includes('9222')) throw new Error('refused');
  return { status: 200, ok: true, json: async () => ({ account: { email_address: 'f.work@example.com', full_name: 'F', uuid: 'u-1' } }) };
};
const makeCtx = () => { const c = vm.createContext({ browser, fetch, console, URL, URLSearchParams, AbortController, TextEncoder, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, Promise }); c.window = c; return c; };
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')).background.scripts;   // the real load order
const ctx = makeCtx();
for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx, { filename: f });

// ---- fake panel and helper
const panelIn = [];
const panelOnMsg = ev();
const panel = { name: 'panel', onMessage: panelOnMsg, onDisconnect: ev(), postMessage: m => panelIn.push(m) };
const fromPanel = async m => { panelOnMsg.fire(m); await tick(); };
const helperSays = async m => { native.onMessage.fire(m); await tick(); };
const g = name => vm.runInContext(name, ctx);
const call = (tool, args) => ctx.cizDebug.call(tool, args || {});
let seq = 0;
// A worker's tool call from the helper; resolves with the result the add-on sends back.
async function armyCall(tool, args, worker = 'w1', run = 'r1') {
  const id = `c${++seq}`;
  native.onMessage.fire({ type: 'call', id, tool, args: args || {}, source: `Army worker ${worker}`, army: { run, worker } });
  for (let i = 0; i < 300; i++) {
    const m = native.sent.find(x => x.type === 'result' && x.id === id);
    if (m) return m;
    await tick(10);
  }
  return { ok: false, error: 'no result' };
}
const day = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tabOf = id => tabs.find(t => t.id === id);

(async () => {
  try {
    await tick(50);
    connectEv.fire(panel);
    await fromPanel({ type: 'signIn' });
    await helperSays({ type: 'hello', version: '0.9.0', clients: [] });
    await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'f.work@example.com' });
    const army = g('cizArmy');

    // 1. tools a worker may not use
    let n = injected.length;
    const r1 = [await armyCall('tabs_list'), await armyCall('tab_activate', { tab_id: 1 }), await armyCall('create_file', { name: 'x.txt', content: 'x' })];
    check('an army call with tabs_list, tab_activate or create_file is refused and nothing runs',
      r1.every(r => !r.ok && /Army workers can't use/.test(r.error)) && updated.length === 0 && injected.length === n && !g('cizState').log().some(e => /Claude made/.test(e.text)), r1.map(r => r.error).join(' | '));

    // 2. tab_open: always in the background, registered to the worker
    let r = await armyCall('tab_open', { url: 'https://a.example/', active: true });
    const A = r.ok && r.result.tab_id;
    check('army tab_open opens the tab in the background even when asked for the front, and registers it to that worker',
      r.ok && created[created.length - 1].active === false && tabOf(A).active === false && army.owner(A) && army.owner(A).worker === 'w1' && army.owner(A).run === 'r1', JSON.stringify(created[created.length - 1]));
    r = await armyCall('tab_open', { url: 'https://b.example/' }, 'w2');
    const B = r.ok && r.result.tab_id;

    // 3. whose tab
    n = injected.length;
    const onUser = await armyCall('read_page', { tab_id: 1 });
    const onOther = await armyCall('read_page', { tab_id: B });
    const onOwn = await armyCall('read_page', { tab_id: A });
    check('an army call on the user\'s tab or another worker\'s tab is refused; on its own tab it runs',
      !onUser.ok && /Tab 1 is not this worker's tab/.test(onUser.error) && !onOther.ok && /not this worker's tab/.test(onOther.error)
      && onOwn.ok && injected.length === n + 1 && injected[injected.length - 1] === A, `${onUser.error} | ${onOther.error} | ${onOwn.error || 'ok'}`);

    // 4. a tab must be named
    r = await armyCall('read_page', {});
    check('an army call without tab_id is refused', !r.ok && /Army calls must name their tab/.test(r.error), r.error);

    // 5. web pages only, Google sign-in hands-off even in Unsafe mode
    await fromPanel({ type: 'setUnsafe', value: true });
    tabOf(A).url = 'https://accounts.google.com/signin/v2';
    n = injected.length;
    const onGoogle = await armyCall('read_page', { tab_id: A });
    const toGoogle = await armyCall('tab_open', { url: 'https://accounts.google.com/ServiceLogin' });
    const normal = await call('read_page', { tab_id: A });   // the lead itself, in Unsafe mode, still may
    tabOf(A).url = 'file:///C:/Users/F/notes.txt';
    const onFile = await armyCall('get_page_text', { tab_id: A });
    tabOf(A).url = 'about:config';
    const onAbout = await armyCall('read_page', { tab_id: A });
    const shotAbout = await armyCall('screenshot', { tab_id: A });
    check('an army call on a Google sign-in tab is refused even with Unsafe mode on', g('cizState').get().unsafe && !onGoogle.ok && /Google sign-in/.test(onGoogle.error)
      && !toGoogle.ok && /Google sign-in/.test(toGoogle.error) && normal.ok && injected.length === n + 1, `${onGoogle.error} | ${toGoogle.error}`);
    check('an army call on a file: or about: tab is refused: army workers only work on web pages',
      [onFile, onAbout, shotAbout].every(x => !x.ok && /only work on web pages/.test(x.error)) && injected.length === n + 1, `${onFile.error} | ${onAbout.error} | ${shotAbout.error}`);
    await fromPanel({ type: 'setUnsafe', value: false });
    tabOf(A).url = 'https://a.example/';

    // 6. a tab the worker's page opens, in front: it joins the worker, and the user's tab comes back
    let u = updated.length;
    tabs.push({ id: 50, windowId: 1, active: true, url: 'https://a.example/popup', status: 'complete' });
    tabEv.onCreated.fire({ id: 50, windowId: 1, active: true, openerTabId: A, url: 'https://a.example/popup' });
    await tick();
    check('a tab opened from an army tab joins that worker, and the user\'s tab is put back in front',
      army.owner(50) && army.owner(50).worker === 'w1' && updated.slice(u).some(([id, o]) => id === 1 && o && o.active === true), JSON.stringify(updated.slice(u)));

    // 6b. a worker has 4 tabs at most: one more that its page opens is closed at once
    for (const id of [401, 402]) army.register(id, { run: 'r1', worker: 'w1' });   // w1 now has A, 50, 401 and 402
    tabs.push({ id: 51, windowId: 1, active: false, url: 'https://a.example/pop2', status: 'complete' });
    tabEv.onCreated.fire({ id: 51, windowId: 1, active: false, openerTabId: A, url: 'https://a.example/pop2' });
    await tick();
    check('a fifth tab a worker\'s page opens is closed at once and is not the worker\'s', removed.includes(51) && !army.owner(51), removed.join(','));
    for (const id of [401, 402]) army.unregister(id);

    // 7. an army tab that comes to the front right after an army action goes back; one the user clicks later stays
    await armyCall('scroll', { tab_id: A, direction: 'down' });
    u = updated.length;
    tabEv.onActivated.fire({ tabId: A, windowId: 1 });
    await tick();
    const restored = updated.slice(u).some(([id, o]) => id === 1 && o.active === true);
    army.tabs.get(A).at -= 10000;
    u = updated.length;
    tabEv.onActivated.fire({ tabId: A, windowId: 1 });
    await tick();
    check('an army tab activated right after an army action puts the user\'s tab back; with no recent action it stays', restored && updated.length === u);
    tabEv.onActivated.fire({ tabId: 2, windowId: 1 });   // the user moves to another of their tabs
    check('the user\'s own tab is remembered as theirs', army.userTab && army.userTab.tabId === 2);
    tabEv.onActivated.fire({ tabId: 1, windowId: 1 });

    // 7b. Show on a worker's row in the panel: the user's own switch, which the army leaves alone
    await armyCall('scroll', { tab_id: A, direction: 'down' });   // the worker acted on it just now
    u = updated.length;
    await fromPanel({ type: 'openTab', id: A });
    tabEv.onActivated.fire({ tabId: A, windowId: 1 });
    await tick();
    check('Show switches to the worker\'s tab and the army does not switch back', updated.slice(u).some(([id, o]) => id === A && o && o.active === true)
      && !updated.slice(u).some(([id, o]) => id === 1 && o && o.active === true), JSON.stringify(updated.slice(u)));
    tabEv.onActivated.fire({ tabId: 1, windowId: 1 });

    // 14. tabs_list marks army tabs
    r = await call('tabs_list');
    check('tabs_list marks army tabs with their worker id', r.ok && r.result.find(t => t.id === A).army === 'w1' && r.result.find(t => t.id === B).army === 'w2' && !('army' in r.result.find(t => t.id === 1)));

    // 10. screenshots never switch tabs
    capture = async () => { throw new Error('Tab is not drawn.'); };
    u = updated.length;
    const shot = await call('screenshot', { tab_id: 2 });
    const shotArmy = await armyCall('screenshot', { tab_id: A });
    check('a screenshot that cannot be captured fails with the tab_activate hint, and no tab is switched',
      !shot.ok && /Could not capture tab 2: Tab is not drawn\. Zen draws a tab only while it is in front.*tab_activate/.test(shot.error) && updated.length === u && visibleCaptures === 0, shot.error);
    check('the same for an army worker\'s screenshot, pointing it to get_page_text (workers cannot bring a tab to the front)',
      !shotArmy.ok && /get_page_text/.test(shotArmy.error) && !/tab_activate/.test(shotArmy.error) && updated.length === u && visibleCaptures === 0, shotArmy.error);
    capture = async () => undefined;
    const blank = await call('screenshot', { tab_id: 2 });
    check('a capture with no image fails the same way', !blank.ok && /Could not capture tab 2: .*tab_activate/.test(blank.error) && updated.length === u && visibleCaptures === 0, blank.error);
    capture = async () => 'data:image/png;base64,AAAA';
    r = await armyCall('screenshot', { tab_id: A });
    check('an army worker can take a screenshot of its own tab', r.ok && r.result.data === 'AAAA', r.error);

    // 8. army_end closes the worker's tabs, then the run's
    r = await armyCall('tab_open', { url: 'https://a2.example/' });
    const A2 = r.result.tab_id;
    let rm = removed.length;
    await helperSays({ type: 'army_end', run: 'r1', worker: 'w1' });
    const gone = removed.slice(rm);
    check('army_end with a worker closes only that worker\'s tabs', [A, A2, 50].every(id => gone.includes(id)) && !gone.includes(B) && !gone.includes(1) && !army.owner(A) && army.owner(B), gone.join(','));
    rm = removed.length;
    await helperSays({ type: 'army_end', run: 'r1' });
    check('army_end with only the run closes the rest of the run', removed.slice(rm).join() === String(B) && army.tabs.size === 0, removed.slice(rm).join(','));

    // 8b. a tab still opening when its run or worker ended: closed as soon as it is there
    await helperSays({ type: 'army_end', run: 'r7' });
    rm = removed.length;
    const late = await armyCall('tab_open', { url: 'https://late.example/' }, 'w1', 'r7');
    await helperSays({ type: 'army_end', run: 'r6', worker: 'w2' });
    const late2 = await armyCall('tab_open', { url: 'https://late2.example/' }, 'w2', 'r6');
    const lateIds = removed.slice(rm);
    check('a tab of a run or worker that already ended is closed as soon as it opens', [late, late2].every(x => !x.ok && x.error === 'This worker was stopped, so its new tab was closed.')
      && lateIds.length === 2 && lateIds.every(id => !army.owner(id) && !tabOf(id)), JSON.stringify([late, late2, lateIds]));

    // 9. Stop and a helper that goes away close every army tab
    const s1 = (await armyCall('tab_open', { url: 'https://s1.example/' }, 'w1', 'r2')).result.tab_id;
    const s2 = (await armyCall('tab_open', { url: 'https://s2.example/' }, 'w3', 'r2')).result.tab_id;
    rm = removed.length;
    await fromPanel({ type: 'stop' });
    check('Stop closes every army tab', [s1, s2].every(id => removed.slice(rm).includes(id)) && !removed.slice(rm).includes(1) && army.tabs.size === 0);
    army.register(777, { run: 'r5', worker: 'w1' }, army.stopAt - 1);   // a tab_open that was under way when Stop came
    await tick();
    check('a tab that started opening before Stop is closed when it arrives', removed.includes(777) && !army.owner(777));
    await fromPanel({ type: 'start' });
    await helperSays({ type: 'hello', version: '0.9.0', clients: [] });
    const s3 = (await armyCall('tab_open', { url: 'https://s3.example/' }, 'w1', 'r3')).result.tab_id;
    rm = removed.length;
    native.onDisconnect.fire({ error: null });
    await tick();
    check('the helper going away closes every army tab', removed.slice(rm).includes(s3) && army.tabs.size === 0);
    await fromPanel({ type: 'retryNative' });
    await helperSays({ type: 'hello', version: '0.9.0', clients: [] });
    await helperSays({ type: 'claude_status', installed: true, loggedIn: true, email: 'f.work@example.com' });

    // 11. the army switch
    await fromPanel({ type: 'setArmy', value: true });
    let s = g('cizState').get();
    check('setArmy true turns the army on, picks Quality and is remembered', s.chatArmy === true && s.chatModel === 'quality' && local.armyOn === true);
    await fromPanel({ type: 'chat', id: 'a1', text: 'compare three shops' });
    const sentArmy = native.sent.find(m => m.type === 'chat' && m.id === 'a1');
    check('the next chat goes to the helper with model army', sentArmy && sentArmy.model === 'army' && g('cizState').log().some(e => /army \(Opus 5\.5 at max effort, with Haiku workers\)/.test(e.text)), sentArmy && sentArmy.model);

    // 13. the run counter
    await helperSays({ type: 'chat_event', id: 'a1', event: { kind: 'army', run: 'r9', round: 1, started: true, finished: false, workers: [] } });
    const first = panelIn.filter(m => m.type === 'chatEvent' && m.id === 'a1' && m.event.kind === 'army').pop();
    check('an army run that starts is counted and reaches the panel with today', first && first.event.today === 1 && g('cizState').get().armyToday === 1
      && local.armyRuns.day === day() && local.armyRuns.count === 1, JSON.stringify(first && first.event));
    await helperSays({ type: 'chat_event', id: 'a1', event: { kind: 'army', run: 'r9', round: 1, started: false, finished: true, workers: [] } });
    const later = panelIn.filter(m => m.type === 'chatEvent' && m.id === 'a1' && m.event.kind === 'army').pop();
    check('later army events reach the panel as they are, not counted', later.event.finished === true && !('today' in later.event) && g('cizState').get().armyToday === 1);
    local.armyRuns = { day: '2000-01-01', count: 4 };
    await helperSays({ type: 'chat_event', id: 'a1', event: { kind: 'army', run: 'r10', round: 1, started: true, finished: false, workers: [] } });
    const fresh = panelIn.filter(m => m.type === 'chatEvent' && m.id === 'a1' && m.event.kind === 'army').pop();
    check('a count from an earlier day starts over at 1', fresh.event.today === 1 && g('cizState').get().armyToday === 1 && local.armyRuns.day === day() && local.armyRuns.count === 1);
    await helperSays({ type: 'chat_done', id: 'a1', ok: true });
    await fromPanel({ type: 'setArmy', value: false });
    await fromPanel({ type: 'chat', id: 'a2', text: 'just one' });
    s = g('cizState').get();
    check('after setArmy false the chat is plain Quality', !s.chatArmy && local.armyOn === false && native.sent.find(m => m.type === 'chat' && m.id === 'a2').model === 'quality');
    await helperSays({ type: 'chat_done', id: 'a2', ok: true });

    // 12. a fresh start remembers the switch and today's count (last: the second copy shares the mocked browser)
    local.armyOn = true;
    local.armyRuns = { day: day(), count: 3 };
    const ctx2 = makeCtx();
    for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx2, { filename: f });
    await tick(80);
    const s2s = vm.runInContext('cizState', ctx2).get();
    check('a fresh start with armyOn comes up with the army on and Quality, and today\'s count', s2s.chatArmy === true && s2s.chatModel === 'quality' && s2s.armyToday === 3, JSON.stringify({ a: s2s.chatArmy, m: s2s.chatModel, t: s2s.armyToday }));

    // 16. static: nothing a worker can reach brings a tab or a window to the front
    const toolsSrc = fs.readFileSync(path.join(ext, 'lib', 'tools.js'), 'utf8');
    const armySrc = fs.readFileSync(path.join(ext, 'lib', 'army.js'), 'utf8');
    const armyTools = [...g('CIZ_ARMY_TOOLS')];
    const bodies = {};
    for (const part of toolsSrc.split(/^  async (?=\w+\(args)/m).slice(1)) bodies[part.slice(0, part.indexOf('('))] = part;
    const focusing = /tabs\.update\([^)]*active|windows\.update|captureVisibleTab|tabs\.highlight/;
    const bad = armyTools.filter(t => !bodies[t] || focusing.test(bodies[t]));
    check('static: no tool a worker may use switches tabs or windows (and each one is found)', !bad.length && !armyTools.includes('tab_activate'), bad.join(','));
    check('static: no captureVisibleTab anywhere in the tools; army.js changes the active tab only in _restore',
      !/captureVisibleTab/.test(toolsSrc) && (armySrc.match(/tabs\.update\(/g) || []).length === 1 && /_restore\(windowId\) \{[\s\S]*?tabs\.update\(u\.tabId/.test(armySrc) && !/windows\.update/.test(armySrc));

    // 15. the shared scripts still pass the main smoke test
    const smoke = spawnSync(process.execPath, [path.join(__dirname, 'addon-smoke.js')], { encoding: 'utf8', timeout: 120000 });
    const lastLine = String(smoke.stdout || '').trim().split('\n').pop();
    check('test/addon-smoke.js still passes', smoke.status === 0, lastLine);
  } catch (e) {
    check('no unexpected errors', false, e.stack);
  } finally {
    const failed = results.filter(r => !r).length;
    console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed, 0 failed`);
    process.exit(failed ? 1 : 0);
  }
})();
