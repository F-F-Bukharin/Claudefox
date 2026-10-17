'use strict';
// Inject once (C14) and the page text cache (C13): cfxInPage installs the page operation once per document as
// window.__cfxOp (version window.__cfxOpV) and later calls send only a small probe; get_page_text keeps its converted text 60 s.
// DOM test (jsdom): needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(EXT + 'lib/policy.js', 'utf8') + '\n' + ['pageOp.js', 'pageOpRead.js', 'pageOpAct.js'].map(f => fs.readFileSync(EXT + 'lib/' + f, 'utf8')).join('\n');
const toolsSrc = fs.readFileSync(EXT + 'lib/pageTools.js', 'utf8');
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };

// A document the way the other DOM tests build it; counts the style and text reads the conversion makes (a cache hit makes none).
let conversions = 0;
function newPage(html) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://shop.example/', runScripts: 'outside-only' });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 });
  const gcs = w.getComputedStyle.bind(w); w.getComputedStyle = (...a) => { conversions++; return gcs(...a); };
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { conversions++; return this.textContent; } });
  w.Element.prototype.scrollIntoView = () => {};
  return w;
}
const HTML = '<h1>Shop</h1><p id=intro>Welcome to the shop. We sell shoes and hats.</p><a id=lnk href="/next">Next page</a><button id=b>Press</button>'
  + '<input id=name name=name><input id=pw type=password aria-label="Password">';
let w = newPage(HTML), sent = 0, calls = 0;

// executeScript as the add-on's content-script world runs it: the code is evaluated in the current document, bytes counted.
const ctx = vm.createContext({ URL, Date });
vm.runInContext(src + ';this.cfxPageCode=cfxPageCode;', ctx);
ctx.browser = { tabs: { executeScript: async (id, o) => { calls++; sent += o.code.length; return [w.eval(o.code)]; } } };
ctx.CFX_FILE_ACCESS_OFF = 'file access is off';
const fn = toolsSrc.match(/async function cfxInPage[\s\S]*?\n}\n/);
if (!fn) { console.log('FAIL cfxInPage not found in pageTools.js'); process.exit(1); }
vm.runInContext(fn[0] + ';this.cfxInPage=cfxInPage;', ctx);
const tab = { id: 1, url: 'https://shop.example/' };
const call = async (op, args) => { sent = 0; calls = 0; const r = await ctx.cfxInPage(tab, op, args); return { r: JSON.parse(JSON.stringify(r === undefined ? null : r)), sent, calls }; };

(async () => {
  const full = ctx.cfxPageCode('text', {}).length;
  // C14: first call installs, later calls probe.
  const a = await call('exists', { selector: '#b' });
  ok('first call on a fresh document sends the full code', a.sent >= full - 200 && a.r === true, `sent ${a.sent} bytes, ${a.calls} call(s), ${JSON.stringify(a.r)}`);
  ok('it installs __cfxOp and a version', typeof w.__cfxOp === 'function' && typeof w.__cfxOpV === 'string' && w.__cfxOpV.length > 0, String(w.__cfxOpV));
  const v = w.__cfxOpV;
  const b = await call('exists', { selector: '#b' });
  ok('the second call sends only the probe (under 2 KB) with the same result', b.sent < 2048 && b.calls === 1 && JSON.stringify(b.r) === JSON.stringify(a.r), `sent ${b.sent} bytes, ${b.calls} call(s)`);
  ok('the version did not change', w.__cfxOpV === v);
  // A new document gets the full code again.
  w = newPage(HTML);
  const c = await call('exists', { selector: '#b' });
  ok('a new document gets the full code again', c.sent >= full - 200 && c.r === true && w.__cfxOpV === v, `sent ${c.sent}`);
  // An older version is reinstalled.
  w.__cfxOpV = 'old'; w.__cfxOp = () => ({ stale: true });
  const d1 = await call('exists', { selector: '#b' });
  ok('an older __cfxOpV gets the full code', d1.sent >= full - 200 && d1.r === true && w.__cfxOpV === v, JSON.stringify(d1.r));
  // Probe with a missing function but the right version marker still installs.
  delete w.__cfxOp;
  const d2 = await call('exists', { selector: '#b' });
  ok('a version without the function gets the full code', d2.r === true && typeof w.__cfxOp === 'function');
  // Probe args are data, not code.
  const tricky = await call('exists', { selector: '#b', note: "'; throw new Error('x'); // \"" });
  ok('arguments with quotes and line separators reach the op as data', tricky.r === true && tricky.sent < 2048);
  // Results through the installed function are the same as a fresh install, op by op.
  const ops = [['read', {}], ['find', { query: 'Next' }], ['exists', { selector: '#lnk' }], ['classify', { selector: '#lnk' }], ['analyze', {}], ['viewport', {}], ['selection', {}]];
  for (const [op, args] of ops) {
    const probe = await call(op, args);                                   // installed: probe path
    const wf = newPage(HTML); const fresh = JSON.parse(JSON.stringify(wf.eval(ctx.cfxPageCode(op, args))));
    const norm = x => JSON.stringify(x).replace(/ref_\d+/g, 'ref');
    ok(`${op} through the installed function matches a fresh install`, probe.sent < 2048 && norm(probe.r) === norm(fresh), `sent ${probe.sent}`);
  }
  const clicked = await call('click', { selector: '#lnk' });
  ok('click works through the installed function', clicked.sent < 2048 && !clicked.r.error, JSON.stringify(clicked.r).slice(0, 120));
  const typed = await call('type', { selector: '#name', text: 'Ana' });
  ok('type works through the installed function', w.document.getElementById('name').value === 'Ana', JSON.stringify(typed.r).slice(0, 120));
  const pwd = await call('type', { selector: '#pw', text: 'secret' }).then(x => x, e => ({ r: { error: String(e.message) } }));
  ok('sensitiveField still refuses a password field through the installed function', w.document.getElementById('pw').value === '' && /password|sensitive|never/i.test(JSON.stringify(pwd.r)), JSON.stringify(pwd.r).slice(0, 140));
  const bad = await call('nope', {}).then(() => 'no error', e => String(e.message));
  ok('an unknown op still fails with Unknown page operation', /Unknown page operation/.test(bad), bad);

  // C13: the page text cache.
  w = newPage(HTML);
  let now = 1000000; w.Date.now = () => now;
  await call('exists', { selector: '#b' });                               // install
  const t = args => call('text', args);
  conversions = 0; const t1 = await t({}); const n1 = conversions;
  const t2 = await t({}); const n2 = conversions - n1;
  ok('get_page_text twice returns the same text', n1 > 0 && t1.r.text && t2.r.text === t1.r.text && JSON.stringify(t2.r) === JSON.stringify(t1.r), `first ${n1} reads`);
  ok('the second get_page_text does not convert again', n2 === 0, `${n2} layout reads`);
  w.document.body.appendChild(Object.assign(w.document.createElement('p'), { textContent: 'A brand new line about socks.' }));
  conversions = 0; const t3 = await t({});
  ok('after an element is added it converts again and shows the change', conversions > 0 && /socks/.test(t3.r.text), `${conversions} reads`);
  w.document.getElementById('intro').textContent += ' More words were typed in here.';
  conversions = 0; const t3b = await t({});
  ok('after text changes in place (same elements) it converts again', conversions > 0 && /More words/.test(t3b.r.text));
  conversions = 0; await t({}); ok('and is cached again afterwards', conversions === 0);
  now += 59000; conversions = 0; await t({}); ok('still cached after 59 s', conversions === 0);
  now += 2000; conversions = 0; await t({}); ok('converts again after 60 s', conversions > 0);
  conversions = 0; await t({}); ok('and the new conversion is cached', conversions === 0);
  conversions = 0; const tf = await t({ format: 'text' });
  ok('a different format is a different key', conversions > 0 && tf.r.text.length > 0, `${conversions} reads`);
  conversions = 0; await t({ format: 'text' }); ok('the text format is cached too', conversions === 0);
  conversions = 0; const ts = await t({ scope: 'full' });
  ok('a different scope is a different key', conversions > 0 && ts.r.text.length > 0, `${conversions} reads`);
  conversions = 0; await t({}); await t({ scope: 'full' }); await t({ format: 'text' });
  ok('the earlier keys are still cached', conversions === 0);
  conversions = 0; const tq = await t({ query: 'shoes' });
  ok('a query answers from the cached conversion when there is one for the same scope, and is right', /shoes/.test(tq.r.text));
  w.history.pushState({}, '', '/other');
  conversions = 0; await t({}); ok('another URL in the same document is a different key', conversions > 0);
  const cacheKeys = JSON.stringify(Object.keys(w.__cfxSt || {}).sort());
  ok('the cache lives in window.__cfxSt next to the refs', /"refs"/.test(cacheKeys) && /"seq"/.test(cacheKeys), cacheKeys);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
