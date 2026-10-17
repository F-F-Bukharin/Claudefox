'use strict';
// The watch switch, the saved option and the permission card in the real panel.html/panel.js (jsdom). Optional DOM test:
// needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.   NODE_PATH=... node test/dom-watch.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(dir);
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const sent = [];
let onMsg;
w.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.11.0' }) },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
};
w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;');
w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8'));
evalPanel(dom, dir, panelFiles);

const $ = id => w.document.getElementById(id);
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const base = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected',
  debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '', watch: false, watchOnLoad: null, watchAsk: null };
const push = s => onMsg({ type: 'state', state: Object.assign({}, base, s), log: [] });
const wait = ms => new Promise(r => setTimeout(r, ms));
const change = id => $(id).dispatchEvent(new w.Event('change'));
const click = id => $(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

(async () => {
  try {
    await wait(50);
    push({});
    ok('the switch row and the option row sit in the permissions card, after the Unsafe note', $('permCard').contains($('watchToggle')) && $('permCard').contains($('watchOnLoadToggle'))
      && !!($('unsafeNote').compareDocumentPosition($('watchToggle')) & w.Node.DOCUMENT_POSITION_FOLLOWING));
    ok('the card sits in the chat page, hidden', $('page-chat').contains($('watchCard')) && $('watchCard').hidden === true);

    sent.length = 0;
    $('watchToggle').checked = true; change('watchToggle');
    ok('the switch posts setWatch with value true', sent.some(m => m.type === 'setWatch' && m.value === true));
    sent.length = 0;
    $('watchOnLoadToggle').checked = true; change('watchOnLoadToggle');
    ok('the option posts setWatchOnLoad with value true', sent.some(m => m.type === 'setWatchOnLoad' && m.value === true));
    sent.length = 0;
    $('watchToggle').checked = false; change('watchToggle');
    ok('turning the switch off posts setWatch with value false', sent.some(m => m.type === 'setWatch' && m.value === false));

    push({ watch: true });
    ok('watch on checks the switch and the note starts with On.', $('watchToggle').checked === true && /^On\./.test($('watchNote').textContent), $('watchNote').textContent);
    push({ agent: 'stopped' });
    ok('a stopped agent disables the switch', $('watchToggle').disabled === true);
    push({ watch: false });
    ok('watch off says Off. and that Claude asks in the chat', $('watchToggle').checked === false && /^Off\. Claude asks in the chat/.test($('watchNote').textContent), $('watchNote').textContent);
    push({ watchOnLoad: true });
    ok('the saved option on checks its switch', $('watchOnLoadToggle').checked === true);

    sent.length = 0;
    push({ watchAsk: { id: 'w1', source: '<img src=x onerror=alert(1)>' } });
    push({ watchAsk: { id: 'w1', source: '<img src=x onerror=alert(1)>' } });
    ok('a card from the helper shows, with its source as plain text', !$('watchCard').hidden && $('watchCardSource').textContent === '<img src=x onerror=alert(1)>' && $('watchCardSource').querySelector('img') === null);
    ok('the card is shown to the helper once per id', sent.filter(m => m.type === 'watchShown' && m.id === 'w1').length === 1);
    click('watchAllow');
    ok('Allow posts watchAnswer with the card id and allow true', sent.some(m => m.type === 'watchAnswer' && m.id === 'w1' && m.allow === true));
    click('watchDeny');
    ok('Deny posts watchAnswer with allow false', sent.some(m => m.type === 'watchAnswer' && m.id === 'w1' && m.allow === false));
    push({ watchAsk: null });
    ok('no card from the helper hides it', $('watchCard').hidden === true);
  } catch (e) {
    ok('no unexpected errors', false, e.stack);
  } finally {
    console.log(fail ? `\n${fail} check(s) failed` : `\nAll ${pass} checks passed`);
    process.exit(fail ? 1 : 0);
  }
})();
