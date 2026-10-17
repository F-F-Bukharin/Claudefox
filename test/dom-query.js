'use strict';
// Page reads and screenshots (w4-3, C4 and C15): get_page_text with a query, the 12,000-character worker read, and the
// screenshot as a JPEG with an optional half size. The text op runs in jsdom, the way dom-classify.js runs its ops; the
// tools run from lib/pageTools.js in a vm with the tab, the page op and captureTab stubbed.
// DOM test: needs jsdom (NODE_PATH pointing at one). Skips without it.   node test/dom-query.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const path = require('path'), fs = require('fs'), vm = require('vm');
const EXT = path.join(__dirname, '..', 'extension') + '/', HOST = path.join(__dirname, '..', 'host', 'lib') + '/';
const src = fs.readFileSync(EXT + 'lib/policy.js', 'utf8') + '\n' + ['pageOp.js', 'pageOpRead.js', 'pageOpAct.js'].map(f => fs.readFileSync(EXT + 'lib/' + f, 'utf8')).join('\n');
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x ? '  ' + x : '')); };
const HALF = 'This image is at half size: double x and y for click and hover.';
const headingsOf = t => String(t).split('\n').filter(l => /^#{1,6} /.test(l));

// The page: the injected page code (cfxPageCode) run in the jsdom window, the way executeScript runs it.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.example/', runScripts: 'outside-only' });
const w = dom.window, d = w.document;
w.Element.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 });
Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
const ctx = vm.createContext({ URL });
vm.runInContext(src + ';this.cfxPageCode=cfxPageCode;', ctx);
// The text op's answer as plain JSON (the page's objects come from another realm). An error comes back as text.
const text = args => { try { return JSON.parse(JSON.stringify(w.eval(ctx.cfxPageCode('text', args)))); } catch (e) { return { text: 'ERROR ' + e.message, truncated: null }; } };

d.body.innerHTML = `<main>
<h1>Shop</h1>
<p>Welcome to the shop, where we sell tea.</p>
<h2>Pricing</h2>
<p>Tea costs 4 euros a pack.</p>
<ul><li>Green tea, 3 euros</li><li>Black tea, 5 euros</li></ul>
<h2>Contact</h2>
<p>Write to us for wholesale prices.</p>
<table><tr><th>Blend</th><th>Price</th></tr><tr><td>Mint</td><td>2 euros</td></tr></table>
</main>`;

// C4: a query returns the matching blocks, each with its nearest heading, in page order
const byPrice = text({ query: 'price' }), byEuros = text({ query: 'euros' });
ok('query: the matching paragraph and table row, under their nearest headings', byPrice.text === '## Contact\n\nWrite to us for wholesale prices.\n\n| Blend | Price |', JSON.stringify(byPrice.text));
ok('query: list items and table rows, under their headings, in page order', byEuros.text === '## Pricing\n\nTea costs 4 euros a pack.\n\n- Green tea, 3 euros\n\n- Black tea, 5 euros\n\n## Contact\n\n| Mint | 2 euros |', JSON.stringify(byEuros.text));
ok('query: case does not matter', text({ query: 'PRICE' }).text === byPrice.text && text({ query: 'Euros' }).text === byEuros.text);
ok('query: words under 3 letters are ignored', text({ query: 'a euros' }).text === byEuros.text && text({ query: 'of an to is' }).text.startsWith('No part of the page matches "of an to is".'));
const none = text({ query: 'zebra' });
ok('query: no match gives the exact line, then the headings', none.text === 'No part of the page matches "zebra".\n\n# Shop\n## Pricing\n## Contact' && none.truncated === false, JSON.stringify(none.text));

// C4: max_chars cuts the result (1,000 is the least it takes)
let more = '';
for (let i = 0; i < 30; i++) more += `<p>Tea ${i} costs ${i} euros in the long list of teas we stock.</p>`;
d.body.insertAdjacentHTML('beforeend', `<section>${more}</section>`);
const cut = text({ query: 'euros', max_chars: 1000 }), whole = text({ query: 'euros', max_chars: 200000 });
ok('query: max_chars cuts the result, and says so', cut.text.length === 1000 && cut.truncated === true && whole.text.startsWith(cut.text) && whole.truncated === false, `${cut.text.length} ${cut.truncated}`);
// C4: no match lists at most the first 40 headings, in page order
let sections = '';
for (let i = 1; i <= 50; i++) sections += `<h3>Part ${i}</h3><p>Text ${i}.</p>`;
d.body.insertAdjacentHTML('beforeend', sections);
const many = headingsOf(text({ query: 'zebra' }).text);
ok('query: no match lists 40 headings at most, in page order', many.length === 40 && many[0] === '# Shop' && many[39] === '### Part 37', `${many.length} ${many[39]}`);
// C4: a normal read is 40,000 characters a part
let long = '';
for (let i = 0; i < 800; i++) long += `<p>Paragraph ${i} of a very long page, with plain words about nothing in particular.</p>`;
d.body.insertAdjacentHTML('beforeend', `<section>${long}</section>`);
const plain = text({});
ok('a normal read still gives 40,000 characters a part', plain.truncated === true && plain.text.length > 39000 && plain.text.length < 41000, String(plain.text.length));
// C4 and C15 through lib/pageTools.js: the tab, the page op and captureTab are stubbed. A call that throws is a FAIL, not a crash.
const pageCalls = [], shots = [];
const tools = vm.createContext({ console, setTimeout, browser: { tabs: { captureTab: async (id, opts) => { shots.push({ id, opts }); return 'data:image/jpeg;base64,AAAA'; } } } });
vm.runInContext(fs.readFileSync(EXT + 'lib/pageTools.js', 'utf8'), tools, { filename: 'pageTools.js' });
const tab = { id: 7, url: 'https://shop.example/', title: 'Shop' };
Object.assign(tools, {
  cfxPageTab: async () => tab,
  cfxGatedTab: async () => ({ tab, gate: { blocked: false, about: false } }),
  cfxGoogleExport: async () => null,
  cfxPdfOf: async () => null,
  cfxInPage: async (t, op, args) => { pageCalls.push({ op, args }); return op === 'viewport' ? { width: 800, height: 600, scroll_y: 0 } : { title: 'Shop', url: tab.url, text: 'text' }; },
});
const T = vm.runInContext('CFX_TOOLS', tools);
const safe = async f => { try { return await f(); } catch (e) { return { error: String(e.message) }; } };
const lastArgs = () => (pageCalls[pageCalls.length - 1] || { args: {} }).args;
const shotOpts = i => (shots[i] || { opts: {} }).opts;

async function main() {
  await safe(() => T.get_page_text({ tab_id: 7, __army: 'w1' }));
  ok('a worker call without max_chars reads 12,000 characters a part', lastArgs().max_chars === 12000, String(lastArgs().max_chars));
  await safe(() => T.get_page_text({ tab_id: 7 }));
  ok('a normal call reads 40,000 characters a part', lastArgs().max_chars === 40000, String(lastArgs().max_chars));
  await safe(() => T.get_page_text({ tab_id: 7, __army: 'w1', max_chars: 5000 }));
  ok('a worker call that asks for a size keeps it', lastArgs().max_chars === 5000, String(lastArgs().max_chars));
  await safe(() => T.get_page_text({ tab_id: 7, __army: 'w1', query: 'price' }));
  ok('the query reaches the page op with the worker size', lastArgs().query === 'price' && lastArgs().max_chars === 12000);
  const full = await safe(() => T.screenshot({ tab_id: 7 }));
  ok('screenshot asks captureTab for a JPEG at quality 80, scale 1', shotOpts(0).format === 'jpeg' && shotOpts(0).quality === 80 && shotOpts(0).scale === 1, JSON.stringify(shotOpts(0)));
  ok('screenshot returns image/jpeg, with the visible size', full.mimeType === 'image/jpeg' && full.data === 'AAAA' && full.note === 'Visible page is 800x600 CSS px; use these image pixels as click x and y.', JSON.stringify(full));
  const half = await safe(() => T.screenshot({ tab_id: 7, scale: 0.5 }));
  ok('screenshot scale 0.5 is passed to captureTab, as a JPEG at quality 80', shotOpts(1).scale === 0.5 && shotOpts(1).format === 'jpeg' && shotOpts(1).quality === 80, JSON.stringify(shotOpts(1)));
  ok('screenshot at half size gives the exact note', half.note === HALF && half.mimeType === 'image/jpeg', JSON.stringify(half.note));
  const { workerPrompt } = require(HOST + 'chatargs.js');
  const line = workerPrompt({ extraTabs: 2 }).split('\n').find(l => /get_page_text/.test(l)) || '';
  ok('worker prompt: find or analyze_page first, then get_page_text with query', /find or analyze_page first, then get_page_text with query/.test(line) && /whole pages only when needed/.test(line), line);
  const { TOOLS } = require(HOST + 'toolSchemas.js');
  const props = name => (TOOLS.find(t => t.name === name) || { inputSchema: { properties: {} } }).inputSchema.properties;
  ok('schemas: get_page_text takes query; screenshot takes scale 0.5 or 1', (props('get_page_text').query || {}).type === 'string' && JSON.stringify((props('screenshot').scale || {}).enum) === '[1,0.5]');
}
main().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, e => { console.log('FAIL  exception  ' + (e && e.stack || e)); process.exit(1); });
