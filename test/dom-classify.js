'use strict';
// Page classify (A2): what a click, an Enter or a submitting type_text on a target would do: post a form, leave the site.
// DOM test (jsdom): needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(EXT + 'lib/policy.js', 'utf8') + '\n' + ['pageOp.js', 'pageOpRead.js', 'pageOpAct.js'].map(f => fs.readFileSync(EXT + 'lib/' + f, 'utf8')).join('\n');
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://shop.example/', runScripts: 'outside-only' });
const w = dom.window, d = w.document;
w.Element.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 });
Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
let scrolls = 0; w.Element.prototype.scrollIntoView = () => { scrolls++; };
// the injected page code (cfxPageCode) run in the jsdom window, the way executeScript runs it
const ctx = vm.createContext({ URL });
vm.runInContext(src + ';this.cfxPageCode=cfxPageCode;', ctx);
const run = (op, args) => w.eval(ctx.cfxPageCode(op, args));
// The answer as plain JSON (the page's objects come from another realm). An error comes back as { error }.
const cls = args => { try { return JSON.parse(JSON.stringify(run('classify', args))); } catch (e) { return { error: String(e.message) }; } };
// Expected: posts or not, the site it leaves to (null for none), and whether the target was found.
const is = (r, post, leaves, found = true) => r.submitsPost === post && r.leavesTo === leaves && r.found === found;

d.body.innerHTML = `
<form id=f-post method=post action="/buy">
  <button id=buy>Buy</button> <button id=buy-icon><span id=buy-span>Buy</span></button> <input id=q-post name=q> <textarea id=ta-post></textarea>
  <input type=submit id=isub value="Send"> <input type=image id=iimg src="go.png" alt="Go">
  <button type=button id=tbtn>Toggle</button> <input type=button id=ibtn value="Show">
  <button formmethod=get id=fm-get>Look</button>
</form>
<form id=f-get method=get action="/search">
  <button id=search>Search</button> <input id=q-get name=q>
  <button formmethod=post id=fm-post>Pay</button> <button formmethod=POST id=fm-upper>Pay now</button>
</form>
<form id=f-none action="/s"><button id=nomethod>Go</button></form>
<form id=f-upper method=POST action="/buy2"><button id=upper>Buy again</button></form>
<form id=f-ext method=post action="https://pay.example/checkout"><button id=ext-buy>Pay elsewhere</button></form>
<button id=outside form=f-post>Outside</button>
<button id=nofrm>Loose</button>
<a id=l-other href="https://other.example/page">Other site</a>
<a id=l-yt href="https://www.YouTube.com/watch?v=1">Video</a>
<a id=l-www href="https://www.shop.example/x">Same site, www</a>
<a id=l-rel href="/x">Relative</a>
<a id=l-js href="javascript:void(0)">Menu</a>
<a id=l-span href="https://other.example/inner"><span id=sp>Inner text</span></a>`;

// A submit control posts when its form does; formmethod on the control wins over the form's method.
ok('submit button in a POST form posts', is(cls({ selector: '#buy' }), true, null));
ok('a span inside a POST form\'s submit button posts', is(cls({ selector: '#buy-span' }), true, null));
ok('GET form: its button does not post', is(cls({ selector: '#search' }), false, null));
ok('form with no method is GET', is(cls({ selector: '#nomethod' }), false, null));
ok('formmethod=post on the button over a GET form posts', is(cls({ selector: '#fm-post' }), true, null));
ok('formmethod=POST is read in any case', is(cls({ selector: '#fm-upper' }), true, null));
ok('formmethod=get on the button wins over a POST form', is(cls({ selector: '#fm-get' }), false, null));
ok('method=POST is read in any case', is(cls({ selector: '#upper' }), true, null));
ok('input type=submit in a POST form posts', is(cls({ selector: '#isub' }), true, null));
ok('input type=image in a POST form posts', is(cls({ selector: '#iimg' }), true, null));
ok('button type=button does not post', is(cls({ selector: '#tbtn' }), false, null));
ok('input type=button does not post', is(cls({ selector: '#ibtn' }), false, null));
ok('button outside any form does not post', is(cls({ selector: '#nofrm' }), false, null));
ok('button with form= posts through the form it names', is(cls({ selector: '#outside' }), true, null));
ok('a POST form to another site posts, and leavesTo stays null', is(cls({ selector: '#ext-buy' }), true, null));
// Enter, or type_text with submit, in a field posts when the field's form does.
ok('Enter in a text field of a POST form posts', is(cls({ selector: '#q-post', key: 'Enter' }), true, null));
ok('type_text with submit posts from a POST form', is(cls({ selector: '#q-post', text: 'abc', submit: true }), true, null));
ok('Enter in a textarea of a POST form counts (the safe side)', is(cls({ selector: '#ta-post', key: 'Enter' }), true, null));
ok('Enter in a GET form does not post', is(cls({ selector: '#q-get', key: 'Enter' }), false, null));
ok('a click on a text field does not post', is(cls({ selector: '#q-post' }), false, null));
ok('Enter on a type=button does not post', is(cls({ selector: '#tbtn', key: 'Enter' }), false, null));
ok('the answer has three fields and no field values', Object.keys(cls({ selector: '#q-post', key: 'Enter' })).sort().join() === 'found,leavesTo,submitsPost');
// A link leaves the site when its site differs from the page's (lowercase host, one leading www. dropped).
ok('link to another site: its site', is(cls({ selector: '#l-other' }), false, 'other.example'));
ok('link to www.YouTube.com: youtube.com', is(cls({ selector: '#l-yt' }), false, 'youtube.com'));
ok('link to www. of the same site: null', is(cls({ selector: '#l-www' }), false, null));
ok('relative link: null', is(cls({ selector: '#l-rel' }), false, null));
ok('javascript: link: null', is(cls({ selector: '#l-js' }), false, null));
ok('span inside a link: the link site', is(cls({ selector: '#sp' }), false, 'other.example'));
ok('Enter on a link: the link site', is(cls({ selector: '#l-other', key: 'Enter' }), false, 'other.example'));
// The lookup: a ref from read_page, a point, the focused element; and what is not found.
const buyRef = (/button "Buy"[^\n]*\[(ref_\d+)\]/.exec(run('read', {}).text) || [])[1];
ok('ref from read_page finds the submit button', !!buyRef && is(cls({ ref: buyRef }), true, null), String(buyRef));
d.elementFromPoint = () => d.getElementById('l-other');
ok('x,y: the element under the point', is(cls({ x: 5, y: 5 }), false, 'other.example'));
d.elementFromPoint = () => null;
ok('x,y over nothing: not found', is(cls({ x: 5, y: 5 }), false, null, false));
delete d.elementFromPoint;
d.getElementById('q-post').focus();
ok('Enter with no target: the focused field', is(cls({ key: 'Enter' }), true, null));
d.getElementById('q-post').blur();
ok('Enter with no target and nothing focused: not found', is(cls({ key: 'Enter' }), false, null, false));
ok('missing selector: not found', is(cls({ selector: '#nope' }), false, null, false));
ok('stale ref: not found', is(cls({ ref: 'ref_999999' }), false, null, false));
ok('bad selector: not found', is(cls({ selector: '##' }), false, null, false));
// classify only reads: no click, submit, focus, input or change event, no scroll, and the same focus, value and URL.
const seen = []; for (const t of ['click', 'submit', 'focus', 'input', 'change']) d.addEventListener(t, e => seen.push(e.type), true);
d.getElementById('q-post').focus(); seen.length = 0; scrolls = 0;
const focusBefore = d.activeElement, urlBefore = w.location.href, valueBefore = d.getElementById('q-post').value;
const outs = ['#buy', '#ext-buy', '#l-other', '#q-post', '#ta-post'].map(s => cls({ selector: s, key: 'Enter' }));
ok('classify changes nothing', outs.every(r => r.found === true) && seen.length === 0 && scrolls === 0 && d.activeElement === focusBefore && w.location.href === urlBefore && d.getElementById('q-post').value === valueBefore, seen.join(',') + ' scrolls=' + scrolls);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
