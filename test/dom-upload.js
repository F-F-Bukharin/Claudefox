'use strict';
// Uploads and page dialogs (E13): the upload card in the real panel.html/panel.js (jsdom); the add-on side, lib/pageTools.js
// in a vm with fake timers, state and tab (the card's wait, Automatic, Deny, the timers, the parts, the dialog note); and the
// page side, lib/pageOp.js and pageOpAct.js as the add-on injects them (jsdom): attach, and the dialog guard in a click, an
// Enter and a submit. Optional: needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
//   NODE_PATH=... node test/dom-upload.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const EXT = path.join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
// A check that throws (a missing element or function, say) is one FAIL, and the rest still run.
const step = async (name, fn) => { try { ok(name, await fn()); } catch (e) { ok(name, false, String(e.message || e).split('\n')[0]); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
const ASK = { id: '7', name: 'photo.png', size: '2.4 MB', site: 'example.com' };
const REFUSED = 'The user did not allow this upload.';

async function panelPart() {
  const { html, files: panelFiles } = panelPage(EXT);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  let onMsg;
  w.browser = {
    runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.11.0' }) },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;');
  w.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
  evalPanel(dom, EXT, panelFiles);
  const $ = id => w.document.getElementById(id);
  const base = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected',
    debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '', watch: false, watchOnLoad: null, watchAsk: null,
    downloadAsk: null, uploadAsk: null, trusted: false };
  const push = async s => { onMsg({ type: 'state', state: Object.assign({}, base, s), log: [] }); await wait(20); };
  const sentOf = type => sent.filter(m => m.type === type);

  await push({});
  await step('the upload card is hidden by default', () => $('uploadCard').hidden === true);
  await push({ uploadAsk: ASK });
  await step('the card reads exactly "Claude wants to upload photo.png (2.4 MB) to example.com"', () =>
    $('uploadCard').hidden === false && $('uploadCardText').textContent === 'Claude wants to upload photo.png (2.4 MB) to example.com');
  await step('uploadShown goes once per card id', () => sentOf('uploadShown').length === 1 && sentOf('uploadShown')[0].id === '7');
  await push({ uploadAsk: ASK, trusted: true });
  await step('the panel shows the card whenever the add-on asks, whatever the switches say', () => $('uploadCard').hidden === false);
  await step('Allow posts uploadAnswer with allow true', () => { $('uploadAllow').click(); return sentOf('uploadAnswer').some(m => m.id === '7' && m.allow === true); });
  await push({ uploadAsk: { id: '8', name: 'a.txt', size: '1 KB', site: 'example.com' }, trusted: true });
  await step('Deny posts uploadAnswer with allow false', () => { $('uploadDeny').click(); return sentOf('uploadAnswer').some(m => m.id === '8' && m.allow === false); });
}

// The add-on side: lib/pageTools.js in a vm, with fake timers, state and tab. The card waits for the panel's answer (5 s to
// show, 120 s to answer); Automatic and Unsafe mode skip it; Deny, the timers and Stop refuse; an allowed upload is sent in parts and
// attached in the page; the dialog note is the line the helper's result shows.
async function addonPart() {
  const timers = [], inPage = [];
  const fire = ms => { for (const t of timers) if (t.ms === ms && !t.cancelled && !t.done) { t.done = true; t.fn(); } };
  const cfxState = { value: { trusted: false, unsafe: false }, get() { return this.value; }, set(p) { Object.assign(this.value, p); return this.value; } };
  const ctx = vm.createContext({ URL, cfxState, browser: { runtime: { getManifest: () => ({ version: '0.11.0' }) } },
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.cancelled = true; } });
  vm.runInContext(fs.readFileSync(EXT + 'lib/policy.js', 'utf8') + '\n' + fs.readFileSync(EXT + 'lib/pageTools.js', 'utf8')
    + '\n;this.CFX_TOOLS = CFX_TOOLS;'
    + ' this.cfxUploadGate = typeof cfxUploadGate === "undefined" ? undefined : cfxUploadGate;'
    + ' this.cfxDialogNote = typeof cfxDialogNote === "undefined" ? undefined : cfxDialogNote;', ctx);
  ctx.cfxPageTab = async () => ({ id: 5, url: 'https://example.com/form', title: 'Form' });
  ctx.cfxInPage = async (tab, op, args) => { inPage.push({ op, args }); return { attached: args.name }; };
  const refusal = p => p.then(() => null, e => e.message);
  const ask = id => ({ ask: true, id, selector: '#up', name: 'a.txt', type: 'text/plain', size: 2, parts: 1 });
  await step('with Automatic off, the card waits in the add-on state with the name and the site', async () => {
    const p = ctx.CFX_TOOLS.upload_attach(ask('u0')); await tick();
    const s = cfxState.value.uploadAsk;
    ctx.cfxUploadGate.answer('u0', false);
    await refusal(p);
    return cfxState.value.trusted === false && cfxState.value.unsafe === false && !!s && s.id === 'u0' && s.name === 'a.txt' && s.site === 'example.com';
  });
  // The ask resolves { accepted } with no card, or stays waiting (a card is up): the race tells which.
  const askNoCard = async id => {
    const p = ctx.CFX_TOOLS.upload_attach(ask(id));
    const first = await Promise.race([p.then(v => v, e => ({ error: e.message })), wait(60).then(() => 'waiting')]);
    const card = cfxState.value.uploadAsk;
    if (first === 'waiting') { ctx.cfxUploadGate.answer(id, false); await refusal(p); }
    return { first, card };
  };
  await step('Automatic mode: the upload is accepted with no card, and the bytes attach', async () => {
    cfxState.value.trusted = true;
    const r = await askNoCard('a1');
    await ctx.CFX_TOOLS.upload_part({ id: 'a1', index: 0, data: 'aGk=' });
    const before = inPage.length;
    const done = await ctx.CFX_TOOLS.upload_attach({ attach: true, id: 'a1' });
    cfxState.value.trusted = false;
    return r.first && r.first.accepted === true && r.card === null && inPage.length === before + 1 && done.attached === 'a.txt';
  });
  await step('Unsafe mode: the upload is accepted with no card', async () => {
    cfxState.value.unsafe = true;
    const r = await askNoCard('a2');
    cfxState.value.unsafe = false;
    return r.first && r.first.accepted === true && r.card === null;
  });
  await step('Automatic mode in a scheduled macro\'s turn still shows the card', async () => {
    cfxState.value.trusted = true;
    ctx.cfxSiteGate = { scheduled: () => true };
    const r = await askNoCard('a3');
    delete ctx.cfxSiteGate;
    cfxState.value.trusted = false;
    return r.first === 'waiting' && !!r.card && r.card.id === 'a3';
  });
  await step('Automatic off again: the card is back', async () => {
    const r = await askNoCard('a4');
    return r.first === 'waiting' && !!r.card && r.card.id === 'a4';
  });
  await step('Deny refuses with "The user did not allow this upload." and clears the card', async () => {
    const p = ctx.CFX_TOOLS.upload_attach(ask('u1')); await tick();
    ctx.cfxUploadGate.answer('u1', false);
    return (await refusal(p)) === REFUSED && cfxState.value.uploadAsk === null;
  });
  await step('no card shown within 5 s refuses', async () => {
    const p = ctx.CFX_TOOLS.upload_attach(ask('u2')); await tick();
    fire(5000);
    return (await refusal(p)) === REFUSED;
  });
  await step('no answer within 120 s of the card showing refuses', async () => {
    const p = ctx.CFX_TOOLS.upload_attach(ask('u3')); await tick();
    ctx.cfxUploadGate.shown('u3'); fire(120000);
    return (await refusal(p)) === REFUSED;
  });
  await step('Stop cancels a waiting card: the upload is refused and the card clears', async () => {
    const p = ctx.CFX_TOOLS.upload_attach(ask('u4')); await tick();
    ctx.cfxUploadGate.cancel();
    return (await refusal(p)) === REFUSED && cfxState.value.uploadAsk === null;
  });
  await step('Allow sends the part and attaches it in the page with name, type and base64', async () => {
    inPage.length = 0;
    const p = ctx.CFX_TOOLS.upload_attach(ask('u5')); await tick();
    ctx.cfxUploadGate.answer('u5', true);
    const accepted = await p;
    await ctx.CFX_TOOLS.upload_part({ id: 'u5', index: 0, data: 'aGk=' });
    const done = await ctx.CFX_TOOLS.upload_attach({ attach: true, id: 'u5' });
    return accepted.accepted === true && inPage.length === 1 && inPage[0].op === 'attach' && inPage[0].args.name === 'a.txt'
      && inPage[0].args.type === 'text/plain' && inPage[0].args.data === 'aGk=' && done.attached === 'a.txt';
  });
  await step('several parts: the add-on sends attachpart, attachpart, then attach by id', async () => {
    const before = inPage.length;
    const p = ctx.CFX_TOOLS.upload_attach(Object.assign(ask('u6'), { parts: 2 })); await tick();
    ctx.cfxUploadGate.answer('u6', true);
    await p;
    await ctx.CFX_TOOLS.upload_part({ id: 'u6', index: 0, data: 'aGVsbG8g' });
    await ctx.CFX_TOOLS.upload_part({ id: 'u6', index: 1, data: 'd29ybGQ=' });
    const done = await ctx.CFX_TOOLS.upload_attach({ attach: true, id: 'u6' });
    const calls = inPage.slice(before);
    return calls.map(c => c.op).join() === 'attachpart,attachpart,attach' && calls[0].args.index === 0 && calls[0].args.data === 'aGVsbG8g'
      && calls[1].args.index === 1 && calls[1].args.data === 'd29ybGQ=' && calls[2].args.id === 'u6' && calls[2].args.name === 'a.txt'
      && calls[2].args.selector === '#up' && calls[2].args.data === undefined && done.site === 'example.com';
  });
  await step('attach refuses when the tab moved to another site, and attaches nothing', async () => {
    const before = inPage.length;
    const p = ctx.CFX_TOOLS.upload_attach(ask('u7')); await tick();
    ctx.cfxUploadGate.answer('u7', true);
    await p;
    await ctx.CFX_TOOLS.upload_part({ id: 'u7', index: 0, data: 'aGk=' });
    const was = ctx.cfxPageTab;
    ctx.cfxPageTab = async () => ({ id: 5, url: 'https://evil.example/login', title: 'Other' });
    const why = await refusal(ctx.CFX_TOOLS.upload_attach({ attach: true, id: 'u7' }));
    ctx.cfxPageTab = was;
    const again = await refusal(ctx.CFX_TOOLS.upload_attach({ attach: true, id: 'u7' }));
    return /another site/.test(why || '') && inPage.length === before && again === REFUSED;
  });
  await step('a part for an upload that was not allowed is refused', async () => (await refusal(ctx.CFX_TOOLS.upload_part({ id: 'nope', index: 0, data: 'aGk=' }))) === REFUSED);
  await step('a click result that showed a dialog gets the note line', async () => {
    const out = ctx.cfxDialogNote({ clicked: 'button "Go"', dialog: { kind: 'confirm', text: 'Delete it?', answered: 'Cancel' } });
    return out.note === 'The page showed a confirm: "Delete it?" (answered Cancel).';
  });
  await step('a result without a dialog gets no note', async () => ctx.cfxDialogNote({ clicked: 'x' }).note === undefined);
}

// The page side: lib/pageOp.js, pageOpRead.js and pageOpAct.js as the add-on injects them (cfxPageCode), in jsdom. attach puts
// the file on a file field with a DataTransfer and fires input and change. In a click, an Enter or a submitting type, the
// page's alert, confirm and prompt are answered at once and reported in the result; they are the page's own again 1 s later.
async function pageSidePart() {
  const src = fs.readFileSync(EXT + 'lib/policy.js', 'utf8') + '\n' + ['pageOp.js', 'pageOpRead.js', 'pageOpAct.js'].map(f => fs.readFileSync(EXT + 'lib/' + f, 'utf8')).join('\n');
  const pctx = vm.createContext({ URL });
  vm.runInContext(src + ';this.cfxPageCode = cfxPageCode;', pctx);
  const dom = new JSDOM('<h1>Form</h1><input type="file" id="up"><button id="go">Go</button><button id="ask">Ask</button><button id="name">Name</button>',
    { url: 'https://shop.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 });
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
  w.Element.prototype.scrollIntoView = () => {};
  const run = (op, args) => w.eval(pctx.cfxPageCode(op, args));
  const origAlert = w.alert, origConfirm = w.confirm, origPrompt = w.prompt;
  // jsdom has no DataTransfer and its file list is read-only: a stand-in DataTransfer, and the assignment recorded.
  let assigned = null;
  w.DataTransfer = function () { const files = []; this.items = { add: f => { files.push(f); } }; Object.defineProperty(this, 'files', { get: () => files }); };
  const input = w.document.getElementById('up');
  Object.defineProperty(input, 'files', { configurable: true, get: () => assigned, set: v => { assigned = v; } });
  const seen = { input: 0, change: 0 };
  input.addEventListener('input', () => { seen.input++; });
  input.addEventListener('change', () => { seen.change++; });
  const hi = Buffer.from('hi').toString('base64');
  await step('attach puts the file on the field through a DataTransfer', () => {
    run('attach', { selector: '#up', name: 'a.txt', type: 'text/plain', data: hi });
    return !!assigned && assigned.length === 1 && assigned[0].name === 'a.txt' && assigned[0].type === 'text/plain';
  });
  await step('attach fires input and change once each', () => seen.input === 1 && seen.change === 1);
  await step('attach refuses an element that is not a file field', () => {
    try { run('attach', { selector: '#go', name: 'a.txt', type: 'text/plain', data: hi }); return false; } catch (e) { return /file/i.test(e.message); }
  });
  await step('attach by id joins the stored parts: "aGVsbG8g" + "d29ybGQ=" is "hello world"', async () => {
    run('attachpart', { id: 'm1', index: 0, data: 'aGVsbG8g' });
    run('attachpart', { id: 'm1', index: 1, data: 'd29ybGQ=' });
    run('attach', { selector: '#up', name: 'h.txt', type: 'text/plain', id: 'm1' });
    const f = assigned[0];
    const text = await new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f); });
    return f.name === 'h.txt' && text === 'hello world';
  });
  await step('attach by id with parts that never arrived is refused', () => {
    try { run('attach', { selector: '#up', name: 'h.txt', type: 'text/plain', id: 'gone' }); return false; } catch (e) { return /parts/.test(e.message); }
  });
  w.eval("document.getElementById('go').addEventListener('click', () => { window.goAnswer = confirm('Delete it?'); });");
  await step('a confirm during a click is answered Cancel by default and reported', () => {
    const r = run('click', { selector: '#go' });
    return w.goAnswer === false && !!r.dialog && r.dialog.kind === 'confirm' && r.dialog.text === 'Delete it?' && r.dialog.answered === 'Cancel';
  });
  await step('accept_dialog answers the same confirm OK', () => {
    const r = run('click', { selector: '#go', accept_dialog: true });
    return w.goAnswer === true && !!r.dialog && r.dialog.answered === 'OK';
  });
  w.eval("document.getElementById('ask').addEventListener('click', () => { window.alerted = alert('Saved'); });");
  await step('an alert is dismissed and reported as answered OK', () => {
    const r = run('click', { selector: '#ask' });
    return w.alerted === undefined && !!r.dialog && r.dialog.kind === 'alert' && r.dialog.text === 'Saved' && r.dialog.answered === 'OK';
  });
  w.eval("document.getElementById('name').addEventListener('click', () => { window.typed = prompt('Your name?', ''); });");
  await step('a prompt is answered null unless accepted, and reported as Cancel', () => {
    const r = run('click', { selector: '#name' });
    return w.typed === null && !!r.dialog && r.dialog.kind === 'prompt' && r.dialog.answered === 'Cancel';
  });
  await step('an accepted prompt returns dialog_text', () => {
    const r = run('click', { selector: '#name', accept_dialog: true, dialog_text: 'Ann' });
    return w.typed === 'Ann' && !!r.dialog && r.dialog.text === 'Your name?' && r.dialog.answered === 'OK';
  });
  w.eval("document.addEventListener('keydown', e => { if (e.key === 'Enter') window.sent = confirm('Send it?'); });");
  await step('an Enter that raises a confirm is answered and reported', () => {
    const r = run('press', { key: 'Enter' });
    return w.sent === false && !!r.dialog && r.dialog.kind === 'confirm' && r.dialog.answered === 'Cancel';
  });
  await wait(1100);
  await step('the page own alert, confirm and prompt are back 1 s after the last action', () =>
    w.alert === origAlert && w.confirm === origConfirm && w.prompt === origPrompt);
}

(async () => {
  await panelPart();
  await addonPart();
  await pageSidePart();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL crash  ' + String(e.message || e).split('\n')[0]); process.exit(1); });
