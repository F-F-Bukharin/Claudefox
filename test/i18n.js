'use strict';
// Portuguese (Brazil), E11: the two language files, extension/lib/i18n.js (t() and the language pick), panel.html's
// data-i18n coverage, and the Language row in Settings. Every later wave-6 worker runs this file too, so a key added to one
// language only, or a $n that differs between the two, shows up here.   node test/i18n.js
// Needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one); skips without it, like the other DOM tests.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { load, pseudo, SKIP_TEXT } = require('./lib/locales');
const { panelPage, evalPanel } = require('./lib/panel-scripts');

const root = path.join(__dirname, '..');
const EXT = path.join(root, 'extension') + path.sep;
// A friends copy has no tools\ folder and is branded already, so the C5 texts (Zen) and the brand step run in the source tree only.
const SOURCE_TREE = fs.existsSync(path.join(root, 'tools', 'brand.js'));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); } };
const tick = (ms = 15) => new Promise(r => setTimeout(r, ms));

// ---------- the two files ----------
const PREFIXES = ['ui', 'lang', 'main', 'set', 'hist', 'chat', 'stream', 'bg'];
const files = {};
for (const l of ['en', 'pt_BR']) {
  const p = path.join(EXT, '_locales', l, 'messages.json');
  files[l] = fs.existsSync(p) ? fs.readFileSync(p) : null;
}
let data = null;
try { data = load(); } catch (e) { ok('both messages.json files exist and parse', false, e.message); }
if (data) {
  ok('both messages.json files parse', true);
  for (const l of ['en', 'pt_BR']) {
    const buf = files[l], text = buf.toString('utf8');
    ok(`${l}: UTF-8 with no BOM`, !(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) && !text.includes('�'));
    const lines = text.replace(/\n$/, '').split('\n');
    const inner = lines.slice(1, -1);
    ok(`${l}: the file is a { ... } with one entry per line, 2-space indent, "message" only`, lines[0] === '{' && lines[lines.length - 1] === '}'
      && inner.every((ln, i) => {
        const m = /^ {2}"([A-Za-z0-9_]+)": \{ "message": ("(?:[^"\\]|\\.)*") \}(,?)$/.exec(ln);
        if (!m) return false;
        try { JSON.parse(m[2]); } catch { return false; }
        return m[3] === (i === inner.length - 1 ? '' : ',');
      }), inner.find(ln => !/^ {2}"[A-Za-z0-9_]+": \{ "message": ".*" \},?$/.test(ln)));
    ok(`${l}: no CRLF`, !text.includes('\r'));
  }
  const enKeys = Object.keys(data.en), ptKeys = Object.keys(data.pt_BR);
  ok('every key is in both files', enKeys.filter(k => !(k in data.pt_BR)).concat(ptKeys.filter(k => !(k in data.en))).length === 0,
    enKeys.filter(k => !(k in data.pt_BR)).concat(ptKeys.filter(k => !(k in data.en))).join(', '));
  ok('both files list their keys in the same order (the manager merges blocks by key)', enKeys.join() === ptKeys.join());
  const bad = enKeys.filter(k => !/^[A-Za-z0-9_]+$/.test(k) || !PREFIXES.includes(k.split('_')[0]) || !k.includes('_'));
  ok('keys are <prefix>_<camelCase> with a known prefix', bad.length === 0, bad.join(', '));
  const seen = new Map(), clash = [];
  for (const k of enKeys) { const lo = k.toLowerCase(); if (seen.has(lo)) clash.push(seen.get(lo) + ' / ' + k); else seen.set(lo, k); }
  ok('no two keys differ only in case', clash.length === 0, clash.join(', '));
  for (const l of ['en', 'pt_BR']) {
    const empty = Object.keys(data[l]).filter(k => typeof data[l][k].message !== 'string' || !data[l][k].message.trim()
      || Object.keys(data[l][k]).join() !== 'message');
    ok(`${l}: no empty message, no description or placeholders field`, empty.length === 0, empty.join(', '));
    const dollar = Object.keys(data[l]).filter(k => /\$[A-Za-z_]\w*\$/.test(data[l][k].message));
    ok(`${l}: no $word$ pattern (Firefox reads it as a placeholder)`, dollar.length === 0, dollar.join(', '));
    const stray = Object.keys(data[l]).filter(k => /\$/.test(data[l][k].message.replace(/\$\$|\$[1-9]/g, '')));
    ok(`${l}: every dollar sign is $$ or $1 to $9`, stray.length === 0, stray.join(', '));
  }
  const subs = m => [...new Set([...m.replace(/\$\$/g, '').matchAll(/\$([1-9])/g)].map(x => x[1]))].sort().join('');
  const sdiff = enKeys.filter(k => data.pt_BR[k] && subs(data.en[k].message) !== subs(data.pt_BR[k].message));
  ok('the same $n in English and Portuguese for every key', sdiff.length === 0, sdiff.join(', '));
  const copied = enKeys.filter(k => data.pt_BR[k] && data.pt_BR[k].message === data.en[k].message
    && /\s/.test(data.en[k].message.trim()) && !SKIP_TEXT.test(data.en[k].message.trim()));
  ok('a Portuguese message equal to its English is only a single word or a brand/symbol text (no copied English)', copied.length === 0, copied.join(', '));
  if (SOURCE_TREE) ok('the reserved keys of contract C5 are there with their exact texts', [
    ['ui_emptyTitle', 'What should I do in Zen?', 'O que devo fazer no Zen?'],
    ['ui_signedOutText', 'Uses the claude.ai session already open in Zen. Sign in to claude.ai in a normal tab first, then click below. Zen remembers it after that, until you sign out here or on claude.ai.',
      'Usa a sessão do claude.ai já aberta no Zen. Entre no claude.ai em uma aba normal primeiro e depois clique abaixo. O Zen se lembra disso depois, até você sair aqui ou no claude.ai.'],
    ['ui_usingZenNow', 'Using Zen now', 'Usando o Zen agora'],
    ['ui_panelPlace', 'The panel docks on the right. Open and close it with the toolbar button or', 'O painel fica à direita. Abra e feche pelo botão da barra de ferramentas ou com'],
    ['ui_panelPlaceEnd', ". Zen's title bar above the panel is hidden, so the panel has no header menu. Drag the sidebar's inner edge to make it wider.",
      '. A barra de título do Zen acima do painel fica oculta, então o painel não tem menu no cabeçalho. Arraste a borda interna da barra lateral para deixá-lo mais largo.'],
    ['main_signInHint', 'Sign in to claude.ai in a normal tab, then press Sign in. Zen remembers it after that.',
      'Entre no claude.ai em uma aba normal e depois clique em Entrar. O Zen se lembra disso depois.'],
    ['main_unsafeOn', 'On. Claude may act on Google sign-in pages until you press Stop or restart Zen.',
      'Ativado. O Claude pode agir nas páginas de login do Google até você clicar em Parar ou reiniciar o Zen.'],
    ['main_acctDiffers', '$1The chat spends this Claude Code account, which differs from the claude.ai account signed in to Zen.',
      '$1A conversa usa esta conta do Claude Code, que é diferente da conta do claude.ai conectada no Zen.'],
  ].every(([k, en, pt]) => data.en[k] && data.pt_BR[k] && data.en[k].message === en && data.pt_BR[k].message === pt));
  // Automatic mode replaced the Trusted switch: the keys keep their names, the texts changed.
  ok('Automatic switch: the label is Automatic / Modo automático', data.en.ui_trusted.message === 'Automatic' && data.pt_BR.ui_trusted.message === 'Modo automático');
  ok('Automatic switch: the English note lists what it answers and what stays off-limits', data.en.ui_trustedNote.message
    === 'Claude answers Yes by itself to the questions about pictures, other sites, form sends, uploads, form filling and folders. Google sign-in pages, blocked sites and protected folders stay off-limits. Pages can try to steer it.');
  ok('Automatic switch: the Portuguese note says the same', data.pt_BR.ui_trustedNote.message
    === 'O Claude responde Sim sozinho às perguntas sobre imagens, outros sites, envio de formulários, arquivos, preenchimento de formulários e pastas. As páginas de login do Google, os sites bloqueados e as pastas protegidas continuam fora do alcance. As páginas podem tentar influenciá-lo.');
  ok('no visible text still says Trusted or Modo confiável', !Object.values(data.en).some(v => /\bTrusted\b/.test(v.message)) && !Object.values(data.pt_BR).some(v => /confiável/i.test(v.message)));
  ok('the Language row has its keys (lang_label, lang_auto), Auto translated', !!(data.en.lang_label && data.pt_BR.lang_label && data.en.lang_auto.message === 'Auto'
    && data.pt_BR.lang_auto.message === 'Automático'));

  // The friends build: contract C5, through the real brand step on a copy of extension\. Source tree only (see SOURCE_TREE).
  if (SOURCE_TREE) {
    const brand = require(path.join(root, 'tools', 'brand.js'));
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-i18n-brand-'));
    try {
      fs.cpSync(path.join(root, 'extension'), path.join(stage, 'extension'), { recursive: true });
      for (const sub of ['mods', 'output']) {
        const d = path.join(stage, 'extension', sub);
        if (fs.existsSync(d)) for (const n of fs.readdirSync(d)) if (n !== 'README.txt') fs.rmSync(path.join(d, n), { recursive: true, force: true });
      }
      // Only the extension is staged here, so the rules for host\ files find nothing; test/brand.js stages everything.
      const problems = brand.brand(stage).filter(p => !/^no match for/.test(p) || /_locales/.test(p));
      ok('the friends build brands the language files with no problem', problems.length === 0, problems.join(' | '));
      const fr = {};
      for (const l of ['en', 'pt_BR']) fr[l] = JSON.parse(fs.readFileSync(path.join(stage, 'extension', '_locales', l, 'messages.json'), 'utf8'));
      const m = (l, k) => (fr[l][k] || {}).message || '';
      ok('friends, English: Firefox in the C5 texts', m('en', 'ui_emptyTitle') === 'What should Claude do in Firefox?'
        && m('en', 'ui_signedOutText').includes('already open in Firefox.') && m('en', 'ui_signedOutText').includes('Firefox remembers it after that,')
        && m('en', 'ui_usingZenNow') === 'Using Firefox now'
        && m('en', 'ui_panelPlace') === 'The panel opens in the sidebar. Open and close it with the toolbar button or'
        && m('en', 'ui_panelPlaceEnd') === ". Drag the sidebar's inner edge to make it wider."
        && m('en', 'main_signInHint').includes('then press Sign in. Firefox remembers it after that.')
        && m('en', 'main_unsafeOn').endsWith('until you press Stop or restart Firefox.')
        && m('en', 'main_acctDiffers').endsWith('the claude.ai account signed in to Firefox.'));
      ok('friends, Portuguese: Firefox in the C5 texts', m('pt_BR', 'ui_emptyTitle') === 'O que o Claude deve fazer no Firefox?'
        && m('pt_BR', 'ui_signedOutText').includes('já aberta no Firefox.') && m('pt_BR', 'ui_signedOutText').includes('O Firefox se lembra disso depois')
        && m('pt_BR', 'ui_usingZenNow') === 'Usando o Firefox agora'
        && m('pt_BR', 'ui_panelPlace') === 'O painel abre na barra lateral. Abra e feche pelo botão da barra de ferramentas ou com'
        && m('pt_BR', 'ui_panelPlaceEnd') === '. Arraste a borda interna da barra lateral para deixá-lo mais largo.'
        && m('pt_BR', 'main_signInHint').includes('O Firefox se lembra disso depois.')
        && m('pt_BR', 'main_unsafeOn').endsWith('ou reiniciar o Firefox.')
        && m('pt_BR', 'main_acctDiffers').endsWith('conectada no Firefox.'));
      const zenLeft = Object.keys(fr.pt_BR).filter(k => /\bZen\b/.test(fr.pt_BR[k].message));
      ok('friends, Portuguese: no message still says Zen', zenLeft.length === 0, zenLeft.join(', '));
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
}

// ---------- the manifest and the page's script tags ----------
const manifest = JSON.parse(fs.readFileSync(EXT + 'manifest.json', 'utf8'));
ok('manifest: default_locale is en', manifest.default_locale === 'en');
ok('manifest: lib/i18n.js is the first background script', manifest.background.scripts[0] === 'lib/i18n.js');
const panelHtml = fs.readFileSync(EXT + 'panel.html', 'utf8');
const tagAt = s => panelHtml.indexOf(`<script src="${s}"></script>`);
ok('panel.html loads lib/i18n.js before lib/markdown.js and panel.js, and panel-lang.js after panel.js',
  tagAt('lib/i18n.js') > 0 && tagAt('lib/i18n.js') < tagAt('lib/markdown.js') && tagAt('lib/markdown.js') < tagAt('panel.js') && tagAt('panel.js') < tagAt('panel-lang.js'));

// ---------- t() and the language pick, in a vm ----------
const src = fs.readFileSync(EXT + 'lib/i18n.js', 'utf8');
const FAKE = {
  en: { hello: { message: 'Hello $1' }, onlyEn: { message: 'Only English' }, money: { message: 'Costs $$5 for $1 and $2' } },
  pt_BR: { hello: { message: 'Olá $1' }, money: { message: 'Custa $$5 por $2 e $1' } },
};
// A page-like global with the pieces a test gives it; anything it does not give, the file must live without.
function boot(g = {}, { fake = FAKE } = {}) {
  const ctx = vm.createContext(Object.assign({ console }, fake ? { CFX_LOCALES: fake } : {}, g));
  vm.runInContext(src, ctx, { filename: 'lib/i18n.js' });
  return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);
function fakeStorage(initial) {
  const s = { saved: initial, sets: [], listeners: [], area: {} };
  s.area = {
    get: async () => (s.saved === undefined ? {} : { lang: s.saved }),
    set: async o => { s.sets.push(o); if ('lang' in o) s.saved = o.lang; },
  };
  return s;
}
function fakeLocal(initial) {
  const m = new Map(initial === undefined ? [] : [['ciz-lang', initial]]);
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}
function pageGlobals({ ui, nav, local, stored } = {}) {
  const st = fakeStorage(stored);
  const browser = { storage: { local: st.area, onChanged: { addListener: f => st.listeners.push(f) } }, runtime: { getURL: p => 'moz-extension://x/' + p } };
  if (ui !== undefined) browser.i18n = { getUILanguage: () => ui };
  const g = { browser, localStorage: fakeLocal(local), navigator: { language: nav || 'en-US' } };
  return { g, st };
}

(async () => {
  {
    const c = boot({});
    ok('t(): the English message, with $1 and $2', run(c, "t('hello', 'F')") === 'Hello F' && run(c, "t('money', 'a', 'b')") === 'Costs $5 for a and b');
    run(c, "cfxI18n.use('pt_BR')");
    ok('t(): after use(pt_BR) the Portuguese message, and $n in the order Portuguese needs', run(c, "t('hello', 'F')") === 'Olá F' && run(c, "t('money', 'a', 'b')") === 'Custa $5 por b e a');
    ok('t(): a key missing in Portuguese falls back to English', run(c, "t('onlyEn')") === 'Only English');
    ok('t(): an unknown key returns itself', run(c, "t('no_such_key')") === 'no_such_key');
    ok('t(): a substitution is taken as plain text ($& and $$ in it stay as they are)', run(c, "t('hello', '$& $$')") === 'Olá $& $$');
    ok('t(): a missing substitution leaves nothing odd behind', run(c, "t('hello')") === 'Olá ');
    ok('cfxI18n: LANGS, has(), and use() with an unknown language falls back to en', run(c, 'JSON.stringify(cfxI18n.LANGS)') === '["en","pt_BR"]'
      && run(c, "cfxI18n.has('hello') && !cfxI18n.has('nope')") === true && (run(c, "cfxI18n.use('xx'); cfxI18n.lang()") === 'en'));
  }
  {
    const c = boot({}, { fake: null });
    ok('with no texts at all (no CFX_LOCALES, no XMLHttpRequest, nothing) it loads and t() returns the key', run(c, "t('ui_x')") === 'ui_x' && run(c, 'cfxI18n.lang()') === 'en'
      && run(c, 'cfxI18n.setting()') === 'auto' && run(c, "cfxI18n.has('ui_x')") === false);
    {
      const d = new JSDOM('<p data-i18n="ui_x" data-i18n-title="ui_y" title="Tip">English text</p>', { runScripts: 'outside-only' });
      new vm.Script(src, { filename: 'lib/i18n.js' }).runInContext(d.getInternalVMContext());
      const p = d.window.document.querySelector('p');
      ok('with no texts, the load-time apply() leaves the page text alone (an English fallback beats a key)', p.textContent === 'English text' && p.getAttribute('title') === 'Tip');
    }
  }
  {
    const files2 = { '_locales/en/messages.json': JSON.stringify(FAKE.en), '_locales/pt_BR/messages.json': JSON.stringify(FAKE.pt_BR) };
    const urls = [];
    function XHR() { }
    XHR.prototype.open = function (m, u, async) { this.u = u; this.async = async; urls.push(u); };
    XHR.prototype.send = function () { const k = this.u.replace('moz-extension://x/', ''); this.status = files2[k] ? 200 : 404; this.responseText = files2[k] || ''; };
    const { g } = pageGlobals({ ui: 'pt-BR' });
    const c = boot(Object.assign(g, { XMLHttpRequest: XHR }), { fake: null });
    ok('without CFX_LOCALES the texts come from a synchronous read of both files through browser.runtime.getURL',
      urls.length === 2 && urls.every(u => /^moz-extension:\/\/x\/_locales\/(en|pt_BR)\/messages\.json$/.test(u)) && run(c, "t('hello', 'F')") === 'Olá F');
  }
  for (const [ui, expect] of [['pt-BR', 'pt_BR'], ['pt-PT', 'pt_BR'], ['pt', 'pt_BR'], ['en-US', 'en'], ['es', 'en']]) {
    const { g } = pageGlobals({ ui });
    const c = boot(g);
    ok(`auto: browser language ${ui} gives ${expect}`, run(c, 'cfxI18n.lang()') === expect && run(c, 'cfxI18n.setting()') === 'auto');
  }
  {
    const { g } = pageGlobals({ nav: 'pt-BR' });
    delete g.browser.i18n;
    ok('auto: navigator.language is used when browser.i18n is missing', run(boot(g), 'cfxI18n.lang()') === 'pt_BR');
    const h = pageGlobals({ nav: 'en-GB' }).g; delete h.browser;
    ok('auto: and with no browser at all', run(boot(h), 'cfxI18n.lang()') === 'en');
  }
  {
    const { g } = pageGlobals({ ui: 'en-US', local: 'pt_BR' });
    const c = boot(g);
    ok("localStorage 'ciz-lang' at load decides, before storage.local answers", run(c, 'cfxI18n.lang()') === 'pt_BR' && run(c, 'cfxI18n.setting()') === 'pt_BR');
    const e = pageGlobals({ ui: 'pt-BR', local: 'en' }).g;
    ok('a saved en wins over a Portuguese browser', run(boot(e), 'cfxI18n.lang()') === 'en' && run(boot(e), 'cfxI18n.setting()') === 'en');
    const u = pageGlobals({ ui: 'pt-BR', local: 'klingon' }).g;
    ok('an unknown saved value counts as auto', run(boot(u), 'cfxI18n.setting()') === 'auto' && run(boot(u), 'cfxI18n.lang()') === 'pt_BR');
  }
  {
    const { g, st } = pageGlobals({ ui: 'en-US', local: 'en', stored: 'pt_BR' });
    const c = boot(g);
    const seen = []; c.__cb = l => seen.push(l); run(c, 'cfxI18n.onChange(__cb)');
    await tick();
    ok('storage.local lang that differs from the localStorage one switches the language and fires onChange', run(c, 'cfxI18n.lang()') === 'pt_BR'
      && run(c, 'cfxI18n.setting()') === 'pt_BR' && seen.join() === 'pt_BR', seen.join());
    ok('and keeps it in localStorage for the next synchronous start', g.localStorage.map.get('ciz-lang') === 'pt_BR');
    void st;
  }
  {
    const { g } = pageGlobals({ ui: 'en-US', local: 'pt_BR', stored: 'pt_BR' });
    const c = boot(g); const seen = []; c.__cb = l => seen.push(l); run(c, 'cfxI18n.onChange(__cb)');
    await tick();
    ok('equal saved values change nothing and fire nothing', seen.length === 0 && run(c, 'cfxI18n.lang()') === 'pt_BR');
    const n = pageGlobals({ ui: 'en-US' }).g;
    const d = boot(n); d.__cb = () => { throw new Error('should not fire'); }; run(d, 'cfxI18n.onChange(__cb)'); run(d, "cfxI18n.use('pt_BR')");
    await tick();
    ok('when neither is saved, a language a test chose with use() stays', run(d, 'cfxI18n.lang()') === 'pt_BR');
  }
  {
    const { g, st } = pageGlobals({ ui: 'en-US' });
    const c = boot(g); const seen = []; c.__cb = l => seen.push(l); run(c, 'cfxI18n.onChange(__cb)');
    const p = run(c, "cfxI18n.set('pt_BR')");
    ok('set() returns a promise', p && typeof p.then === 'function');
    await p; await tick();
    ok('set() saves storage.local lang and localStorage ciz-lang, switches, and calls onChange once', st.sets.some(o => o.lang === 'pt_BR') && g.localStorage.map.get('ciz-lang') === 'pt_BR'
      && run(c, 'cfxI18n.lang()') === 'pt_BR' && run(c, 'cfxI18n.setting()') === 'pt_BR' && seen.join() === 'pt_BR', seen.join());
    for (const f of st.listeners) f({ lang: { newValue: 'pt_BR' } }, 'local');
    ok("the page's own save coming back through storage.onChanged does not fire onChange twice", seen.length === 1, seen.join());
    for (const f of st.listeners) f({ lang: { newValue: 'en' } }, 'local');
    ok('storage.onChanged from another page switches the language and fires onChange', run(c, 'cfxI18n.lang()') === 'en' && seen.join() === 'pt_BR,en', seen.join());
    for (const f of st.listeners) { f({ lang: { newValue: 'pt_BR' } }, 'sync'); f({ other: { newValue: 'x' } }, 'local'); }
    ok('another storage area or another key is ignored', seen.length === 2 && run(c, 'cfxI18n.lang()') === 'en');
    await run(c, "cfxI18n.set('auto')");
    ok("set('auto') follows the browser language again", run(c, 'cfxI18n.setting()') === 'auto' && run(c, 'cfxI18n.lang()') === 'en');
  }
  {
    // Nothing at all: no browser, no localStorage, no navigator, no XMLHttpRequest, no document.
    let threw = null, c = null;
    try { c = vm.createContext({}); vm.runInContext(src, c, { filename: 'lib/i18n.js' }); } catch (e) { threw = e; }
    ok('with an empty global object (no browser, localStorage, navigator, XMLHttpRequest or document) it loads', !threw, threw && threw.message);
    ok('and t() returns keys, set() still works', c && run(c, "t('ui_a', 1)") === 'ui_a' && typeof run(c, "cfxI18n.set('pt_BR')").then === 'function');
    ok('and a throwing localStorage / storage does not stop it', (() => {
      const g = { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } },
        browser: { storage: { local: { get() { throw new Error('no'); }, set() { throw new Error('no'); } }, onChanged: { addListener() { throw new Error('no'); } } } } };
      const x = boot(g); return run(x, "t('hello', 'F')") === 'Hello F' && typeof run(x, "cfxI18n.set('pt_BR')").then === 'function';
    })());
  }

  // ---------- panel.html coverage (real files) ----------
  const { html, files: panelFiles } = panelPage(EXT);
  const dom0 = new JSDOM(html);
  const doc0 = dom0.window.document;
  const en = data ? data.en : {};
  const walker = doc0.createTreeWalker(doc0.body, dom0.window.NodeFilter.SHOW_TEXT);
  const naked = [], keysUsed = new Set(), wrong = [], missing = [], mixed = [];
  const own = (el, key) => { keysUsed.add(key); if (!(key in en)) missing.push(key); };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const par = n.parentElement;
    if (par.closest('script, style, svg, template')) continue;
    const txt = n.textContent.trim();
    if (!txt) continue;
    if (par.closest('[data-i18n]')) continue;
    if (SKIP_TEXT.test(txt)) continue;
    naked.push(`${par.id ? '#' + par.id : par.tagName.toLowerCase()}: ${txt.slice(0, 40)}`);
  }
  ok('panel.html: every visible text sits in an element with data-i18n, or needs no translation', naked.length === 0, naked.join(' | '));
  const ATTRS = [['title', 'data-i18n-title'], ['placeholder', 'data-i18n-placeholder'], ['aria-label', 'data-i18n-aria-label']];
  const noTwin = [];
  for (const el of doc0.body.querySelectorAll('*')) {
    if (el.closest('svg')) continue;
    for (const [a, d] of ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.trim() && !el.hasAttribute(d) && !SKIP_TEXT.test(v.trim())) noTwin.push(`${el.id || el.tagName.toLowerCase()}[${a}="${v.slice(0, 30)}"]`);
    }
  }
  ok('panel.html: every title, placeholder and aria-label has its data-i18n-* twin, or needs no translation', noTwin.length === 0, noTwin.join(' | '));
  for (const el of doc0.querySelectorAll('[data-i18n]')) {
    own(el, el.getAttribute('data-i18n'));
    if (el.children.length) mixed.push(el.getAttribute('data-i18n'));
    else if (en[el.getAttribute('data-i18n')] && en[el.getAttribute('data-i18n')].message !== el.textContent) wrong.push(el.getAttribute('data-i18n') + ': ' + JSON.stringify(el.textContent));
  }
  for (const [a, d] of ATTRS) {
    for (const el of doc0.querySelectorAll(`[${d}]`)) {
      const key = el.getAttribute(d);
      own(el, key);
      if (en[key] && en[key].message !== el.getAttribute(a)) wrong.push(`${key}: ${JSON.stringify(el.getAttribute(a))}`);
    }
  }
  ok('panel.html: every data-i18n key exists in the English file', missing.length === 0, missing.join(', '));
  ok('panel.html: a data-i18n element holds only text (a child element would be wiped by apply)', mixed.length === 0, mixed.join(', '));
  ok('panel.html: each English message is the html text or attribute value, byte for byte', wrong.length === 0, wrong.join(' | '));
  const unused = Object.keys(en).filter(k => k.startsWith('ui_') && !keysUsed.has(k));
  ok('every ui_ key is used by panel.html or reserved in contract C5', unused.every(k => ['ui_emptyTitle', 'ui_signedOutText', 'ui_usingZenNow', 'ui_panelPlace', 'ui_panelPlaceEnd'].includes(k)) , unused.join(', '));

  // ---------- the panel in jsdom: English unchanged, Portuguese when asked ----------
  const snap = d => [...d.querySelectorAll('*')].map(el => el.tagName + '|' + (el.children.length ? '' : el.textContent) + '|' + ATTRS.map(([a]) => el.getAttribute(a)).join('|')).join('\n');
  {
    const d = new JSDOM(html, { runScripts: 'outside-only' });
    const before = snap(d.window.document);
    evalPanel(d, EXT, []);
    ok('default options: every DOM text is unchanged English', snap(d.window.document) === before);
  }
  {
    const d = new JSDOM(html, { runScripts: 'outside-only' });
    evalPanel(d, EXT, [], { lang: 'pt_BR' });
    const doc = d.window.document;
    ok('lang pt_BR: #emptyTitle reads its ui_emptyTitle text', doc.getElementById('emptyTitle').textContent === data.pt_BR.ui_emptyTitle.message, doc.getElementById('emptyTitle').textContent);
    ok('lang pt_BR: a placeholder, a title and an aria-label are Portuguese', doc.getElementById('input').placeholder !== 'Message Claude…' && /Mensagem/.test(doc.getElementById('input').placeholder)
      && doc.getElementById('stopBtn').title.startsWith('Parar') && doc.getElementById('histBtn').getAttribute('aria-label') === 'Histórico de conversas');
    ok('lang pt_BR: the Advanced panel note keeps Alt+Shift+C between its two Portuguese halves', (() => {
      const p = doc.querySelector('#advancedBody .sub p');
      const pt = data.pt_BR;   // the note is its two halves (ui_panelPlace, ui_panelPlaceEnd) around the key, as panel.html writes it
      return p.textContent === `${pt.ui_panelPlace.message} Alt+Shift+C${pt.ui_panelPlaceEnd.message}` && p.querySelector('b').textContent === 'Alt+Shift+C';
    })(), doc.querySelector('#advancedBody .sub p').textContent);
    const pse = new JSDOM(html, { runScripts: 'outside-only' });
    evalPanel(pse, EXT, [], { lang: 'pt_BR', locales: pseudo() });
    const left = [...pse.window.document.querySelectorAll('[data-i18n]')].filter(el => !/^«.*»$/s.test(el.textContent)).map(el => el.getAttribute('data-i18n'));
    ok('pseudo-locale: every data-i18n element goes through t()', left.length === 0, left.join(', '));
  }

  // ---------- the Language row ----------
  {
    const d = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = d.window; const sent = []; const sets = []; const changed = [];
    w.browser = { runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener() { } } }), getManifest: () => ({ version: '0.11.0' }) },
      storage: { session: { get: async () => ({}), set: async () => { } }, local: { get: async () => ({}), set: async o => { sets.push(o); } }, onChanged: { addListener: f => changed.push(f) } },
      tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() { } }, onUpdated: { addListener() { } } } };
    w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;'); w.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
    evalPanel(d, EXT, panelFiles);
    await tick(50);
    const sel = w.document.getElementById('langSelect');
    ok('Language row: a select in the first Settings card, under Dark mode, with Auto, English and Português (Brasil)', !!sel && sel.closest('#page-settings .card') === w.document.querySelector('#page-settings .card')
      && sel.closest('.card').textContent.indexOf('Dark mode') < sel.closest('.card').textContent.indexOf('Language')
      && [...sel.options].map(o => o.value + ':' + o.textContent).join() === 'auto:Auto,en:English,pt_BR:Português (Brasil)');
    ok('Language row: it shows the saved setting (auto)', sel.value === 'auto' && !!w.document.querySelector('label[for="langSelect"]'));
    let reloads = 0; w.cfxLang.reload = () => { reloads++; };
    sel.value = 'pt_BR'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(30);
    ok('Language row: choosing Português (Brasil) saves storage.local lang pt_BR and asks for a reload', sets.some(o => o.lang === 'pt_BR') && reloads === 1, JSON.stringify([sets, reloads]));
    for (const f of changed) f({ lang: { newValue: 'en' } }, 'local');
    ok('Language row: a change from another page asks for a reload too', reloads === 2 && w.cfxI18n.lang() === 'en', String(reloads));
    void sent;
  }

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL (crash) ' + (e && e.stack || e)); process.exit(1); });
