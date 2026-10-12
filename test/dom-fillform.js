'use strict';
(async () => {
// fill_form (E12): the page reads each field's label and refuses sensitive fields before any card; the user approves the
// list in a card; Approve fills each field the way fill does; nothing is submitted. Page side: jsdom running the real page
// code. Add-on side: lib/pageTools.js in a vm, whose cizInPage runs the real page code in that same jsdom page.
// DOM test (jsdom): needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const fs = require('fs'), vm = require('vm'), path = require('path');
const { panelPage, evalPanel } = require('./lib/panel-scripts');
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
// One check: a throw inside it is a failed check, not the end of the run.
const check = async (name, fn) => { try { ok(name, !!(await fn())); } catch (e) { ok(name, false, String((e && e.message) || e)); } };
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

const src = fs.readFileSync(EXT + 'lib/policy.js', 'utf8') + '\n' + ['pageOp.js', 'pageOpRead.js', 'pageOpAct.js'].map(f => fs.readFileSync(EXT + 'lib/' + f, 'utf8')).join('\n');
const dom = new JSDOM(`<!doctype html><html><body><form id="f" action="/post">
<label for="name">Your name</label><input id="name" value="old">
<label>Town <input id="town"></label>
<input id="q" aria-label="Search the shop">
<input id="post" placeholder="Postcode">
<input id="pw" type="password">
<input id="card" autocomplete="cc-number">
<select id="pick"><option>Red</option></select>
<button type="submit">Send</button></form></body></html>`, { url: 'https://shop.example/', runScripts: 'outside-only' });
const w = dom.window, d = w.document;
w.Element.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 });
Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
let scrolls = 0; w.Element.prototype.scrollIntoView = () => { scrolls++; };
const pctx = vm.createContext({ URL });
vm.runInContext(src + ';this.cizPageCode=cizPageCode;', pctx);
// The page op as the add-on runs it (executeScript): the answer as plain JSON; a page error is thrown.
const pageRun = (op, args) => JSON.parse(JSON.stringify(w.eval(pctx.cizPageCode(op, args))));
const sel = id => ({ selector: '#' + id });
const F = (id, value) => ({ selector: '#' + id, value });
let edits = 0, submits = 0;
d.querySelectorAll('input, select').forEach(el => el.addEventListener('input', () => edits++));
d.getElementById('f').addEventListener('submit', e => { e.preventDefault(); submits++; });

// ---- the page op formlabels: labels, sensitive fields, nothing changed on the page
await check('formlabels: label for, wrapping label, aria-label and placeholder resolve', () => {
  const f = pageRun('formlabels', { fields: [sel('name'), sel('town'), sel('q'), sel('post')] }).fields;
  return f[0].label === 'Your name' && f[1].label === 'Town' && f[2].label === 'Search the shop' && f[3].label === 'Postcode';
});
await check('formlabels: a password and a card-number field are sensitive, a text field is not', () => {
  const f = pageRun('formlabels', { fields: [sel('pw'), sel('card'), sel('name')] }).fields;
  return !!f[0].sensitive && !!f[1].sensitive && f[2].sensitive === null;
});
await check('formlabels changes nothing on the page: value, scroll, events', () => {
  const s0 = scrolls, e0 = edits;
  pageRun('formlabels', { fields: [sel('name'), sel('pick')] });
  return d.getElementById('name').value === 'old' && scrolls === s0 && edits === e0;
});

// ---- the add-on: lib/pageTools.js in a vm; cizInPage runs the real page code in the jsdom page above
const state = { trusted: false, fillAsk: null };
const sets = [], ops = [];
const actx = vm.createContext({ console, URL, setTimeout, clearTimeout,
  pageOps: (op, args) => { ops.push(op); const { __army, ...a } = args || {}; return pageRun(op, a); },
  cizState: { get: () => state, set: async p => { sets.push(p); Object.assign(state, p); } } });
vm.runInContext(fs.readFileSync(EXT + 'lib/pageTools.js', 'utf8'), actx, { filename: 'pageTools.js' });
vm.runInContext(`cizSiteOf = url => new URL(url).host;
  cizTabFor = async () => ({ id: 1, url: 'https://shop.example/' });
  cizPageTab = async () => ({ id: 1, url: 'https://shop.example/' });
  cizInPage = (tab, op, args) => pageOps(op, args);`, actx);
const T = vm.runInContext('CIZ_TOOLS', actx), B = name => vm.runInContext(name, actx);
const settle = p => p.then(res => ({ res }), e => ({ err: String((e && e.message) || e) }));
const cardSet = () => sets.some(p => p.fillAsk);
const nameVal = () => d.getElementById('name').value;

await check('a password field refuses the whole call before any card', async () => {
  sets.length = 0; ops.length = 0;
  const r = await settle(T.fill_form({ fields: [F('name', 'Ana'), F('pw', 'x')] }));
  return /Refused/.test(r.err || '') && /password/.test(r.err || '') && !cardSet() && nameVal() === 'old';
});
await check('a card-number field refuses too, with no card', async () => {
  sets.length = 0;
  const r = await settle(T.fill_form({ fields: [F('card', '4111 1111 1111 1111')] }));
  return /Refused/.test(r.err || '') && !cardSet();
});
await check('more than 30 fields are refused before the page is touched, with no card', async () => {
  sets.length = 0; ops.length = 0;
  const r = await settle(T.fill_form({ fields: Array.from({ length: 31 }, () => F('name', 'x')) }));
  return !!r.err && ops.length === 0 && !cardSet();
});
await check('the card lists label and value, values cut to 80 characters', async () => {
  sets.length = 0;
  const p = settle(T.fill_form({ fields: [F('name', 'Ana'), F('town', 'z'.repeat(200))] }));
  await tick();
  const c = state.fillAsk;
  const good = !!c && c.rows.length === 2 && c.rows[0].label === 'Your name' && c.rows[0].value === 'Ana'
    && c.rows[1].label === 'Town' && c.rows[1].value.length === 80 && c.rows[1].value.endsWith('…');
  B('cizFillShown')(c.id); B('cizFillAnswer')(c.id, false);
  await p;
  return good;
});
await check('Approve fills each field as fill does, reports per field, and submits nothing', async () => {
  sets.length = 0; submits = 0;
  const p = settle(T.fill_form({ fields: [F('name', 'Ana'), F('town', 'Lisbon'), F('pick', 'Blue')] }));
  await tick();
  const c = state.fillAsk;
  B('cizFillShown')(c.id); B('cizFillAnswer')(c.id, true);
  const r = await p;
  const f = r.res && r.res.fields;
  return !r.err && nameVal() === 'Ana' && d.getElementById('town').value === 'Lisbon'
    && !!f && f[0].filled === '3 characters' && f[1].filled === '6 characters' && !!f[2].error
    && r.res.submitted === false && submits === 0 && state.fillAsk === null;
});
await check('Deny fills nothing and refuses with the card text', async () => {
  sets.length = 0;
  const p = settle(T.fill_form({ fields: [F('name', 'Bo')] }));
  await tick();
  const c = state.fillAsk;
  B('cizFillShown')(c.id); B('cizFillAnswer')(c.id, false);
  const r = await p;
  return r.err === 'The user did not approve filling this form.' && nameVal() === 'Ana';
});
await check('no answer is Deny: the card times out and nothing is filled', async () => {
  vm.runInContext('CIZ_FILL_MS.shown = 20; CIZ_FILL_MS.answer = 20;', actx);
  const r = await settle(T.fill_form({ fields: [F('name', 'Cy')] }));
  vm.runInContext('CIZ_FILL_MS.shown = 5000; CIZ_FILL_MS.answer = 120000;', actx);
  return r.err === 'The user did not approve filling this form.' && nameVal() === 'Ana' && state.fillAsk === null;
});
await check('Trusted mode still shows the card', async () => {
  state.trusted = true;
  const p = settle(T.fill_form({ fields: [F('name', 'Di')] }));
  await tick();
  const shown = !!state.fillAsk;
  B('cizFillShown')(state.fillAsk.id); B('cizFillAnswer')(state.fillAsk.id, false);
  await p;
  state.trusted = false;
  return shown;
});
await check('fill_form is an act tool for the site gate, as fill is', () => B("CIZ_ACT_TOOLS.has('fill_form')") === true);
await check('a worker call to fill_form is refused: host guard refuses, worker lists leave it out', () => {
  const guard = require(path.join(__dirname, '..', 'host', 'lib', 'armyguard.js'));
  const list = /CIZ_ARMY_TOOLS = new Set\(\[([^\]]*)\]/.exec(fs.readFileSync(EXT + 'lib/army.js', 'utf8'));
  return guard.checkCall({}, 'fill_form', { fields: [] }, 0).ok === false && !guard.WORKER_TOOLS.includes('fill_form')
    && !!list && !/fill_form/.test(list[1]);
});

// ---- the panel's card (panel.js, panel.html): rows, fillShown once, Approve and Deny
const sent = []; let onMsg;
const { html, files } = panelPage(EXT);
const pdom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }), pw = pdom.window;
pw.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.11.0' }) },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
  tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
};
pw.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
pw.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
evalPanel(pdom, EXT, files);
const $p = id => pw.document.getElementById(id);
const push = s => onMsg({ type: 'state', log: [], state: Object.assign({ agent: 'active', signedIn: true, account: { email: 'f@example.com', name: 'F', uuid: 'u' },
  native: 'connected', debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '', watch: false, watchOnLoad: null,
  watchAsk: null, siteAsk: null, fillAsk: null, trusted: false }, s) });
const pcard = { id: 'fill-p1', site: 'shop.example', rows: [{ label: 'Your name', value: 'Ana' }, { label: 'Town', value: 'z'.repeat(79) + '…' }] };
await check('panel: the fill card shows the label and value rows', () => {
  push({ fillAsk: pcard });
  return !$p('fillCard').hidden && $p('fillRows').textContent.includes('Your name') && $p('fillRows').textContent.includes('Ana')
    && $p('fillCardSite').textContent === 'shop.example';
});
await check('panel: fillShown goes once per card id', () => {
  push({ fillAsk: pcard }); push({ fillAsk: pcard });
  return sent.filter(m => m.type === 'fillShown' && m.id === 'fill-p1').length === 1;
});
await check('panel: Approve posts fillAnswer allow true, Deny posts allow false', () => {
  $p('fillApprove').dispatchEvent(new pw.Event('click'));
  $p('fillDeny').dispatchEvent(new pw.Event('click'));
  return sent.some(m => m.type === 'fillAnswer' && m.id === 'fill-p1' && m.allow === true)
    && sent.some(m => m.type === 'fillAnswer' && m.id === 'fill-p1' && m.allow === false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
