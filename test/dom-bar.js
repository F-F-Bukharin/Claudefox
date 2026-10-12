'use strict';
// The + menu in an empty chat, in the real panel.html, panel.css and panel.js (jsdom): the starter chips move to the menu's
// right and the menu comes down to their bottom line; when no chip fits beside the menu, the chips hide (the menu still comes down). The layout
// numbers are stubbed the way a browser reports them. Optional DOM test: needs jsdom (npm i --no-save jsdom, or NODE_PATH
// pointing at one). Skips without it.   NODE_PATH=... node test/dom-bar.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(dir);
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
// the real stylesheet, so getComputedStyle sees the rules that move the chips and hide them
const sheet = w.document.createElement('style');
sheet.textContent = fs.readFileSync(dir + 'panel.css', 'utf8');
w.document.head.appendChild(sheet);
const sent = [];
let onMsg;
w.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.11.0' }) },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
};
w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8'));
evalPanel(dom, dir, panelFiles);

const $ = id => w.document.getElementById(id);
const menu = $('moreMenu');
const bar = menu.parentElement;                       // .composer: the starter chips, the text bar and the menu
const starters = bar.querySelector('.starters');
const chips = [...starters.querySelectorAll('.chip')];
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const base = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected', hostVersion: '0.11.0',
  claude: { installed: true, loggedIn: true, email: 'f.work@example.com', plan: 'pro' }, debugPort: 'off', pending: 0, chatModel: 'speed',
  filesMode: 'read', filesFolder: '', watch: false, watchOnLoad: null, watchAsk: null };
const push = s => onMsg({ type: 'state', state: Object.assign({}, base, s), log: [] });
const wait = ms => new Promise(r => setTimeout(r, ms));
const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
const stub = (el, values) => { for (const k of Object.keys(values)) Object.defineProperty(el, k, { configurable: true, value: values[k] }); };
const toggle = () => click($('moreBtn'));
// the numbers a browser reports: the menu at left 12px and 230px wide; the chips in a composer `composer` px wide
// (12px padding each side), 16px from its top, 28px tall; the widest chip is 120px
function layout(composer = 460) {
  stub(menu, { offsetLeft: 12, offsetWidth: 230 });
  stub(starters, { offsetLeft: 12, offsetTop: 16, offsetWidth: composer - 24, offsetHeight: 28 });
  chips.forEach((c, i) => stub(c, { offsetWidth: [120, 50, 52][i] }));   // Summarize this page, /tabs, /help
}
// nothing is left behind: no class, no custom property and no inline style on the composer
const unset = () => !bar.classList.contains('menu-open') && !bar.classList.contains('chips-hidden')
  && !bar.style.getPropertyValue('--menu-bottom') && !bar.style.getPropertyValue('--chips-ml') && !bar.getAttribute('style');

(async () => {
  try {
    await wait(50);
    push({});
    await wait(10);
    ok('precondition: an empty chat uses the centred layout; the menu starts closed with nothing set', $('page-chat').classList.contains('is-empty') && menu.hidden && unset());

    // (a) an empty chat, with room: the menu comes down to the chips' bottom line
    layout();
    toggle();
    ok('(a) opening the menu in an empty chat adds menu-open to the composer', !menu.hidden && bar.classList.contains('menu-open'));
    ok('(a) the menu bottom lines up with the chips bottom (16 + 28 = 44px)', bar.style.getPropertyValue('--menu-bottom') === '44px', `got '${bar.style.getPropertyValue('--menu-bottom')}'`);

    // (b) the chips sit to the right of the menu: at least 12px from its right edge, a left gap of at least menu width + 12
    const margin = parseFloat(bar.style.getPropertyValue('--chips-ml'));
    const menuRight = menu.offsetLeft + menu.offsetWidth;
    ok('(b) the chips start at least 12px to the right of the menu', starters.offsetLeft + margin - menuRight >= 12, `chips at ${starters.offsetLeft + margin}px, menu ends at ${menuRight}px`);
    ok('(b) the left gap is at least menu width + 12', margin >= menu.offsetWidth + 12, `gap ${margin}px`);
    const cs = w.getComputedStyle(starters);
    ok('(b) the chips are centred in that space and wrap', cs.justifyContent === 'center' && cs.flexWrap === 'wrap', `justify ${cs.justifyContent}, wrap ${cs.flexWrap}`);
    toggle();

    // (c) no room beside the menu for the widest chip: the chips hide (visibility), and the menu still comes down
    layout(340);
    toggle();
    ok('(c) a narrow space beside the menu sets chips-hidden', bar.classList.contains('chips-hidden'));
    ok('(c) the hidden chips keep their place (visibility hidden)', w.getComputedStyle(starters).visibility === 'hidden', `visibility ${w.getComputedStyle(starters).visibility}`);
    ok('(c) and the menu still comes down to the chips\' bottom line', bar.classList.contains('menu-open') && bar.style.getPropertyValue('--menu-bottom') === '44px');
    toggle();

    // (d) closing puts everything back, however the menu closes
    layout(); toggle(); toggle();
    ok('(d) the ^ button closes it and removes the classes and custom properties', menu.hidden && unset());
    layout(); toggle(); key(menu, 'Escape');
    ok('(d) Escape closes it and removes them', menu.hidden && unset());
    layout(); toggle(); click(w.document.body);
    ok('(d) a click outside closes it and removes them', menu.hidden && unset());
    layout(); toggle(); click(menu.querySelector('[data-act="snap"]'));
    ok('(d) choosing an item closes it and removes them', menu.hidden && unset());

    // (f) while it is open, a window resize re-applies the layout
    layout(); toggle();
    layout(340); w.dispatchEvent(new w.Event('resize'));
    ok('(f) a resize while open hides the chips when the space is gone, and the menu stays down', bar.classList.contains('chips-hidden') && bar.classList.contains('menu-open'));
    layout(460); w.dispatchEvent(new w.Event('resize'));
    ok('(f) and brings the menu back down when there is room again', bar.classList.contains('menu-open') && !bar.classList.contains('chips-hidden') && bar.style.getPropertyValue('--menu-bottom') === '44px');
    toggle();
    ok('(f) closing after that leaves nothing behind', menu.hidden && unset());

    // (e) a chat with messages: the chips are not shown, so the menu opens exactly where it does today
    $('input').value = 'hi';
    $('composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await wait(10);
    stub(starters, { offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0 });   // display: none, as a browser reports it
    ok('precondition: the chat has messages and the starter chips are not displayed', !$('page-chat').classList.contains('is-empty') && w.getComputedStyle(starters).display === 'none');
    toggle();
    ok('(e) opening the menu in a chat with messages changes nothing about its position', !menu.hidden && unset());
    toggle();
    ok('(e) and closing it leaves nothing behind', menu.hidden && unset());
  } catch (e) {
    ok('no unexpected errors', false, e.stack);
  } finally {
    console.log(fail ? `\n${fail} check(s) failed` : `\nAll ${pass} checks passed`);
    process.exit(fail ? 1 : 0);
  }
})();
