'use strict';
// Opens a file Claude made (create_file): Markdown rendered, CSV as a table, HTML in a sandbox
// without scripts, SVG as an image, anything else as plain text. viewer.html#<file id>
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
  const kind = showRaw ? 'raw' : /^(md|markdown)$/i.test(ext) ? 'md' : /^(csv|tsv)$/i.test(ext) ? 'csv'
    : /^(html?|doc)$/i.test(ext) ? 'html' : /^svg$/i.test(ext) ? 'svg' : /^json$/i.test(ext) ? 'json' : 'raw';
  if (kind === 'md') cizMarkdown(view, file.content, (k, v) => { if (k === 'url') window.open(v, '_blank', 'noopener'); });
  else if (kind === 'csv') {
    const rows = csvRows(file.content, /tsv/i.test(ext) ? '\t' : ',').slice(0, 5000);
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
    for (const b of ['raw', 'copy', 'print', 'download']) $(b).disabled = true;
    return;
  }
  file = Object.assign({}, meta, { content: got['file:' + id] });
  document.title = `${file.name} · Claude in Zen`;
  $('name').textContent = file.name;
  $('info').textContent = [file.title, `${(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB`, new Date(file.created).toLocaleString()].filter(Boolean).join(' · ');
  render();
})();

$('raw').addEventListener('click', () => { showRaw = !showRaw; render(); });
$('copy').addEventListener('click', () => navigator.clipboard.writeText(file.content).then(() => { $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1400); }));
$('print').addEventListener('click', () => window.print());
$('download').addEventListener('click', () => browser.runtime.sendMessage({ type: 'downloadFile', id }));
