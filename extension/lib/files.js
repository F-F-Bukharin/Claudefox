'use strict';
// Claudefox: files Claude makes with create_file (documents, tables, code) and chat exports.
// They live in storage.local, so they survive restarts, until the user deletes them. The newest
// CFX_FILES_MAX files (and at most CFX_FILES_TOTAL bytes in all) are kept; older ones drop off.

const CFX_FILES_MAX = 200;
const CFX_FILES_TOTAL = 60 * 1024 * 1024;
const CFX_FILE_MAX = 5 * 1024 * 1024;

const CFX_FILE_TYPES = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', text: 'text/plain', log: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain', json: 'application/json', csv: 'text/csv',
  tsv: 'text/tab-separated-values', xml: 'application/xml', svg: 'image/svg+xml', yaml: 'text/yaml',
  yml: 'text/yaml', toml: 'text/plain', ini: 'text/plain', py: 'text/x-python', java: 'text/plain',
  c: 'text/plain', h: 'text/plain', cpp: 'text/plain', cs: 'text/plain', go: 'text/plain', rs: 'text/plain',
  rb: 'text/plain', php: 'text/plain', sh: 'text/plain', bat: 'text/plain', ps1: 'text/plain', sql: 'text/plain',
  lua: 'text/plain', kt: 'text/plain', swift: 'text/plain', tex: 'text/plain', bib: 'text/plain',
  ics: 'text/calendar', vcf: 'text/vcard', rtf: 'application/rtf', doc: 'application/msword',
  srt: 'text/plain', vtt: 'text/vtt',
  // Stored as the Markdown, HTML or CSV Claude wrote; lib/docx.js builds the real file on download (PDF: the viewer).
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const CFX_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

// A file name that is safe on Windows and in the downloads folder: no folders, no reserved characters.
function cfxSafeFileName(raw, fallback) {
  let name = String(raw == null ? '' : raw).replace(/^.*[\\/]/, '');
  name = name.replace(/[\u0000-\u001f<>:"|?*\u007f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = fallback || 'document.md';
  if (CFX_RESERVED_NAMES.test(name)) name = '_' + name;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += '.md';
  if (name.length > 120) {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)[0];
    name = name.slice(0, 120 - ext.length).trim() + ext;
  }
  return name;
}

function cfxFileType(name) {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(name) || [])[1] || '';
  return CFX_FILE_TYPES[ext.toLowerCase()] || 'text/plain';
}

const cfxFiles = {
  async list() {
    try {
      const got = await browser.storage.local.get('files');
      return Array.isArray(got.files) ? got.files : [];
    } catch { return []; }
  },

  async add({ name, content, title, source, conv, msg }) {
    const text = typeof content === 'string' ? content : content == null ? '' : String(content);
    if (!text) throw new Error('The file is empty: give it some content.');
    const size = new TextEncoder().encode(text).length;
    if (size > CFX_FILE_MAX) throw new Error(`That file is ${(size / 1048576).toFixed(1)} MB; the limit is 5 MB. Split it into smaller files.`);
    const fname = cfxSafeFileName(name);
    const meta = {
      id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: fname, mime: cfxFileType(fname), size, created: Date.now(),
      title: String(title || '').slice(0, 200), source: String(source || 'Claude').slice(0, 40),
      conv: String(conv || ''), msg: String(msg || ''),
    };
    const list = await this.list();
    list.unshift(meta);
    // Keep the newest files within the limits.
    const drop = [];
    let total = 0;
    const keep = list.filter((f, i) => {
      total += f.size || 0;
      const ok = i < CFX_FILES_MAX && (i === 0 || total <= CFX_FILES_TOTAL);
      if (!ok) drop.push(f.id);
      return ok;
    });
    await browser.storage.local.set({ ['file:' + meta.id]: text, files: keep });
    if (drop.length) await browser.storage.local.remove(drop.map(id => 'file:' + id));
    return meta;
  },

  async get(id) {
    const list = await this.list();
    const meta = list.find(f => f.id === id);
    if (!meta) return null;
    const got = await browser.storage.local.get('file:' + id);
    return Object.assign({}, meta, { content: typeof got['file:' + id] === 'string' ? got['file:' + id] : '' });
  },

  async remove(id) {
    const list = await this.list();
    await browser.storage.local.set({ files: list.filter(f => f.id !== id) });
    await browser.storage.local.remove('file:' + id);
  },
};
