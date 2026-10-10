// Runs in <head>, before the first paint: applies the theme the user chose in Settings (Dark mode).
// Until a choice is saved, the panel follows the system setting. Extension pages cannot run inline scripts, so this is a file.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('ciz-theme'); } catch (e) {}
  var dark = saved ? saved === 'dark' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
