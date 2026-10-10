'use strict';
// Real Office files from what Claude writes (extension/lib/docx.js), built in jsdom like the add-on builds them, then
// read back with the helper's own Office reader (host/lib/doctext.js) and checked part by part for well-formed XML.
// Needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.   node test/docx.js
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractText, readZip } = require('../host/lib/doctext');

const ext = path.join(__dirname, '..', 'extension');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
const w = dom.window;
w.TextEncoder = TextEncoder;
w.eval(fs.readFileSync(path.join(ext, 'lib', 'markdown.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ext, 'lib', 'docx.js'), 'utf8')
  + '\nwindow.T = { cizDocx, cizXlsx, cizHtmlPage, cizExport, cizZip };');
const T = w.T;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-docx-'));
const save = (name, bytes) => { const f = path.join(tmp, name); fs.writeFileSync(f, Buffer.from(bytes)); return f; };

function wellFormed(file) {
  const zip = readZip(fs.readFileSync(file));
  const bad = [];
  for (const n of zip.names) {
    if (!/\.(xml|rels)$/.test(n)) continue;
    const doc = new w.DOMParser().parseFromString(zip.read(n), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) bad.push(n);
  }
  return { names: zip.names, bad, zip };
}

const md = `# Relatório de Física: Ondas

Texto com **negrito**, *itálico*, \`código\` e um [link](https://example.com/a?b=1&c=2).

## 1. Introdução

- Item um
- Item dois
  - Sub item
- Item três

1. Primeiro
2. Segundo

> Uma citação.

| Grandeza | Valor |
| --- | --- |
| Velocidade | 3 m/s |

\`\`\`
x = 1 < 2 & 3
\`\`\`

\\pagebreak

### Conclusão

Caracteres especiais: < > & " ' e emoji 😀.
`;

const docx = save('report.docx', T.cizDocx(md, { title: 'Relatório', lang: 'pt-BR' }));
const wf = wellFormed(docx);
ok('docx: every part is well-formed XML', !wf.bad.length && wf.names.length >= 9, wf.bad.join(', '));
ok('docx: has the parts Word needs', ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'word/footer1.xml']
  .every(n => wf.names.includes(n)));
const body = wf.zip.read('word/document.xml');
ok('docx: title, headings, quote and code use Word styles', /w:val="Title"/.test(body) && /w:val="Heading2"/.test(body) && /w:val="Heading3"/.test(body) && /w:val="Quote"/.test(body) && /w:val="Code"/.test(body));
ok('docx: lists are real Word lists, nested and numbered', /<w:numId w:val="1"\/>/.test(body) && /<w:ilvl w:val="1"\/>/.test(body) && /<w:numId w:val="2"\/>/.test(body));
ok('docx: \\pagebreak starts a new page; footer numbers pages', /<w:br w:type="page"\/>/.test(body) && / PAGE /.test(wf.zip.read('word/footer1.xml')));
ok('docx: links are hyperlinks with escaped targets', /<w:hyperlink r:id="rIdL1"/.test(body) && /Target="https:\/\/example\.com\/a\?b=1&amp;c=2" TargetMode="External"/.test(wf.zip.read('word/_rels/document.xml.rels')));
const back = extractText(docx).text;
ok('docx: reads back with headings, list items and the table', /# Relatório de Física: Ondas/.test(back) && /## 1\. Introdução/.test(back) && /- Item um/.test(back) && /  - Sub item/.test(back)
  && /\| Velocidade \| 3 m\/s \|/.test(back) && /x = 1 < 2 & 3/.test(back) && /emoji 😀/.test(back), back.slice(0, 400));

const htmlDocx = save('page.docx', T.cizDocx('<h1>Título</h1><p>Um <b>parágrafo</b>.</p><script>alert(1)</script><ul><li>a<ul><li>b</li></ul></li></ul>', { title: 'HTML' }));
const hb = extractText(htmlDocx).text;
ok('docx from HTML: scripts dropped, lists nested', /# Título/.test(hb) && /- a/.test(hb) && /  - b/.test(hb) && !/alert/.test(hb), hb);

const xlsx = save('notes.xlsx', T.cizXlsx('Aluno,Nota,Obs\nAna,9.5,"ok, bom"\nBruno,7,\n'));
const xw = wellFormed(xlsx);
const xt = extractText(xlsx).text;
ok('xlsx from CSV: well-formed, values and quoted commas kept', !xw.bad.length && /Aluno,Nota,Obs/.test(xt) && /Ana,9\.5,"ok, bom"/.test(xt), xt);
ok('xlsx: numbers are numbers, text is text', /<c r="B2"><v>9\.5<\/v><\/c>/.test(xw.zip.read('xl/worksheets/sheet1.xml')));
const xlsx2 = save('tables.xlsx', T.cizXlsx('## Notas\n| Aluno | Nota |\n|---|---|\n| Ana | 9.5 |\n\n## Faltas\n| Aluno | Faltas |\n|---|---|\n| Bruno | 2 |\n'));
const x2 = extractText(xlsx2).text;
ok('xlsx from Markdown tables: one sheet per table, named by its heading', /## Sheet: Notas/.test(x2) && /## Sheet: Faltas/.test(x2) && /Bruno,2/.test(x2), x2);

const page = T.cizHtmlPage(md, 'Relatório');
ok('html export: full page, real heading levels, no copy buttons', /^<!doctype html>/.test(page) && /<h1>Relatório de Física: Ondas<\/h1>/.test(page) && /<h2>1\. Introdução<\/h2>/.test(page) && !/codecopy|Copy<\/button>/.test(page) && /class="page-break"/.test(page));

const file = { name: 'Lista 3.docx', title: 'Lista 3', mime: 'x', content: '# Lista 3\n\nTexto.' };
const asDocx = T.cizExport(file, '');
const asMd = T.cizExport(file, 'md');
ok('export: a .docx file downloads as Word, or as its Markdown', asDocx.name === 'Lista 3.docx' && asDocx.data instanceof w.Uint8Array && asMd.name === 'Lista 3.md' && asMd.data === file.content);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
