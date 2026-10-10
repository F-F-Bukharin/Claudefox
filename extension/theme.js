// Runs in <head>, before the first paint: applies the theme the user chose in Settings (Dark mode).
// Until a choice is saved, the panel follows the system setting. Extension pages cannot run inline scripts, so this is a file.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('ciz-theme'); } catch (e) {}
  var dark = saved ? saved === 'dark' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // The wallpaper from Settings is applied here too, so the default colour does not flash first.
  var wall = null;
  try { wall = JSON.parse(localStorage.getItem('ciz-wall') || 'null'); } catch (e) {}
  if (wall && (wall.mode === 'solid' || wall.mode === 'gradient' || wall.mode === 'picture')) {
    var st = document.documentElement.style;
    document.documentElement.dataset.wall = wall.mode;
    st.setProperty('--wall-color', wall.color || '#f6f4ef');
    st.setProperty('--wall-from', wall.from || '#f6f4ef');
    st.setProperty('--wall-to', wall.to || '#cfdcef');
    st.setProperty('--wall-img', wall.image ? 'url("' + wall.image + '")' : 'none');
    // The text colour for this wallpaper (lib/wall.js): white on a dark one, near-black on a light one.
    var ink = window.cizWallInk ? window.cizWallInk.inkFor(wall, dark ? 'dark' : 'light') : null;
    if (ink) document.documentElement.dataset.wallInk = ink;
  }
})();
