// The add-on's texts in English and Portuguese (Brazil): t(key, ...subs) and the cizI18n helper. Loaded first in the
// background (manifest) and before panel.js in panel.html. The texts live in _locales/<lang>/messages.json.
//   t('key', a, b)       the message in the language in use ($1, $2 ... become a, b; $$ is a dollar sign). A key missing in
//                        Portuguese shows the English message, and an unknown key shows the key itself. It never throws.
//   cizI18n.setting()    the saved choice: 'auto' | 'en' | 'pt_BR'  ('auto' follows the browser's language)
//   cizI18n.lang()       the language in use: 'en' | 'pt_BR'
//   cizI18n.set(value)   saves the choice (storage.local `lang` and localStorage 'ciz-lang'), switches, then calls onChange
//   cizI18n.use(lang)    switches in memory only, saving nothing and calling nobody (tests)
//   cizI18n.onChange(fn) fn(lang) after the language changed, here or in another page of the add-on
//   cizI18n.apply(root)  fills every [data-i18n] (text), [data-i18n-title], [data-i18n-placeholder] and
//                        [data-i18n-aria-label] under root
//   cizI18n.has(key)     true when the English file has the key
// The texts are read synchronously, at load, for the same reason theme.js reads the theme synchronously: the panel's
// scripts and the background show texts the moment they start, so t() must already have them. The panel reloads itself
// when the language changes (panel-lang.js) instead of re-rendering: a text a script worked out once at load is then
// right again without every script keeping a list of what to redraw. The background never reloads, so it calls t() at the
// moment it shows a text.
// Everything here is guarded: many tests run this file in a vm with a stub browser that has only a few members, and a
// missing localStorage, document or XMLHttpRequest must never stop the add-on from loading.
(function () {
  'use strict';
  var G = typeof globalThis !== 'undefined' ? globalThis : this;
  var LANGS = ['en', 'pt_BR'];
  var texts = { en: {}, pt_BR: {} };
  var setting = 'auto';
  var current = 'en';
  var listeners = [];

  function norm(v) { return v === 'en' || v === 'pt_BR' ? v : 'auto'; }

  // The browser's own language, for 'auto': Portuguese when it starts with "pt" (pt-BR, pt-PT, pt), English otherwise.
  function browserIsPortuguese() {
    var l = '';
    try { if (G.browser && G.browser.i18n && G.browser.i18n.getUILanguage) l = G.browser.i18n.getUILanguage(); } catch (e) {}
    if (!l) { try { if (G.navigator) l = G.navigator.language; } catch (e) {} }
    return typeof l === 'string' && /^pt/i.test(l);
  }
  function resolve(s) { return s === 'auto' ? (browserIsPortuguese() ? 'pt_BR' : 'en') : s; }

  function localGet() { try { return G.localStorage ? G.localStorage.getItem('ciz-lang') : null; } catch (e) { return null; } }
  function localSet(v) { try { if (G.localStorage) G.localStorage.setItem('ciz-lang', v); } catch (e) {} }

  // { key: { message } } (the parsed messages.json) -> { key: 'message' }
  function flatten(file) {
    var out = {};
    if (file && typeof file === 'object') {
      Object.keys(file).forEach(function (k) {
        var m = file[k] && file[k].message;
        if (typeof m === 'string') out[k] = m;
      });
    }
    return out;
  }
  function readFile(lang) {
    try {
      if (typeof G.XMLHttpRequest !== 'function' || !G.browser || !G.browser.runtime || !G.browser.runtime.getURL) return null;
      var x = new G.XMLHttpRequest();
      x.open('GET', G.browser.runtime.getURL('_locales/' + lang + '/messages.json'), false);
      x.send();
      if ((x.status === 200 || x.status === 0) && x.responseText) return JSON.parse(x.responseText);
    } catch (e) {}
    return null;
  }
  function loadTexts() {
    var given = G.CIZ_LOCALES;
    LANGS.forEach(function (l) { texts[l] = flatten(given && typeof given === 'object' ? given[l] : readFile(l)); });
  }

  function lookup(key) {
    if (Object.prototype.hasOwnProperty.call(texts[current], key)) return texts[current][key];
    if (Object.prototype.hasOwnProperty.call(texts.en, key)) return texts.en[key];
    return undefined;
  }

  function t(key) {
    var subs = Array.prototype.slice.call(arguments, 1);
    try {
      var msg = lookup(key);
      if (msg === undefined) return String(key);
      // One pass, so a substitution that itself holds "$1" or "$$" is never read again.
      return msg.replace(/\$([1-9$])/g, function (m, c) {
        if (c === '$') return '$';
        var v = subs[Number(c) - 1];
        return v === undefined || v === null ? '' : String(v);
      });
    } catch (e) { return String(key); }
  }

  function fire() {
    listeners.slice().forEach(function (fn) { try { fn(current); } catch (e) {} });
  }

  // Takes the setting and works out the language it means ('auto' asks the browser); save keeps it for the next page load.
  function follow(value, save) {
    setting = norm(value);
    current = resolve(setting);
    if (save) localSet(setting);
  }

  function apply(root) {
    try {
      root = root || G.document;
      if (!root || !root.querySelectorAll) return;
      var pairs = [['data-i18n', null], ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder'], ['data-i18n-aria-label', 'aria-label']];
      pairs.forEach(function (p) {
        var els = Array.prototype.slice.call(root.querySelectorAll('[' + p[0] + ']'));
        if (root.hasAttribute && root.hasAttribute(p[0])) els.unshift(root);
        els.forEach(function (el) {
          var msg = lookup(el.getAttribute(p[0]));
          // A key the files do not know leaves the page's own (English) text in place.
          if (msg === undefined) return;
          var text = t(el.getAttribute(p[0]));
          if (p[1]) el.setAttribute(p[1], text); else el.textContent = text;
        });
      });
    } catch (e) {}
  }

  var api = {
    LANGS: LANGS.slice(),
    setting: function () { return setting; },
    lang: function () { return current; },
    set: function (value) {
      follow(value, true);
      var done = Promise.resolve();
      try {
        if (G.browser && G.browser.storage && G.browser.storage.local) {
          // The listeners (the panel reloads itself) wait until the write has been handed over.
          done = Promise.resolve(G.browser.storage.local.set({ lang: setting })).catch(function () {});
        }
      } catch (e) {}
      return done.then(function () { fire(); });
    },
    use: function (lang) { current = lang === 'pt_BR' ? 'pt_BR' : 'en'; },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    apply: apply,
    has: function (key) { return Object.prototype.hasOwnProperty.call(texts.en, key); },
  };

  try { loadTexts(); } catch (e) {}
  var saved = localGet();
  follow(saved === null || saved === undefined ? 'auto' : saved, false);

  // The other copy of the choice: storage.local, which every page of the add-on shares. If it differs from what this page
  // started with, it wins (a change made while this page was closed).
  try {
    if (G.browser && G.browser.storage && G.browser.storage.local && G.browser.storage.local.get) {
      Promise.resolve(G.browser.storage.local.get('lang')).then(function (r) {
        var stored = r && r.lang;
        if (stored === undefined || stored === null) return;
        if (norm(stored) === setting) return;
        follow(stored, true);
        fire();
      }).catch(function () {});
    }
    if (G.browser && G.browser.storage && G.browser.storage.onChanged && G.browser.storage.onChanged.addListener) {
      G.browser.storage.onChanged.addListener(function (changes, area) {
        if (area && area !== 'local') return;
        if (!changes || !changes.lang) return;
        var v = norm(changes.lang.newValue);
        // This page's own set() comes back here too: nothing to do for it.
        if (v === setting) return;
        follow(v, true);
        fire();
      });
    }
  } catch (e) {}

  G.t = t;
  G.cizI18n = api;

  // The panel's own scripts start from translated static texts and then overwrite their dynamic ones with t().
  try { if (G.document) apply(G.document); } catch (e) {}
})();
