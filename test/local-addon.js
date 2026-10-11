'use strict';
// Local pages in the add-on background: the path rules (lib/policy.js), folder questions and grants (lib/local.js),
// the page-tool gate on file: tabs (lib/tools.js), and the helper's local_grant and local_tab messages.
// Runs the real background scripts against a mocked browser API, like army-addon.   node test/local-addon.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ext = path.join(__dirname, '..', 'extension');
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ev = () => { const fns = []; return { addListener: f => fns.push(f), removeListener: f => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); }, fns, fire: (...a) => fns.forEach(f => f(...a)) }; };

// ---- mocked browser, with spies on the calls that could move the user's focus
const store = {};
const local = {};
const F = 'file:///C:/Users/H/Downloads/';
let tabs = [
  { id: 1, windowId: 1, active: true, title: 'Shop', url: 'https://shop.example/', status: 'complete' },
  { id: 10, windowId: 1, active: false, title: 'Game', url: F + 'game/index.html', status: 'complete' },
  { id: 11, windowId: 1, active: false, title: 'Level 2', url: F + 'game/levels/two.html', status: 'complete' },
  { id: 12, windowId: 1, active: false, title: 'Other', url: F + 'other/x.html', status: 'complete' },
  { id: 13, windowId: 1, active: false, title: 'B', url: F + 'game/b%20side.html', status: 'complete' },
];
const nav = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0' };
let fileApi = true;
let scriptError = null;
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
    executeScript: async (id, o) => { if (scriptError) throw new Error(scriptError); injected.push(id); return [{ ok: true, from: id }]; },
    captureTab: (...a) => capture(...a),
    captureVisibleTab: async () => { visibleCaptures++; return 'data:image/png;base64,AAAA'; },
  }, tabEv),
  webRequest: { onBeforeRequest: ev(), onSendHeaders: ev(), onHeadersReceived: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() },
  extension: { isAllowedFileSchemeAccess: async () => fileApi },
  windows: { update: async () => { updated.push(['window']); }, onCreated: ev(), getAll: async () => [{ id: 1, type: 'normal' }] },
};
const fetch = async url => {
  if (String(url).includes('9222')) throw new Error('refused');
  return { status: 200, ok: true, json: async () => ({ account: { email_address: 'f.work@example.com', full_name: 'F', uuid: 'u-1' } }) };
};
const makeCtx = () => { const c = vm.createContext({ browser, navigator: nav, fetch, console, URL, URLSearchParams, AbortController, TextEncoder, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, Promise }); c.window = c; return c; };
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
// A worker's tool call (army set) or a native message from the helper; resolves with the add-on's answer.
async function waitSent(type, id) {
  for (let i = 0; i < 400; i++) {
    const m = native.sent.find(x => x.type === type && x.id === id);
    if (m) return m;
    await tick(10);
  }
  return { ok: false, error: 'no answer' };
}
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
const tabOf = id => tabs.find(t => t.id === id);
const ASKED = /^Claude asks to look in /;
const asks = () => g('cizState').log().filter(e => ASKED.test(e.text)).length;
const st = () => g('cizState').get();
const W = 'C:\\Users\\H\\Downloads\\';
const DENY = f => `You did not allow Claude to look in ${f}.`;
const ACCESS = "Zen keeps add-ons out of files on this computer. Turn on 'Access local files on your computer' for Claude in Zen: about:addons -> Claude in Zen -> Permissions and data.";
let nid = 0;
const nativeAsk = async (m, type) => { const id = `n${++nid}`; native.onMessage.fire(Object.assign({ id }, m)); return waitSent(type, id); };

(async () => {
  try {
    // ---- pure path rules
    const fp = u => g('cizFilePath')(u);
    check('cizFilePath: Windows drive path', fp('file:///C:/Users/H/Downloads/game/index.html') === 'C:\\Users\\H\\Downloads\\game\\index.html', fp('file:///C:/Users/H/Downloads/game/index.html'));
    check('cizFilePath: POSIX path', fp('file:///home/f/game/index.html') === '/home/f/game/index.html');
    check('cizFilePath: %20 and raw spaces decode to spaces', fp('file:///C:/My%20Games/a%20b.html') === 'C:\\My Games\\a b.html' && fp('file:///C:/My Games/a.html') === 'C:\\My Games\\a.html');
    check('cizFilePath: . and .. are resolved, also when percent-encoded, never above the drive',
      fp('file:///C:/a/b/../c.html') === 'C:\\a\\c.html' && fp('file:///C:/a/./b/%2e%2e/c.html') === 'C:\\a\\c.html' && fp('file:///C:/a/%2e%2e/%2e%2e/x') === 'C:\\x' && fp('file:///C:/a%5C..%5Cb.html') === 'C:\\b.html');
    check('cizFilePath: localhost is this computer, another host (a network share) is null',
      fp('file://localhost/home/f/x.html') === '/home/f/x.html' && fp('file://server/share/x.html') === null && fp('file:////server/share/x.html') === null);
    check('cizFilePath: NUL and non-file URLs are null', fp('file:///home/f/a%00b.html') === null && fp('https://example.com/x.html') === null && fp('about:config') === null);
    const inF = (p, f) => g('cizInFolder')(p, f);
    check('cizInFolder: drive paths ignore case and slash direction', inF('c:/users/h/downloads/game/x.html', 'C:\\Users\\H\\Downloads\\game') && inF('C:\\A\\b', 'c:/a/'));
    check('cizInFolder: a folder holds itself and its subfolders', inF('C:\\a', 'C:\\a') && inF('C:\\a\\b\\c\\d.html', 'C:\\a') && inF('/home/f/game/x', '/home/f'));
    check('cizInFolder: a sibling with the same prefix is not inside, POSIX keeps case, drives differ',
      !inF('C:\\ab\\x.html', 'C:\\a') && !inF('/home/F/x', '/home/f') && !inF('D:\\a\\x', 'C:\\a') && !inF('/a/x', 'C:\\a'));
    const nf = p => g('cizNormFolder')(p);
    check('cizNormFolder: no trailing separator, one slash style, roots kept, relative paths empty',
      nf('C:/a/b/') === 'C:\\a\\b' && nf('c:\\a\\\\b') === 'C:\\a\\b' && nf('/a//b/') === '/a/b' && nf('C:\\') === 'C:\\' && nf('/') === '/' && nf('a\\b') === '' && nf('\\\\server\\share') === '');
    check('cizFolderOf: the folder a file is in', g('cizFolderOf')('C:\\a\\b.html') === 'C:\\a' && g('cizFolderOf')('/home/f/x') === '/home/f');

    // ---- set up: signed in, helper connected
    await tick(50);
    connectEv.fire(panel);
    await fromPanel({ type: 'signIn' });
    await helperSays({ type: 'hello', version: '0.9.0', clients: [] });
    const L = g('cizLocal');
    L.ASK_MS = 5000;
    check('state starts with no grants, no question, and file access known', Array.isArray(st().localGrants) && st().localGrants.length === 0 && st().grantAsk === null && st().fileAccess === 'yes', JSON.stringify([st().localGrants, st().grantAsk, st().fileAccess]));

    // ---- ask, then Allow
    let n = injected.length;
    let p = call('read_page', { tab_id: 10 });
    await tick();
    const ask1 = st().grantAsk;
    check('a read on a file: tab outside the grants asks about the file\'s folder, and nothing runs yet',
      ask1 && ask1.folder === W + 'game' && /^g\d+$/.test(ask1.id) && injected.length === n, JSON.stringify(ask1));
    await fromPanel({ type: 'grantAnswer', id: ask1.id, allow: true });
    let r = await p;
    check('Allow lets the same call finish and remembers the folder in storage.local',
      r.ok && injected.length === n + 1 && st().grantAsk === null && JSON.stringify(local.localGrants) === JSON.stringify([W + 'game']) && st().localGrants[0] === W + 'game', JSON.stringify([r, local.localGrants]));
    let a0 = asks();
    const same = await call('read_page', { tab_id: 13 });
    const sub = await call('find', { tab_id: 11, query: 'start' });
    check('another file in that folder, and one in a subfolder, ask nothing', same.ok && sub.ok && asks() === a0 && st().grantAsk === null, `${same.error || ''} ${sub.error || ''}`);

    // ---- a sibling folder asks; Deny
    p = call('get_page_text', { tab_id: 12 });
    await tick();
    const ask2 = st().grantAsk;
    check('a sibling folder asks', ask2 && ask2.folder === W + 'other' && asks() === a0 + 1, JSON.stringify(ask2));
    await fromPanel({ type: 'grantAnswer', id: ask2.id, allow: false });
    r = await p;
    check('Deny gives the Deny message and stores nothing', !r.ok && r.error === DENY(W + 'other') && local.localGrants.length === 1 && st().grantAsk === null, r.error);

    // ---- no answer in time
    L.ASK_MS = 120;
    r = await call('read_page', { tab_id: 12 });
    L.ASK_MS = 5000;
    check('no answer within ASK_MS gives the no-answer message and clears the question',
      !r.ok && r.error === `No answer about ${W}other, so Claude did not look.` && st().grantAsk === null, r.error);

    // ---- two calls for one folder make one ask
    a0 = asks();
    const p1 = call('read_page', { tab_id: 12 }), p2 = call('scroll', { tab_id: 12 });
    const e1 = L.ensure(W + 'other\\deeper\\..');
    await tick();
    const ask3 = st().grantAsk;
    check('two calls (and an ensure) for one folder make one question', asks() === a0 + 1 && L._asks.length === 1 && ask3.folder === W + 'other');
    await fromPanel({ type: 'grantAnswer', id: ask3.id, allow: true });
    const [r1, r2, en] = await Promise.all([p1, p2, e1]);
    check('one Allow answers them all', r1.ok && r2.ok && en === true && local.localGrants.length === 2, `${r1.error || ''} ${r2.error || ''}`);

    // ---- localGrantRemove
    await fromPanel({ type: 'localGrantRemove', folder: 'c:/users/h/downloads/other/' });
    check('localGrantRemove removes the folder and stores the list', JSON.stringify(st().localGrants) === JSON.stringify([W + 'game']) && JSON.stringify(local.localGrants) === JSON.stringify([W + 'game']), JSON.stringify(local.localGrants));

    // ---- one question at a time, the rest queue
    const q1 = L.ask('D:\\one'), q2 = L.ask('D:\\two');
    await tick();
    const shown1 = st().grantAsk;
    await fromPanel({ type: 'grantAnswer', id: shown1.id, allow: false });
    const shown2 = st().grantAsk;
    await fromPanel({ type: 'grantAnswer', id: shown2.id, allow: false });
    check('one question shows at a time; the next shows when it is answered', shown1.folder === 'D:\\one' && shown2.folder === 'D:\\two' && !(await q1).ok && !(await q2).ok && st().grantAsk === null);

    // ---- Stop while asking
    p = call('read_page', { tab_id: 12 });
    const e2 = L.ensure(W + 'other');
    await tick();
    const hadAsk = !!st().grantAsk;
    await fromPanel({ type: 'stop' });
    r = await p;
    check('Stop while asking counts as no and clears the question', hadAsk && (await e2) === false && st().grantAsk === null && L._asks.length === 0 && !r.ok, r.error);
    await fromPanel({ type: 'start' });
    await helperSays({ type: 'hello', version: '0.9.0', clients: [] });

    // ---- army workers never touch local pages
    const A = (await armyCall('tab_open', { url: 'https://a.example/' })).result.tab_id;
    tabOf(A).url = F + 'other/x.html';
    n = injected.length; a0 = asks();
    const ar = await armyCall('read_page', { tab_id: A });
    tabOf(A).url = F + 'game/index.html';
    const ag = await armyCall('screenshot', { tab_id: A });
    check('an army call on a file: tab is refused without a question, even inside a granted folder',
      !ar.ok && /only work on web pages/.test(ar.error) && !ag.ok && /only work on web pages/.test(ag.error) && asks() === a0 && st().grantAsk === null && injected.length === n, `${ar.error} | ${ag.error}`);
    await helperSays({ type: 'army_end', run: 'r1' });

    // ---- Zen's file access switch
    fileApi = false;
    a0 = asks();
    r = await call('read_page', { tab_id: 12 });
    const rg = await call('read_page', { tab_id: 10 });
    check('Gecko 153 with the API false: file access is no, the file-access message, no question',
      !r.ok && r.error === ACCESS && !rg.ok && rg.error === ACCESS && asks() === a0 && st().fileAccess === 'no', r.error);
    nav.userAgent = 'Mozilla/5.0 (Windows NT 10.0; rv:150.0) Gecko/20100101 Firefox/150.0';
    r = await call('read_page', { tab_id: 10 });
    check('Gecko 150 with the API false: file access counts as yes', r.ok && st().fileAccess === 'yes', r.error);
    fileApi = true;
    nav.userAgent = 'Mozilla/5.0 (Windows NT 10.0; rv:153.0) Gecko/20100101 Firefox/153.0';
    scriptError = 'Missing host permission for the tab';
    r = await call('read_page', { tab_id: 10 });
    scriptError = null;
    check('a permission error from executeScript on a file: tab gives the file-access message', !r.ok && r.error === ACCESS, r.error);

    // ---- every page tool on a granted tab, and screenshot
    const tools = [['read_page'], ['find', { query: 'x' }], ['get_page_text'], ['click', { selector: '#go' }], ['fill', { selector: '#q', value: 'a' }],
      ['type_text', { text: 'a' }], ['press_key', { key: 'ArrowUp' }], ['scroll'], ['hover', { selector: '#go' }], ['wait_for', { text: 'x', timeout_ms: 500 }], ['screenshot']];
    const bad = [];
    for (const [t, extra] of tools) { const x = await call(t, Object.assign({ tab_id: 11 }, extra || {})); if (!x.ok) bad.push(`${t}: ${x.error}`); }
    check('a granted file: tab works for every page tool, screenshot included', bad.length === 0, bad.join(' | '));
    a0 = asks();
    L.ASK_MS = 120;
    r = await call('wait_for', { tab_id: 12, text: 'x', timeout_ms: 5000 });
    L.ASK_MS = 5000;
    check('wait_for on a file: tab outside the grants stops at the first no-answer, it does not ask again', !r.ok && /No answer about/.test(r.error) && asks() === a0 + 1, r.error);

    // ---- navigate and tab_open keep refusing file: URLs
    const nv = await call('navigate', { tab_id: 1, url: F + 'game/index.html' });
    const to = await call('tab_open', { url: F + 'game/index.html' });
    check('navigate and tab_open to a file: URL are refused, pointing to local_page_open',
      !nv.ok && /off-limits to tab_open and navigate.*local_page_open/.test(nv.error) && !to.ok && /off-limits/.test(to.error) && tabOf(1).url === 'https://shop.example/', `${nv.error} | ${to.error}`);

    // ---- the helper's local_grant
    let m = await nativeAsk({ type: 'local_grant', path: W + 'game\\levels\\two.html', kind: 'file' }, 'local_grant_result');
    check('local_grant kind file inside a grant answers ok at once with the file\'s folder', m.ok === true && m.folder === W + 'game\\levels' && !m.error, JSON.stringify(m));
    const pd = nativeAsk({ type: 'local_grant', path: 'C:\\Users\\H\\Desktop\\new\\', kind: 'dir' }, 'local_grant_result');
    await tick();
    const ask4 = st().grantAsk;
    await fromPanel({ type: 'grantAnswer', id: ask4.id, allow: true });
    m = await pd;
    check('local_grant kind dir asks about that folder itself and answers ok after Allow', ask4.folder === 'C:\\Users\\H\\Desktop\\new' && m.ok === true && m.folder === 'C:\\Users\\H\\Desktop\\new', JSON.stringify(m));
    const pn = nativeAsk({ type: 'local_grant', path: '/home/f/secret.txt', kind: 'file' }, 'local_grant_result');
    await tick();
    await fromPanel({ type: 'grantAnswer', id: st().grantAsk.id, allow: false });
    m = await pn;
    check('local_grant answers not ok after Deny, with the Deny message', m.ok === false && m.folder === '/home/f' && m.error === DENY('/home/f'), JSON.stringify(m));

    // ---- the helper's local_tab
    tabs.push({ id: 30, windowId: 1, active: true, title: 'Loading', url: 'file:///c:/Users/H/Downloads/new%20game/index.html', status: 'loading' });
    setTimeout(() => { const t = tabOf(30); t.status = 'complete'; t.title = 'New Game'; }, 300);
    m = await nativeAsk({ type: 'local_tab', url: 'file:///C:/Users/H/Downloads/new game/index.html' }, 'local_tab_result');
    check('local_tab finds the tab by its decoded path (drive letter case aside) once it has loaded', m.ok === true && m.tab_id === 30 && m.title === 'New Game', JSON.stringify(m));
    L.TAB_MS = 300;
    const t0 = Date.now();
    m = await nativeAsk({ type: 'local_tab', url: 'file:///C:/nowhere/x.html' }, 'local_tab_result');
    check('local_tab answers not ok when no tab shows the file within TAB_MS', m.ok === false && m.tab_id === null && /No Zen tab showed C:\\nowhere\\x\.html/.test(m.error) && Date.now() - t0 >= 280, JSON.stringify(m));

    // ---- a fresh start reads the grants back (last: the second copy shares the mocked browser)
    const ctx2 = makeCtx();
    for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx2, { filename: f });
    await tick(80);
    const s2 = vm.runInContext('cizState', ctx2).get();
    check('a fresh start loads the allowed folders from storage.local', JSON.stringify(s2.localGrants) === JSON.stringify([W + 'game', 'C:\\Users\\H\\Desktop\\new']) && s2.grantAsk === null && s2.fileAccess === 'yes', JSON.stringify(s2.localGrants));
  } catch (e) {
    check('no unexpected errors', false, e.stack);
  } finally {
    const failed = results.filter(r => !r).length;
    console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed, 0 failed`);
    process.exit(failed ? 1 : 0);
  }
})();
