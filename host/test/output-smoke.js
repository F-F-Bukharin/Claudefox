'use strict';
// The output folder: file names, uniqueness, the write and the refusals. Temp folders only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = require('../lib/output');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-output-'));
const dir = path.join(root, 'extension', 'output');
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

const folderPart = OUT.safeName('..\\..\\evil.txt');
ok('a name with folder parts keeps no folder part', !/[\\/]/.test(folderPart) && !folderPart.startsWith('.'), folderPart);
ok('a plain name stays as it is', OUT.safeName('report.xlsx') === 'report.xlsx');
ok('a device name gets a prefix', OUT.safeName('CON.txt') === '_CON.txt', OUT.safeName('CON.txt'));
ok('trailing dots and spaces are dropped', OUT.safeName('chart.png. ') === 'chart.png', OUT.safeName('chart.png. '));
ok('an empty name becomes file', OUT.safeName('   ') === 'file');
const long = OUT.safeName('a'.repeat(200) + '.docx');
ok('a long name is cut to 120 and keeps its extension', long.length <= 120 && long.endsWith('.docx'), String(long.length));
ok('reserved characters become underscores', OUT.safeName('a:b*c?.txt') === 'a_b_c_.txt', OUT.safeName('a:b*c?.txt'));

const first = OUT.save(dir, 'report.xlsx', b64('one'));
ok('the first save keeps the name', path.basename(first) === 'report.xlsx', path.basename(first));
const second = OUT.save(dir, 'report.xlsx', b64('two'));
ok('a taken name gets (2)', path.basename(second) === 'report (2).xlsx', path.basename(second));
const third = OUT.save(dir, 'report.xlsx', b64('three'));
ok('the next one gets (3)', path.basename(third) === 'report (3).xlsx', path.basename(third));
ok('the first file is not overwritten', fs.readFileSync(first, 'utf8') === 'one');
ok('the second file has its bytes', fs.readFileSync(second, 'utf8') === 'two');

const text = OUT.save(dir, 'notas.txt', b64('olá, mundo'));
ok('text is written as UTF-8', fs.readFileSync(text, 'utf8') === 'olá, mundo');
const bin = Buffer.from([0, 1, 2, 250, 255]);
const png = OUT.save(dir, 'chart.png', bin.toString('base64'));
ok('binary bytes come back unchanged', Buffer.compare(fs.readFileSync(png), bin) === 0);
ok('no temporary files are left', fs.readdirSync(dir).every(f => !f.endsWith('.tmp')));

let threw = '';
try { OUT.save(dir, 'empty.txt', ''); } catch (e) { threw = e.message; }
ok('an empty file is refused', threw === 'the file is empty', threw);
ok('the refused file is not written', !fs.existsSync(path.join(dir, 'empty.txt')));

console.log(fail ? `${pass} passed, ${fail} failed` : `${pass} checks passed`);
process.exit(fail ? 1 : 0);
