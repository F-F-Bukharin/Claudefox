'use strict';
// Brands a staged copy of the add-on for people outside this PC (the friends zip, tools\build-friends.ps1): it is
// called Claudefox there, since friends may use plain Firefox. The source and this PC's own install stay Claude in
// Zen; inside names (the add-on id, the helper's registry name, the claude-in-zen data folder) stay as they are.
// Every rule must still match, and no "Claude in Zen" may be left in a text file, so a rule that silently stops
// matching fails the build instead of shipping a half-renamed add-on.
//   node tools/brand.js <staged folder>
const fs = require('fs');
const path = require('path');

const NAME = 'Claudefox';
// file: the one file a rule is for (relative, forward slashes); without it, every text file. The friends' own setup
// file and START HERE come from friends\ and already say Claudefox; these rules cover the add-on and the helper.
const RULES = [
  { file: 'extension/manifest.json', from: 'act on pages in Zen. Not affiliated with or endorsed by Anthropic or Zen.',
    to: 'act on pages in Firefox. Not affiliated with or endorsed by Anthropic or Mozilla.' },
  { file: 'extension/panel.html', from: 'What should I do in Zen?', to: 'What should Claude do in Firefox?' },
  { file: 'extension/panel.html', from: 'already open in Zen.', to: 'already open in Firefox.' },
  { file: 'extension/panel.html', from: 'Zen remembers it after that', to: 'Firefox remembers it after that' },
  { file: 'extension/panel.html', from: '>Using Zen now<', to: '>Using Firefox now<' },
  // Zen-only layout notes: Firefox keeps its sidebar header, and the sidebar sits where the user put it.
  { file: 'extension/panel.html', from: 'The panel docks on the right. ', to: 'The panel opens in the sidebar. ' },
  { file: 'extension/panel.html', from: "Zen's title bar above the panel is hidden, so the panel has no header menu. ", to: '' },
  { file: 'extension/background.js', from: "'Zen opened: the agent is on.'", to: "'Firefox opened: the agent is on.'" },
  { from: 'Claude in Zen', to: NAME },
];
const TEXT = /\.(js|json|html|css|svg|txt|md|bat|cmd|ps1)$/i;

function files(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// Returns the problems found (empty when the copy is branded).
function brand(stage) {
  const problems = [];
  const hits = RULES.map(() => 0);
  for (const rel of files(stage).filter(f => TEXT.test(f))) {
    const file = path.join(stage, rel);
    // latin1 keeps every byte as it was: the rules are plain ASCII, so only their own text changes.
    const before = fs.readFileSync(file, 'latin1');
    let text = before;
    RULES.forEach((r, i) => {
      if (r.file && r.file !== rel) return;
      const parts = text.split(r.from);
      hits[i] += parts.length - 1;
      text = parts.join(r.to);
    });
    if (text !== before) fs.writeFileSync(file, text, 'latin1');
    if (text.includes('Claude in Zen')) problems.push(`"Claude in Zen" is still in ${rel}`);
  }
  RULES.forEach((r, i) => { if (!hits[i]) problems.push(`no match for "${r.from}"${r.file ? ` in ${r.file}` : ''}`); });
  try {
    const m = JSON.parse(fs.readFileSync(path.join(stage, 'extension', 'manifest.json'), 'utf8'));
    if (m.name !== NAME) problems.push(`the manifest's name is ${JSON.stringify(m.name)}`);
  } catch (e) { problems.push(`extension/manifest.json: ${e.message}`); }
  return problems;
}

if (require.main === module) {
  const stage = process.argv[2];
  if (!stage || !fs.existsSync(path.join(stage, 'extension', 'manifest.json'))) {
    console.error('Give the staged folder (the one with extension\\manifest.json).');
    process.exit(2);
  }
  const problems = brand(path.resolve(stage));
  if (problems.length) { for (const p of problems) console.error(`brand: ${p}`); process.exit(1); }
  console.log(`Branded ${stage} as ${NAME}.`);
}

module.exports = { brand, NAME, RULES };
