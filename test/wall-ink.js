'use strict';
// The text colour for a wallpaper (extension/lib/wall.js): the contrast it is judged by, the colour of a solid, a
// gradient and a picture under the wash, and the average of a picture. Runs in a plain context, so no browser is needed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'wall.js'), 'utf8'), sandbox);
const W = sandbox.window.cizWallInk;

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) pass++; else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail !== undefined ? `  (${detail})` : ''}`);
};

check('the contrast of white on black is 21', Math.abs(W.contrast([255, 255, 255], [0, 0, 0]) - 21) < 0.01, String(W.contrast([255, 255, 255], [0, 0, 0])));
check('a colour is read from #rrggbb, and anything else is refused', JSON.stringify(W.rgb('#1F3B57')) === '[31,59,87]' && W.rgb('navy') === null && W.rgb('#fff') === null);
check('the average of black and white is mid grey', W.averageHex(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])) === '#808080');
check('no average for an empty picture', W.averageHex(new Uint8ClampedArray([])) === null);
check('the default wallpaper keeps the theme text colour (no ink)', W.inkFor({ mode: 'default' }, 'light') === null && W.inkFor({ mode: 'default' }, 'dark') === null && W.inkFor(null, 'dark') === null);
check('a light solid wallpaper gets near-black text', W.inkFor({ mode: 'solid', color: '#f6e7c1' }, 'light') === 'dark');
check('a dark solid wallpaper gets white text', W.inkFor({ mode: 'solid', color: '#1f3b57' }, 'light') === 'light');
check('the same solid colours in dark mode keep their ink', W.inkFor({ mode: 'solid', color: '#f6e7c1' }, 'dark') === 'dark' && W.inkFor({ mode: 'solid', color: '#1f3b57' }, 'dark') === 'light');
check('a dark gradient gets white text', W.inkFor({ mode: 'gradient', from: '#0b1d33', to: '#1f3b57' }, 'light') === 'light');
check('a pale gradient gets near-black text', W.inkFor({ mode: 'gradient', from: '#f6f4ef', to: '#cfdcef' }, 'light') === 'dark');
check('a gradient that runs from dark to pale is judged by its worse end', W.inkFor({ mode: 'gradient', from: '#0b1d33', to: '#f6f4ef' }, 'light') !== null);
check('a picture not measured yet has no ink', W.inkFor({ mode: 'picture', image: 'data:x', avg: '' }, 'light') === null);
check('under the wash a picture reads as the page: near-black text in light mode, white in dark mode', W.inkFor({ mode: 'picture', avg: '#1a2a40' }, 'light') === 'dark' && W.inkFor({ mode: 'picture', avg: '#1a2a40' }, 'dark') === 'light');
check('a mid-grey picture gets the ink of its theme', W.inkFor({ mode: 'picture', avg: '#808080' }, 'light') === 'dark' && W.inkFor({ mode: 'picture', avg: '#808080' }, 'dark') === 'light');

console.log(`${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
