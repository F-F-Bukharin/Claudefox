// The text colour of the page for a wallpaper (the panel's Wallpaper card). Loaded in the panel before theme.js, so the
// first paint already has it. White text on a dark wallpaper, near-black on a light one: whichever gives the higher
// contrast on the wallpaper's colours (both ends of a gradient). A picture counts as its average colour under the 78 %
// wash of the page colour, so for a picture the text follows the theme. The default wallpaper keeps the theme's text.
(function (root) {
  var WASH = 0.78;
  var PAGE = { light: '#f6f4ef', dark: '#1c1b19' };   // the page colour under the wash, per theme (panel.css :root)
  var INK = { light: '#ffffff', dark: '#111111' };

  function rgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hex(c) {
    return '#' + c.map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  function luminance(c) {
    var v = c.map(function (x) {
      x = x / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  // The WCAG contrast ratio of two colours, from 1 to 21.
  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  // a with t of b mixed in.
  function blend(a, b, t) {
    return a.map(function (x, i) { return Math.round(x * (1 - t) + b[i] * t); });
  }
  // The colours the text would sit on for this wallpaper under this theme; null when the page keeps the theme's text.
  function surfaces(wall, theme) {
    if (!wall) return null;
    var out = null;
    if (wall.mode === 'solid') out = [rgb(wall.color)];
    else if (wall.mode === 'gradient') out = [rgb(wall.from), rgb(wall.to)];
    else if (wall.mode === 'picture') {
      var avg = rgb(wall.avg);
      if (avg) out = [blend(rgb(PAGE[theme === 'dark' ? 'dark' : 'light']), avg, 1 - WASH)];
    }
    return out && out.every(Boolean) ? out : null;
  }
  // 'light' (white text), 'dark' (near-black text), or null: no wallpaper, or a picture not measured yet.
  function inkFor(wall, theme) {
    var list = surfaces(wall, theme);
    if (!list) return null;
    var best = null;
    var bestScore = -1;
    ['light', 'dark'].forEach(function (k) {
      var score = Math.min.apply(null, list.map(function (c) { return contrast(rgb(INK[k]), c); }));
      if (score > bestScore) { bestScore = score; best = k; }
    });
    return best;
  }
  // The average colour of a small copy of a picture, from its RGBA bytes, as '#rrggbb'.
  function averageHex(pixels) {
    var r = 0;
    var g = 0;
    var b = 0;
    var n = 0;
    for (var i = 0; i + 3 < pixels.length; i += 4) {
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
      n++;
    }
    return n ? hex([Math.round(r / n), Math.round(g / n), Math.round(b / n)]) : null;
  }

  root.cfxWallInk = { inkFor: inkFor, averageHex: averageHex, contrast: contrast, rgb: rgb, PAGE: PAGE, INK: INK, WASH: WASH };
})(typeof window !== 'undefined' ? window : globalThis);
