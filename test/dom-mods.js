'use strict';
// The Mods card and the mods loader in the real panel.html and panel.js (jsdom). The loader's <script> and <link>
// elements are checked, and their load and error events are fired by hand: jsdom does not run them.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const EXT = path.join(__dirname, '..', 'extension') + '/';
const html = fs.readFileSync(EXT + 'panel.html', 'utf8').replace(/<script src="panel.js"><\/script>/, '');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const bare = u => String(u || '').split('?')[0];
const mod = (id, over) => Object.assign({ id, name: id, description: '', panel: true, style: false, enabled: true, broken: '' }, over || {});
const srcOf = el => bare(el.getAttribute('src') || el.getAttribute('href'));
const modErrors = p => p.sent.filter(m => m.type === 'modUpdate');

// One panel in its own window. store is the localStorage the panel sees (the crash marker lives there).
function panel(store = new Map()) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  let onMsg = null;
  w.browser = {
    runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.9.0' }) },
    storage: { session: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  Object.defineProperty(w, 'localStorage', { configurable: true, value: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  } });
  w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
  w.eval(fs.readFileSync(EXT + 'panel.js', 'utf8'));
  const base = { agent: 'active', signedIn: false, native: 'connected', claude: null, debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '', modsKnown: false, mods: [] };
  return {
    w, store, sent,
    $: id => w.document.getElementById(id),
    scripts: () => [...w.document.head.querySelectorAll('script[src^="mods/"]')],
    links: () => [...w.document.head.querySelectorAll('link[href^="mods/"]')],
    state: patch => onMsg({ type: 'state', state: Object.assign({}, base, patch), log: [] }),
  };
}

(async () => {
  // The card: rows, switches and buttons
  {
    const p = panel();
    await tick();
    ok('the Mods card has Check the folder, Reload panel and Turn all mods off', ['modsCheck', 'modsReload', 'modsOff'].every(id => p.$(id) && p.$(id).closest('#modsCard')));
    p.state({});
    ok('before the helper lists the folder, the card says it lists them when connected', p.$('modsList').hidden && /when it is connected/.test(p.$('modsEmpty').textContent));
    p.state({ modsKnown: true, mods: [] });
    ok('no mods yet: the card says so', p.$('modsList').hidden && !p.$('modsEmpty').hidden && /No mods yet/.test(p.$('modsEmpty').textContent));
    p.state({ modsKnown: true, mods: [mod('good', { name: 'Good mod', description: 'Adds a line.' }), mod('bad', { enabled: false, broken: 'boom' })] });
    const rows = [...p.$('modsList').querySelectorAll('li.mod')];
    ok('one row per mod, with its name and description', rows.length === 2 && rows[0].querySelector('.mod-name').textContent === 'Good mod' && rows[0].querySelector('.mod-desc').textContent === 'Adds a line.');
    ok('a mod that is on says On; a stopped one says Stopped, with the reason', rows[0].querySelector('.mod-state').textContent === 'On' && rows[1].querySelector('.mod-state').textContent === 'Stopped: boom' && rows[1].querySelector('.mod-state').classList.contains('bad'));
    ok('each switch matches the saved state', rows[0].querySelector('input.switch').checked && !rows[1].querySelector('input.switch').checked);
    const sw = rows[0].querySelector('input.switch');
    sw.checked = false;
    sw.dispatchEvent(new p.w.Event('change'));
    ok('a switch sends modUpdate with its new state', p.sent.some(m => m.type === 'modUpdate' && m.id === 'good' && m.enabled === false));
    const same = [mod('good'), mod('bad', { enabled: false, broken: 'boom' })];
    p.state({ modsKnown: true, mods: same });
    const first = p.$('modsList').querySelector('li.mod');
    p.state({ modsKnown: true, mods: same });
    ok('an unchanged list keeps its rows, so a switch keeps its focus', p.$('modsList').querySelector('li.mod') === first);
    p.$('modsOff').click();
    ok('Turn all mods off sends modsAllOff', p.sent.some(m => m.type === 'modsAllOff'));
    p.$('modsCheck').click();
    ok('Check the folder asks the helper to list the folder again', p.sent.some(m => m.type === 'modsRefresh'));
  }

  // What loads, and in what order
  {
    const p = panel();
    await tick();
    p.state({ modsKnown: true, mods: [
      mod('styled', { panel: false, style: true }),
      mod('good'),
      mod('off', { enabled: false }),
      mod('stopped', { enabled: false, broken: 'boom' }),
      mod('../evil'),
    ] });
    await tick(10);
    ok('loads only the mods that are on: the style of styled, the script of good', p.links().length === 1 && srcOf(p.links()[0]) === 'mods/styled/style.css' && p.scripts().length === 1 && srcOf(p.scripts()[0]) === 'mods/good/panel.js');
    p.state({ modsKnown: true, mods: [mod('styled', { panel: false, style: true }), mod('good'), mod('late')] });
    await tick(10);
    ok('loads once per page: a list that changes later loads nothing new', p.scripts().length === 1 && p.links().length === 1);
  }
  {
    const p = panel();
    await tick();
    p.state({ modsKnown: true, mods: [mod('first'), mod('second')] });
    await tick(10);
    ok('one mod at a time: the second waits for the first', p.scripts().length === 1 && srcOf(p.scripts()[0]) === 'mods/first/panel.js');
    p.scripts()[0].onload();
    await tick(10);
    ok('the second mod loads once the first has finished', p.scripts().length === 2 && srcOf(p.scripts()[1]) === 'mods/second/panel.js');
  }

  // Errors: a mod that throws, and one that does not load
  {
    const p = panel();
    await tick();
    p.state({ modsKnown: true, mods: [mod('good'), mod('second')] });
    await tick(10);
    const raw = p.scripts()[0].getAttribute('src');
    p.w.dispatchEvent(new p.w.ErrorEvent('error', { message: 'ReferenceError: nope', filename: raw }));
    p.w.dispatchEvent(new p.w.ErrorEvent('error', { message: 'again', filename: raw }));
    ok('an error from a mod turns it off with its message, once', modErrors(p).length === 1 && modErrors(p)[0].id === 'good' && modErrors(p)[0].enabled === false && modErrors(p)[0].broken === 'ReferenceError: nope', JSON.stringify(modErrors(p)));
    p.w.dispatchEvent(new p.w.ErrorEvent('error', { message: 'core', filename: 'moz-extension://x/panel.js' }));
    ok('an error from the panel itself does not turn a mod off', modErrors(p).length === 1);
  }
  {
    const p = panel();
    await tick();
    p.state({ modsKnown: true, mods: [mod('good'), mod('second')] });
    await tick(10);
    p.scripts()[0].onerror();
    await tick(10);
    ok('a mod that does not load is turned off, and the next one still loads', modErrors(p).some(m => m.id === 'good' && /could not be loaded/.test(m.broken)) && p.scripts().length === 2);
  }

  // A crash or a hang while a mod loads
  {
    const store = new Map([['ciz-mods-loading', 'crashy']]);
    const p = panel(store);
    await tick();
    p.state({ modsKnown: true, mods: [mod('crashy'), mod('fine')] });
    await tick(10);
    ok('a mod that was loading when the panel stopped is turned off and skipped', modErrors(p).some(m => m.id === 'crashy' && m.enabled === false && /stopped while this mod was loading/.test(m.broken)) && p.scripts().length === 1 && srcOf(p.scripts()[0]) === 'mods/fine/panel.js');
    ok('while the next mod loads, the marker names it', store.get('ciz-mods-loading') === 'fine');
    p.scripts()[0].onload();
    await tick(10);
    ok('the marker is cleared once a mod has loaded', !store.has('ciz-mods-loading'));
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL  the test stopped: ' + (e && e.message)); process.exit(1); });
