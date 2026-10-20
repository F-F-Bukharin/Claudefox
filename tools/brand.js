'use strict';
// Brands a staged copy of the add-on for people outside this PC (the friends zip, tools\build-friends.ps1): the
// source says Claudefox, and Zen where it means the browser; friends may use plain Firefox, so the rules below turn
// that Zen into Firefox. Inside names (the add-on id, the helper's registry name, the claudefox data folder) stay.
// Every rule must still match, and the old product name may not be left in a text file, so a rule that silently stops
// matching fails the build instead of shipping a half-renamed add-on.
//   node tools/brand.js <staged folder>
const fs = require('fs');
const path = require('path');

const NAME = 'Claudefox';
const OLD_NAME = ['Claude', 'in', 'Zen'].join(' ');   // what the add-on was called before 0.11; none may be left
const LANG_EN = 'extension/_locales/en/messages.json';
const LANG_PT = 'extension/_locales/pt_BR/messages.json';
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
  // The panel's other Zen texts: the empty chat's title and some notes. They sit in the English language file (and were
  // in panel.js before E11), so these rules are for every text file, with no quotes around the text.
  { from: 'What should I do in Zen?', to: 'What should Claude do in Firefox?' },
  { from: 'then press Sign in. Zen remembers it after that.', to: 'then press Sign in. Firefox remembers it after that.' },
  { from: 'until you press Stop or restart Zen.', to: 'until you press Stop or restart Firefox.' },
  { from: 'the claude.ai account signed in to Zen.', to: 'the claude.ai account signed in to Firefox.' },
  // The same texts in the two language files (extension/_locales). The Portuguese ones have accents, so brand() matches
  // every rule on the latin1 view of its UTF-8 bytes (see bytes()).
  { file: LANG_EN, from: 'already open in Zen.', to: 'already open in Firefox.' },
  { file: LANG_EN, from: 'Zen remembers it after that', to: 'Firefox remembers it after that' },
  { file: LANG_EN, from: '"Using Zen now"', to: '"Using Firefox now"' },
  { file: LANG_EN, from: 'The panel docks on the right. ', to: 'The panel opens in the sidebar. ' },
  { file: LANG_EN, from: "Zen's title bar above the panel is hidden, so the panel has no header menu. ", to: '' },
  { file: LANG_PT, from: 'O que devo fazer no Zen?', to: 'O que o Claude deve fazer no Firefox?' },
  { file: LANG_PT, from: 'já aberta no Zen.', to: 'já aberta no Firefox.' },
  { file: LANG_PT, from: 'O Zen se lembra disso depois', to: 'O Firefox se lembra disso depois' },
  { file: LANG_PT, from: '"Usando o Zen agora"', to: '"Usando o Firefox agora"' },
  { file: LANG_PT, from: 'O painel fica à direita. ', to: 'O painel abre na barra lateral. ' },
  { file: LANG_PT, from: 'A barra de título do Zen acima do painel fica oculta, então o painel não tem menu no cabeçalho. ', to: '' },
  { file: LANG_PT, from: 'ou reiniciar o Zen.', to: 'ou reiniciar o Firefox.' },
  { file: LANG_PT, from: 'conectada no Zen.', to: 'conectada no Firefox.' },
  // What Claude is told and the errors it reads: it works in Firefox there.
  { from: 'real Zen browser', to: 'real Firefox browser' },
  { from: 'ask the user to type it in Zen.', to: 'ask the user to type it in Firefox.' },
  { from: 'which field to fill in Zen.', to: 'which field to fill in Firefox.' },
  { from: 'in a new Zen tab', to: 'in a new tab' },
  { from: 'Zen did not answer within', to: 'Firefox did not answer within' },
  { from: 'No answer from Zen within', to: 'No answer from Firefox within' },
  { from: 'The link to Zen closed: the agent was stopped or Zen quit.', to: 'The link to Firefox closed: the agent was stopped or Firefox quit.' },
  { from: 'No Zen tab showed', to: 'No Firefox tab showed' },
  { from: 'or Zen or the helper restarted', to: 'or Firefox or the helper restarted' },
  // The rest of the texts a friend or Claude reads (test/brand.js lists what may still say Zen). These are phrases, so a
  // code line that merely mentions Zen is never touched. They apply to every text file: the same words also sit in tests.
  { file: LANG_EN, from: 'close Zen, run \\"Link add-on to Zen.bat\\" (tools folder) once, start Zen.', to: 'close Firefox, run the link script (tools folder) once, start Firefox.' },
  { file: LANG_EN, from: 'install it in Zen"', to: 'install it in Firefox"' },
  { from: 'Close Zen? No:', to: 'Close Firefox? No:' },
  { file: LANG_EN, from: 'look behind Zen or', to: 'look behind Firefox or' },
  { from: 'Zen keeps add-ons out', to: 'Firefox keeps add-ons out' },
  { from: 'Zen returned no image', to: 'Firefox returned no image' },
  { from: 'Zen did not let the add-on capture', to: 'Firefox did not let the add-on capture' },
  { from: 'Zen draws a tab only while', to: 'Firefox draws a tab only while' },
  { from: 'Zen is not reachable. Make sure Zen is open', to: 'Firefox is not reachable. Make sure Firefox is open' },
  { from: 'Zen is linked to the project folder', to: 'Firefox is linked to the project folder' },
  { from: 'find the browser (Zen or Firefox)', to: 'find the browser (Firefox)' },
  { from: 'Zen browser', to: 'Firefox browser' },
  { from: 'restart Zen.', to: 'restart Firefox.' },
  { from: 'Restart Zen.', to: 'Restart Firefox.' },
  { from: 'Zen restarted', to: 'Firefox restarted' },
  { from: 'reinicia o Zen.', to: 'reinicia o Firefox.' },
  { from: 'Close Zen (it keeps the old helper running)', to: 'Close Firefox (it keeps the old helper running)' },
  { from: 'outside Zen', to: 'outside Firefox' },
  // The panel's update messages: a friend's copy has no tools folder to run anything from.
  { from: 'sent to Zen. If no install prompt shows up, run "Install in Zen.bat" (tools folder) yourself, or link Zen once for one-click updates.',
    to: 'sent to Firefox. If no install prompt shows up, run the update again.' },
  { from: 'handed to Zen', to: 'handed to Firefox' },
  { from: "in Zen's prompt.", to: "in Firefox's prompt." },
];
// Comments name the browser too ("when Zen stays open"). They are branded as a group: in the comment part of a line only
// (a whole-line // or # comment, or one after code), in every .js, .ps1 and .py file except the ones below, whose
// comments explain how they find Zen and must keep saying so.
const COMMENT_FILES = /\.(js|ps1|py)$/i;
const COMMENT_KEEP = ['host/lib/localpages.js', 'host/lib/updates.js', 'host/lib/guard.js'];
const TEXT = /\.(js|json|html|css|svg|txt|md|bat|cmd|ps1|py)$/i;

// Files are read as latin1 (below), so a rule with non-ASCII text (the Portuguese ones) only matches when it is written
// the same way: the latin1 view of the UTF-8 bytes. For plain ASCII this changes nothing.
const bytes = s => Buffer.from(s, 'utf8').toString('latin1');

// Returns the text with the word Zen turned into Firefox in its comments, and how many were changed.
function brandComments(text, rel) {
  const hash = /\.(ps1|py)$/i.test(rel);
  let n = 0;
  const out = text.split('\n').map(line => {
    const whole = hash ? /^\s*#/.exec(line) : /^\s*(\/\/|\/\*|\*)/.exec(line);
    const tail = whole || (hash ? /\S\s{2,}# / : /\S\s+\/\/\s/).exec(line);
    if (!tail) return line;
    const at = whole ? 0 : tail.index + 1;
    return line.slice(0, at) + line.slice(at).replace(/\bZen\b/g, () => { n++; return 'Firefox'; });
  }).join('\n');
  return { text: out, n };
}

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
  let commentHits = 0;
  for (const rel of files(stage).filter(f => TEXT.test(f))) {
    const file = path.join(stage, rel);
    // latin1 keeps every byte as it was, so only the text of a rule changes.
    const before = fs.readFileSync(file, 'latin1');
    let text = before;
    RULES.forEach((r, i) => {
      if (r.file && r.file !== rel) return;
      const parts = text.split(bytes(r.from));
      hits[i] += parts.length - 1;
      text = parts.join(bytes(r.to));
    });
    if (COMMENT_FILES.test(rel) && !COMMENT_KEEP.includes(rel)) { const c = brandComments(text, rel); text = c.text; commentHits += c.n; }
    if (text !== before) fs.writeFileSync(file, text, 'latin1');
    if (text.includes(OLD_NAME)) problems.push(`"${OLD_NAME}" is still in ${rel}`);
  }
  if (!commentHits) problems.push('no comment says Zen any more, so the comment rule has nothing to do');
  RULES.forEach((r, i) => { if (!hits[i]) problems.push(`no match for "${r.from}"${r.file ? ` in ${r.file}` : ''}`); });
  try {
    const m = JSON.parse(fs.readFileSync(path.join(stage, 'extension', 'manifest.json'), 'utf8'));
    if (m.name !== NAME) problems.push(`the manifest's name is ${JSON.stringify(m.name)}`);
  } catch (e) { problems.push(`extension/manifest.json: ${e.message}`); }
  // The GitHub links from tools/release.json: the add-on's homepage and the update file Firefox checks. They are part
  // of the signed package, so they go in before signing; without them a friend's copy could never update itself.
  const links = releaseLinks();
  if (links.error) problems.push(links.error);
  else {
    try {
      const file = path.join(stage, 'extension', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      m.homepage_url = links.homepage;
      m.browser_specific_settings = m.browser_specific_settings || {};
      m.browser_specific_settings.gecko = m.browser_specific_settings.gecko || {};
      m.browser_specific_settings.gecko.update_url = links.updates;
      fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
    } catch (e) { problems.push(`extension/manifest.json: ${e.message}`); }
  }
  return problems;
}

// tools/release.json names the public GitHub repo as owner/name. Returns the two addresses, or { error }.
function releaseLinks(file = path.join(__dirname, 'release.json')) {
  let repo;
  try { repo = JSON.parse(fs.readFileSync(file, 'utf8')).repo; } catch (e) { return { error: `tools/release.json: ${e.message}` }; }
  if (typeof repo !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) return { error: `tools/release.json: "repo" must be owner/name, got ${JSON.stringify(repo)}` };
  const base = `https://github.com/${repo}`;
  return { repo, homepage: base, updates: `${base}/releases/latest/download/updates.json` };
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

module.exports = { brand, releaseLinks, NAME, RULES };
