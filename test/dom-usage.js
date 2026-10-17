'use strict';
// Wave 4 panel parts (C1, C11, C17): the done line with tokens and cost, the army card's tokens and the Max effort switch,
// and tool results matched to their step by id. The real panel.html/panel.js in jsdom: needs jsdom (npm i --no-save jsdom,
// or NODE_PATH pointing at one); skipped without it. The add-on part (Max effort, army tokens, the network log) needs no jsdom.
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { JSDOM = null; }
const fs = require('fs');
const dir = require('path').join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(dir);
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
async function panelChecks() {
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window; const sent = []; const local = {}; let onMsg;
w.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => onMsg = f } }), getManifest: () => ({ version: '0.4.0' }) },
  storage: { session: { get: async () => ({}), set: async () => {} },
    local: { get: async k => (k in local ? { [k]: local[k] } : {}), set: async o => { Object.assign(local, o); } } },
  tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } } };
w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;'); w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8')); evalPanel(dom, dir, panelFiles);
const $ = id => w.document.getElementById(id);
const base = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected', hostVersion: '0.4.0', claude: { installed: true, loggedIn: true, email: 'f.work@example.com', plan: 'pro' }, pending: 0, chatModel: 'speed', chatArmy: false, filesMode: 'read', filesFolder: '' };
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const lastMsg = () => [...$('messages').querySelectorAll('.msg.assistant')].pop();
const doneText = () => lastMsg().querySelector('.donebar span:not(.dmark)')?.textContent || '';
// One chat turn: the state, a send, the helper's events, then the end of the turn.
async function turn(state, events) {
  onMsg({ type: 'state', state: { ...base, ...state }, log: [] });
  $('input').value = 'hi'; $('composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
  const id = sent.filter(m => m.type === 'chat').pop().id;
  for (const event of events) onMsg({ type: 'chatEvent', id, event });
  onMsg({ type: 'chatDone', id, ok: true });
  await tick();
  return id;
}
// The step states of the last answer, its action list opened.
function stepStates() {
  lastMsg().querySelector('.dsteps').click();
  return [...lastMsg().querySelectorAll('.actlist li')].map(li => li.className).join(',');
}
  await tick(50);
  // C11: the done line, each part left out when there is no data for it
  await turn({}, [{ kind: 'stats', ms: 12300, turns: 3, tokensIn: 48000, tokensCached: 40000, tokensOut: 1200, costUsd: 0.18 }]);
  ok('done line: time, tokens with cached, out, and the API cost', doneText() === 'Done in 12.3 s · 48k in (40k cached) · 1.2k out · ≈ $0.18 at API prices', doneText());
  await turn({}, [{ kind: 'stats', ms: 4200, turns: 1 }]);
  ok('done line: no tokens, no cost: the time only, as before', doneText() === 'Done in 4.2 s', doneText());
  await turn({}, [{ kind: 'stats', ms: 12300, turns: 1, tokensIn: 48000, tokensCached: 0, tokensOut: 1200 }]);
  ok('done line: no cached part when tokensCached is 0, no cost part without costUsd', doneText() === 'Done in 12.3 s · 48k in · 1.2k out', doneText());
  await turn({}, [{ kind: 'stats', ms: 4200, turns: 1, costUsd: 0.5 }]);
  ok('done line: a cost alone, two decimals', doneText() === 'Done in 4.2 s · ≈ $0.50 at API prices', doneText());
  const fmt = [];
  for (const [n, shown] of [[999, '999'], [1000, '1.0k'], [1200, '1.2k'], [48000, '48k'], [1200000, '1.2M'], [999500, '1.0M']]) {
    await turn({}, [{ kind: 'stats', ms: 4200, turns: 1, tokensIn: n }]);
    fmt.push(doneText() === `Done in 4.2 s · ${shown} in` ? 'ok' : `${n}->${doneText()}`);
  }
  ok('number format: 999, 1.0k, 1.2k, 48k, 1.2M, and 999,500 as 1.0M', fmt.every(x => x === 'ok'), fmt.join(' | '));
  // C11: the army card's line, with today's tokens when there are some
  onMsg({ type: 'state', state: { ...base, chatModel: 'quality', chatArmy: true, armyToday: 2, armyTokensToday: 310000 }, log: [] });
  ok('army card: runs and tokens today', $('armyRuns').textContent === 'Runs today: 2 of 5 recommended · 310k tokens', $('armyRuns').textContent);
  onMsg({ type: 'state', state: { ...base, chatModel: 'quality', chatArmy: true, armyToday: 2, armyTokensToday: 0 }, log: [] });
  ok('army card: no tokens part at 0, the line as before', $('armyRuns').textContent === 'Runs today: 2 of 5 recommended.', $('armyRuns').textContent);
  // C1: the Max effort switch is saved in storage.local
  $('armyMax')?.click();
  await tick(10);
  ok('Max effort: switching it on saves armyMax', local.armyMax === true && $('armyMax')?.checked === true);
  $('armyMax')?.click();
  await tick(10);
  ok('Max effort: switching it off saves armyMax false', local.armyMax === false);
  // C17: a tool result finds the step with its id, even when a later step is running. An error marks the step it
  // reached (the turn's end marks the rest ok), so the step states show which step got the result.
  await turn({}, [
    { kind: 'tool', id: 'a', name: 'tabs_list', input: '{}' },
    { kind: 'tool', id: 'b', name: 'page_read', input: '{}' },
    { kind: 'tool_result', id: 'b', error: true, text: 'B failed' },
  ]);
  ok('tool ids: the result for b marks b, and a (started first) stays ok', stepStates() === 'ok,bad', stepStates());
  // C17: without an id, the first running step, as before
  await turn({}, [
    { kind: 'tool', name: 'tabs_list', input: '{}' },
    { kind: 'tool', name: 'page_read', input: '{}' },
    { kind: 'tool_result', error: true, text: 'A failed' },
  ]);
  ok('tool ids: no id on the result, the first running step gets it', stepStates() === 'bad,ok', stepStates());
  // C17: an id no step has falls back to the first running step
  await turn({}, [
    { kind: 'tool', id: 'a', name: 'tabs_list', input: '{}' },
    { kind: 'tool_result', id: 'zz', error: true, text: 'A failed' },
  ]);
  ok('tool ids: an unknown id falls back to the first running step', stepStates() === 'bad', stepStates());
}

// ---------------------------------------------------------------- the add-on (no jsdom needed)
// The background scripts run as test/site-wiring.js runs them: the real files, in manifest order, against a mocked browser.
const vm = require('vm');
const ext = require('path').join(__dirname, '..', 'extension');
const manifest = JSON.parse(fs.readFileSync(require('path').join(ext, 'manifest.json'), 'utf8'));
const WR = ['onBeforeRequest', 'onSendHeaders', 'onHeadersReceived', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'];
const listeners = () => { const fns = []; return { fns, addListener: f => fns.push(f), removeListener: f => { const i = fns.indexOf(f); if (i >= 0) fns.splice(i, 1); } }; };
const copy = v => JSON.parse(JSON.stringify(v));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Boots the add-on. session: storage.session at startup (the state); local: storage.local, which the checks read and write.
async function boot(session = {}, local = {}) {
  const store = copy(session);
  const b = {
    storage: {
      local: { get: async k => (k in local ? { [k]: copy(local[k]) } : {}), set: async o => { for (const k in o) local[k] = copy(o[k]); }, remove: async k => { delete local[k]; } },
      session: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, copy(store[k])])), set: async o => { for (const k in o) store[k] = copy(o[k]); } },
    },
    extension: { isAllowedFileSchemeAccess: async () => true },
    runtime: { onConnect: listeners(), onMessage: listeners(), getManifest: () => copy(manifest), connectNative: () => (b.port = { sent: [], onMessage: listeners(), onDisconnect: listeners(), postMessage(m) { this.sent.push(m); }, disconnect() {} }) },
    browserAction: { onClicked: listeners(), setBadgeText() {}, setBadgeBackgroundColor() {} },
    sidebarAction: { toggle: async () => {}, open: async () => {} },
    tabs: { query: async () => [], get: async () => ({}), executeScript: async () => [{ ok: true }], onActivated: listeners(), onUpdated: listeners(), onCreated: listeners(), onRemoved: listeners() },
    webRequest: Object.fromEntries(WR.map(n => [n, listeners()])),
    windows: { update: async () => {}, onCreated: listeners(), getAll: async () => [{ id: 1, type: 'normal' }] },
  };
  const ctx = vm.createContext({ browser: b, console, URL, URLSearchParams, AbortController, TextEncoder, setTimeout, clearTimeout, setInterval: () => 0, Promise, fetch: async () => { throw new Error('offline'); } });
  ctx.window = ctx;
  for (const f of manifest.background.scripts) vm.runInContext(fs.readFileSync(require('path').join(ext, f), 'utf8'), ctx, { filename: f });
  await vm.runInContext('booted', ctx);
  return { b, local, g: n => vm.runInContext(n, ctx), call: (n, ...args) => vm.runInContext(n, ctx)(...args) };
}
// The listeners the network log leaves on the mocked browser: one per webRequest event, and the tab ones.
const netCounts = a => ({ wr: WR.reduce((n, k) => n + a.b.webRequest[k].fns.length, 0), removed: a.b.tabs.onRemoved.fns.length, updated: a.b.tabs.onUpdated.fns.length });
const armyOn = { signedIn: true, native: 'connected', chatModel: 'quality', chatArmy: true };
// One chat turn from the panel's side: the send with a state, the helper's events, then the end. Returns the chat message sent.
async function turn(a, id, state = armyOn, events = []) {
  await a.g('cfxState').set(state);
  await a.call('startChat', { id, text: 'hi' });
  const sent = a.b.port.sent.filter(m => m.type === 'chat').pop();
  for (const event of events) await a.call('onNativeMessage', { type: 'chat_event', id, event });
  await a.call('onNativeMessage', { type: 'chat_done', id, ok: true });
  return sent;
}

// The checks of the add-on: each one of its own, so a failure names the behaviour it broke.
async function addonChecks() {
  const check = async (name, fn) => { try { const [good, detail] = await fn(); ok(name, good, detail); } catch (e) { ok(name, false, e.message); } };
  const says = a => a.g('cfxState').log().map(e => e.text);
  const maxLine = 'chat → Claude Code, army (Opus 5.5 at max effort, with Haiku workers)';
  const highLine = 'chat → Claude Code, army (Opus 5.5 at high effort, with Haiku workers)';
  // C1: the Max effort switch (storage.local armyMax) makes the army send armymax; the log names the effort
  await check('army: the Max effort switch on sends armymax', async () => {
    const sent = await turn(await boot({}, { armyMax: true }), 'm1');
    return [sent.model === 'armymax', sent.model];
  });
  await check('army: the log says max effort for armymax, high effort for army', async () => {
    const on = await boot({}, { armyMax: true }), off = await boot({}, { armyMax: false });
    await turn(on, 'm2'); await turn(off, 'm3');
    return [says(on).includes(maxLine) && says(off).includes(highLine), JSON.stringify([says(on).slice(-1), says(off).slice(-1)])];
  });
  await check('army: the switch off sends army, and a Max effort switch with the army off sends quality', async () => {
    const army = await turn(await boot({}, { armyMax: false }), 'o1');
    const plain = await turn(await boot({}, { armyMax: true }), 'o2', { ...armyOn, chatArmy: false });
    return [army.model === 'army' && plain.model === 'quality', `${army.model}, ${plain.model}`];
  });
  // C11: today's army tokens: a new day starts at zero, an army stats event adds its input and output, the state shows it
  await check('army tokens: a new day starts the count, and an army stats event adds input and output', async () => {
    const a = await boot({}, { armyTokens: { date: '2000-01-01', tokens: 999999 } });
    await turn(a, 't1', armyOn, [{ kind: 'stats', ms: 1000, turns: 1, tokensIn: 1000, tokensCached: 900, tokensOut: 200, costUsd: 0.01 }]);
    const got = a.local.armyTokens, shown = a.g('cfxState').get().armyTokensToday;
    return [got.date === today() && got.tokens === 1200 && shown === 1200, `${JSON.stringify(got)}, state ${shown}`];
  });
  await check('army tokens: the same day adds on, and a speed turn does not count', async () => {
    const a = await boot({}, { armyTokens: { date: today(), tokens: 1200 } });
    await turn(a, 't2', armyOn, [{ kind: 'stats', ms: 1000, turns: 1, tokensIn: 100, tokensOut: 50 }]);
    const first = a.local.armyTokens.tokens;
    await turn(a, 't3', { ...armyOn, chatModel: 'speed' }, [{ kind: 'stats', ms: 1000, turns: 1, tokensIn: 5000, tokensOut: 5000 }]);
    const last = a.local.armyTokens.tokens, shown = a.g('cfxState').get().armyTokensToday;
    return [first === 1350 && last === 1350 && shown === 1350, `${first}, then ${last}, state ${shown}`];
  });
  await check("army tokens: at startup today's count is read, as the runs count is", async () => {
    const now = await boot({}, { armyTokens: { date: today(), tokens: 4200 } });
    const old = await boot({}, { armyTokens: { date: '2000-01-01', tokens: 4200 } });
    const n = now.g('cfxState').get().armyTokensToday, o = old.g('cfxState').get().armyTokensToday;
    return [n === 4200 && o === 0, `today ${n}, old day ${o}`];
  });
  // C16: the network log's listeners run only while the agent is active
  await check('network log: at startup with the agent stopped, no listeners are added', async () => {
    const off = netCounts(await boot({ state: { agent: 'stopped' } })), on = netCounts(await boot());
    return [off.wr === 0 && off.removed === on.removed - 1 && off.updated === on.updated - 1, `stopped ${JSON.stringify(off)}, active ${JSON.stringify(on)}`];
  });
  await check('network log: Stop removes its listeners, Start adds them back, a second Start or Stop changes nothing', async () => {
    const a = await boot();
    const base = netCounts(await boot({ state: { agent: 'stopped' } }));
    const seen = { on: netCounts(a) };
    await a.call('stopAll', 'check'); seen.stop = netCounts(a);
    await a.call('startAgent'); seen.start = netCounts(a);
    await a.call('cfxNetLogStart'); seen.again = netCounts(a);
    a.call('cfxNetLogStop'); a.call('cfxNetLogStop'); seen.stopTwice = netCounts(a);
    const good = seen.on.wr === WR.length && seen.stop.wr === 0 && seen.stop.removed === base.removed && seen.start.wr === WR.length && seen.start.removed === base.removed + 1 && seen.again.wr === WR.length && seen.again.removed === base.removed + 1 && seen.stopTwice.wr === 0 && seen.stopTwice.removed === base.removed;
    return [good, JSON.stringify(seen)];
  });
  await check('network log: Zen opened with the agent stopped turns it on, and the log starts', async () => {
    const a = await boot({ state: { agent: 'stopped' } });
    const before = netCounts(a).wr;
    for (const f of a.b.windows.onCreated.fns) f({ type: 'normal' });
    await new Promise(r => setTimeout(r, 30));
    return [before === 0 && netCounts(a).wr === WR.length && a.g('cfxState').get().agent === 'active', `before ${before}, after ${netCounts(a).wr}`];
  });
}

(async () => {
  await addonChecks();
  if (JSDOM) await panelChecks(); else console.log('SKIP  panel checks: jsdom not installed');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
