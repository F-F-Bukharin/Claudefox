// Settings, Language: shows the saved choice (Auto, English or Português (Brasil)) and saves a new one. The texts come from
// lib/i18n.js. The panel reloads itself when the language changes, here or in another open panel, so every text, including
// the ones a script worked out once at load, is written again in the new language.
(function () {
  'use strict';
  // The reload sits in one small function so a test can replace it (jsdom has no location.reload).
  window.cfxLang = { reload: function () { location.reload(); } };
  var sel = document.getElementById('langSelect');
  if (!sel || !window.cfxI18n) return;
  sel.value = cfxI18n.setting();
  sel.addEventListener('change', function () { cfxI18n.set(sel.value); });
  cfxI18n.onChange(function () { window.cfxLang.reload(); });
})();
