'use strict';
// Code the helper and the army share: the JSON-lines reader (lib/jsonlines.js) and the worker tool list, which the
// helper's guard (lib/armyguard.js) and the add-on (extension/lib/army.js) must keep the same.   node test/shared-code.js
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../host/lib/jsonlines');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Feeds chunks to splitLines the way army.js does: each chunk is added to the tail the previous one left.
function feed(chunks) {
  const got = [];
  let tail = '';
  for (const c of chunks) tail = splitLines(tail + c, line => got.push(line));
  return { got, tail };
}

let r = feed(['{"type":"res', 'ult"}\n']);
check('a line split across two chunks comes out whole', same(r.got, ['{"type":"result"}']) && r.tail === '', JSON.stringify(r));
r = feed(['one\ntwo\nthree\n']);
check('several lines in one chunk each come out, in order', same(r.got, ['one', 'two', 'three']) && r.tail === '', JSON.stringify(r));
r = feed(['one\ntwo']);
check('a trailing partial line stays in the tail', same(r.got, ['one']) && r.tail === 'two', JSON.stringify(r));
r = feed(['a\n\nb\n']);
check('an empty line is passed on as an empty string', same(r.got, ['a', '', 'b']) && r.tail === '', JSON.stringify(r));

// The worker tool list. Read from source: the add-on runs in the browser and cannot be required here.
const names = (src, re) => {
  const m = re.exec(src);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
};
const guardList = names(read('host/lib/armyguard.js'), /const WORKER_TOOLS = \[([^\]]*)\]/);
const addonList = names(read('extension/lib/army.js'), /const CFX_ARMY_TOOLS = new Set\(\[([^\]]*)\]\)/);
check('both worker tool lists are found in their source', guardList.length > 0 && addonList.length > 0, `guard ${guardList.length}, add-on ${addonList.length}`);
check('the helper and the add-on allow the same worker tools', same([...guardList].sort(), [...addonList].sort()),
  `only in guard: ${guardList.filter(t => !addonList.includes(t))}  only in add-on: ${addonList.filter(t => !guardList.includes(t))}`);

console.log(`${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
