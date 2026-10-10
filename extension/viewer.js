'use strict';
// Opens a file Claude made (create_file): Markdown rendered, CSV as a table, HTML in a sandbox
// without scripts, SVG as an image, anything else as plain text. viewer.html#<file id>
// Word (.docx) and PDF files are kept as the Markdown or HTML Claude wrote and shown that way; Download builds the
// real file. viewer.html?pdf=1#<id> saves the page as PDF as soon as it is shown.
const $ = id => document.getElementById(id);
const id = decodeURIComponent(location.hash.slice(1));
let file = null, showRaw = false, blobUrl = '';

function csvRows(text, sep) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function render() {
  const view = $('view');
  view.textContent = '';
  view.className = 'view';
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name) || [])[1] || '';
  const html = /^\s*</.test(file.content) && /<\/?(p|div|h[1-6]|ul|ol|table|body|html|section|article|span|br)\b/i.test(file.content);
  const tables = /^\s*\|.*\n\s*\|?\s*:?-{2,}/m.test(file.content);
  const kind = showRaw ? 'raw' : /^(md|markdown)$/i.test(ext) ? 'md' : /^(csv|tsv)$/i.test(ext) ? 'csv'
    : /^(docx|pdf)$/i.test(ext) ? (html ? 'html' : 'md') : /^xlsx$/i.test(ext) ? (tables ? 'md' : 'csv')
      : /^(html?|doc)$/i.test(ext) ? 'html' : /^svg$/i.test(ext) ? 'svg' : /^json$/i.test(ext) ? 'json' : 'raw';
  if (kind === 'md') cizMarkdown(view, file.content, (k, v) => { if (k === 'url') window.open(v, '_blank', 'noopener'); });
  else if (kind === 'csv') {
    const first = file.content.split('\n')[0] || '';
    const sep = /tsv/i.test(ext) || (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t'
      : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    const rows = csvRows(file.content, sep).slice(0, 5000);
    const wrap = view.appendChild(document.createElement('div')); wrap.className = 'tablewrap';
    const table = wrap.appendChild(document.createElement('table'));
    rows.forEach((r, i) => { const tr = table.insertRow(); for (const c of r) { const td = document.createElement(i ? 'td' : 'th'); td.textContent = c; tr.appendChild(td); } });
  } else if (kind === 'html') {
    view.className = 'view wide';
    const frame = view.appendChild(document.createElement('iframe'));
    frame.className = 'html';
    frame.setAttribute('sandbox', '');   // no scripts, no forms, no access to the add-on
    frame.srcdoc = file.content;
  } else if (kind === 'svg') {
    blobUrl = blobUrl || URL.createObjectURL(new Blob([file.content], { type: 'image/svg+xml' }));
    const img = view.appendChild(document.createElement('img')); img.className = 'svg'; img.src = blobUrl; img.alt = file.name;
  } else {
    let text = file.content;
    if (kind === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
    const pre = view.appendChild(document.createElement('pre')); pre.className = 'plain'; pre.textContent = text;
  }
  $('raw').textContent = showRaw ? 'Show formatted' : 'Show source';
}

(async () => {
  const got = await browser.storage.local.get(['files', 'file:' + id]);
  const meta = (Array.isArray(got.files) ? got.files : []).find(f => f.id === id);
  if (!meta || typeof got['file:' + id] !== 'string') {
    $('name').textContent = 'File not found';
    $('view').appendChild(Object.assign(document.createElement('p'), { className: 'missing', textContent: 'It may have been deleted from the panel.' }));
    for (const b of ['raw', 'copy', 'print', 'download', 'saveMore']) $(b).disabled = true;
    return;
  }
  file = Object.assign({}, meta, { content: got['file:' + id] });
  document.title = `${file.name} · Claude in Zen`;
  $('name').textContent = file.name;
  $('info').textContent = [file.title, `${(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB`, new Date(file.created).toLocaleString()].filter(Boolean).join(' · ');
  render();
  buildMenu();
  if (new URLSearchParams(location.search).get('pdf')) setTimeout(savePdf, 400);
})();

// Download saves the file in its own format; the small button beside it offers the others.
const EXT = () => ((/\.([a-z0-9]+)$/i.exec(file.name) || [])[1] || '').toLowerCase();
function formats() {
  const ext = EXT();
  const textual = /^(md|markdown|docx|pdf|html?|txt|doc)$/.test(ext);
  const table = /^(csv|tsv|xlsx)$/.test(ext);
  const out = [];
  if (textual) out.push(['docx', 'Word document', '.docx'], ['pdf', 'PDF', '.pdf'], ['html', 'Web page', '.html'], ['md', 'Markdown', '.md'], ['txt', 'Plain text', '.txt']);
  if (table) out.push(['xlsx', 'Excel workbook', '.xlsx'], ['csv', 'CSV table', '.csv']);
  if (!out.some(f => f[0] === ext)) out.unshift(['', 'Original', `.${ext || 'txt'}`]);
  return out.filter(f => f[0] !== ext || f[0] === '');
}
function buildMenu() {
  const menu = $('saveMenu');
  menu.textContent = '';
  for (const [fmt, label, hint] of formats()) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.append(label);
    const s = document.createElement('small'); s.textContent = hint; b.appendChild(s);
    b.addEventListener('click', () => { closeMenu(); if (fmt === 'pdf') savePdf(); else browser.runtime.sendMessage({ type: 'downloadFile', id, format: fmt }); });
    menu.appendChild(b);
  }
}
function closeMenu() { $('saveMenu').hidden = true; $('saveMore').setAttribute('aria-expanded', 'false'); }
$('saveMore').addEventListener('click', e => {
  e.stopPropagation();
  const open = $('saveMenu').hidden;
  $('saveMenu').hidden = !open;
  $('saveMore').setAttribute('aria-expanded', String(open));
  if (open) { const f = $('saveMenu').querySelector('button'); if (f) f.focus(); }
});
document.addEventListener('click', e => { if (!e.target.closest('.saveas')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

// PDF: Zen saves this page (shown formatted, without the toolbar) through its own save dialog.
async function savePdf() {
  if (!file) return;
  if (showRaw) { showRaw = false; render(); }
  const name = file.name.replace(/\.[a-z0-9]{1,8}$/i, '') + '.pdf';
  try {
    if (browser.tabs && browser.tabs.saveAsPDF) {
      await browser.tabs.saveAsPDF({ toFileName: name, shrinkToFit: true, showBackgroundColors: true,
        headerLeft: '', headerCenter: '', headerRight: '', footerLeft: '', footerCenter: '&P / &N', footerRight: '' });
      return;
    }
  } catch (e) { /* fall back to the print dialog */ }
  window.print();
}

$('raw').addEventListener('click', () => { showRaw = !showRaw; render(); });
$('copy').addEventListener('click', () => navigator.clipboard.writeText(file.content).then(() => { $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1400); }));
$('print').addEventListener('click', () => window.print());
$('download').addEventListener('click', () => { if (EXT() === 'pdf') savePdf(); else browser.runtime.sendMessage({ type: 'downloadFile', id }); });
