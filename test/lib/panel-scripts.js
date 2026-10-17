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
// Before the panel's files, the window gets the language texts and lib/i18n.js, as the page has them (it loads i18n.js before
// panel.js): opts.locales is { en, pt_BR } (default: the repo's two files), opts.lang picks the language in use ('en' by
// default, so every panel DOM test sees the English texts). A test that wants Portuguese passes
// { lang: 'pt_BR', locales: require('./locales').pseudo() } and looks for «…».
function evalPanel(dom, dir, files, opts = {}) {
  const ctx = dom.getInternalVMContext();
  const { load } = require('./locales');
  dom.window.CFX_LOCALES = opts.locales || load();
  new vm.Script(fs.readFileSync(path.join(dir, 'lib', 'i18n.js'), 'utf8'), { filename: 'lib/i18n.js' }).runInContext(ctx);
  dom.window.cfxI18n.use(opts.lang || 'en');
  dom.window.cfxI18n.apply(dom.window.document);
  for (const f of files) new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }).runInContext(ctx);
}

module.exports = { panelPage, evalPanel };
