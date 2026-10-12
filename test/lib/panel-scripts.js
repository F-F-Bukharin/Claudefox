// The panel's own scripts (extension/panel.js and panel-*.js) for the DOM tests. panelPage() takes their script tags out of
// panel.html and lists them in page order; evalPanel() evals them into a window in that order, as the page loads them, so a
// page test runs the whole panel. A new panel file needs no change here.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const TAG = /<script src="(panel(?:-[a-z]+)?\.js)"><\/script>/g;

function panelPage(dir) {
  const html = fs.readFileSync(path.join(dir, 'panel.html'), 'utf8');
  return { html: html.replace(TAG, ''), files: [...html.matchAll(TAG)].map(m => m[1]) };
}

// Each file runs as a classic script in the window's global scope, as the page loads it, so a name one file declares is seen by
// the next. (w.eval would scope a 'use strict' file's declarations to that one eval.)
function evalPanel(dom, dir, files) {
  const ctx = dom.getInternalVMContext();
  for (const f of files) new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }).runInContext(ctx);
}

module.exports = { panelPage, evalPanel };
