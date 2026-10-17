'use strict';
// The tests ship in the public repo and the friends zip, so their fixtures stay neutral: no real school, no Windows user folder
// with a real initial, no other personal detail. Scans test/ and host/test/, this file included.   node test/fixtures-clean.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };

// The words the fixtures must not carry, built from parts so that this file does not contain them itself. Matched in any case.
const BS = String.fromCharCode(92);                       // a backslash
const SCHOOL = ['inte', 'li'].join('');
const PERSONAL = [['Hunt', 'ress'].join(''), ['fel', 'pe'].join('')];
// A Windows user folder with the initial F or H, written the way a JavaScript string writes it (two backslashes), the way a
// Windows path has it (one backslash), and the way a file:/// URL has it (forward slashes).
const FOLDERS = ['f', 'h'].flatMap(u => [
  ['Users', BS, BS, u, BS, BS].join(''),
  ['Users', BS, u, BS].join(''),
  ['Users', '/', u, '/'].join(''),
]);
const GROUPS = [
  ['school name', [SCHOOL]],
  ['Windows user folder with an initial', FOLDERS],
  ['other personal detail', PERSONAL],
];

// Every line of every file under test/ and host/test/, lower-cased for the match.
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = ['test', path.join('host', 'test')].flatMap(d => walk(path.join(root, d)));
const lines = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').map((text, i) => ({ where: `${path.relative(root, f)}:${i + 1}`, low: text.toLowerCase() })));

check('the scan reads test/ and host/test/, this file included', files.includes(__filename), `${files.length} files`);
for (const [what, words] of GROUPS) {
  const hits = lines.filter(l => words.some(w => l.low.includes(w.toLowerCase()))).map(l => l.where);
  check(`no ${what} in test/ or host/test/`, hits.length === 0, hits.slice(0, 10).join(', ') + (hits.length > 10 ? ` and ${hits.length - 10} more` : ''));
}

console.log(`${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
