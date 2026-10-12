'use strict';
// Text out of Office and OpenDocument files (.docx, .pptx, .xlsx, .odt, .odp, .ods), which Claude Code's Read tool
// cannot open. They are zip archives of XML: this reads only the parts that hold the text, with size caps, and turns
// them into Markdown (headings, lists, tables, one section per slide or sheet).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_FILE = 60 * 1024 * 1024;     // bigger files are refused
const MAX_PART = 48 * 1024 * 1024;     // largest unpacked part read
const MAX_TEXT = 4 * 1024 * 1024;      // longest text returned
const MAX_ROWS = 5000, MAX_COLS = 80;

const KINDS = {
  docx: 'Word document', docm: 'Word document', dotx: 'Word template',
  pptx: 'PowerPoint presentation', pptm: 'PowerPoint presentation', ppsx: 'PowerPoint show',
  xlsx: 'Excel workbook', xlsm: 'Excel workbook',
  odt: 'OpenDocument text', ods: 'OpenDocument spreadsheet', odp: 'OpenDocument presentation',
};

function kindOf(file) { return KINDS[path.extname(String(file)).slice(1).toLowerCase()] || ''; }

// ---------------------------------------------------------------- zip

function readZip(buf) {
  const min = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('the file is damaged or not really an Office file (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20), usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    entries.set(buf.toString('utf8', off + 46, off + 46 + nlen), { method, csize, usize, local });
    off += 46 + nlen + xlen + clen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.usize > MAX_PART || e.csize > MAX_PART) throw new Error(`a part of the file (${name}) is too large to read`);
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('the file is damaged');
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data.toString('utf8');
      if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_PART }).toString('utf8');
      throw new Error('the file uses a compression this reader does not know');
    },
  };
}

// ---------------------------------------------------------------- XML helpers

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENT[e.toLowerCase()];
    try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return ''; }
  });
}

const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? decode(m[1]) : ''; };
const cellText = s => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' <br> ').trim();

function mdTable(rows) {
  const width = Math.min(MAX_COLS, Math.max(0, ...rows.map(r => r.length)));
  if (!width) return '';
  const pad = r => Array.from({ length: width }, (_, i) => cellText(r[i] || ''));
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- Word

// Paragraph styles that mean a heading (by level) or a list item (by indent level). Localized documents rename the
// style ids ("Ttulo1"), so the English style name or the outline level decides.
function paragraphStyles(stylesXml) {
  const levels = {}, lists = {};
  if (!stylesXml) return { levels, lists };
  const re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = re.exec(stylesXml))) {
    const id = attr(m[1], 'w:styleId');
    const name = (/<w:name w:val="([^"]*)"/.exec(m[2]) || [])[1] || '';
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(m[2]);
    const h = /^heading (\d)$/i.exec(name);
    if (h) levels[id] = Math.min(6, +h[1]);
    else if (/^title$/i.test(name)) levels[id] = 1;
    else if (/^subtitle$/i.test(name)) levels[id] = 2;
    else if (outline && +outline[1] < 6) levels[id] = +outline[1] + 1;
    if (/<w:numPr\b/.test(m[2]) || /^list (bullet|number)/i.test(name)) {
      const ilvl = /<w:ilvl w:val="(\d)"/.exec(m[2]);
      const n = /(\d)$/.exec(name);
      lists[id] = ilvl ? +ilvl[1] : n ? Math.max(0, +n[1] - 1) : 0;
    }
  }
  return { levels, lists };
}

function wordXml(xml, styles) {
  const levels = styles.levels, lists = styles.lists;
  const out = [];
  const tables = [];          // stack of { rows, row, cell }
  let para = null;
  const re = /<(\/?)(w:tbl|w:tr|w:tc|w:p|w:pStyle|w:ilvl|w:numPr|w:t|m:t|w:tab|w:br|w:cr|w:delText|w:instrText|w:footnoteReference|w:endnoteReference)\b([^>]*?)(\/?)>/g;
  let m;
  const emit = text => {
    const t = tables[tables.length - 1];
    if (t && t.cell) t.cell.push(text);
    else out.push(text);
  };
  while ((m = re.exec(xml))) {
    const [, close, tag, rest, self] = m;
    if (tag === 'w:t' || tag === 'm:t' || tag === 'w:delText' || tag === 'w:instrText') {
      if (close || self) continue;
      const end = xml.indexOf(`</${tag}>`, re.lastIndex);
      if (end === -1) break;
      if ((tag === 'w:t' || tag === 'm:t') && para) para.text += decode(xml.slice(re.lastIndex, end));
      re.lastIndex = end + tag.length + 3;
      continue;
    }
    if (tag === 'w:p') {
      if (!close && !self) para = { text: '', level: 0, list: false, ilvl: 0 };
      else if (self && !close) emit('');
      else if (close && para) {
        let text = para.text.replace(/[ \t]+$/g, '');
        if (para.level && text.trim()) text = `${'#'.repeat(para.level)} ${text.trim()}`;
        else if (para.list && text.trim()) text = `${'  '.repeat(para.ilvl)}- ${text.trim()}`;
        emit(text);
        para = null;
      }
      continue;
    }
    if (tag === 'w:pStyle' && para) {
      const id = attr(rest, 'w:val');
      if (levels[id]) para.level = levels[id];
      if (lists[id] != null) { para.list = true; para.ilvl = Math.max(para.ilvl, lists[id]); }
      continue;
    }
    if (tag === 'w:numPr' && para && !close) { para.list = true; continue; }
    if (tag === 'w:ilvl' && para) { para.ilvl = Math.min(8, +attr(rest, 'w:val') || 0); continue; }
    if (tag === 'w:tab' && para) { para.text += '\t'; continue; }
    if ((tag === 'w:br' || tag === 'w:cr') && para) { para.text += /w:type="page"/.test(rest) ? '\n\n' : '\n'; continue; }
    if ((tag === 'w:footnoteReference' || tag === 'w:endnoteReference') && para) { para.text += `[^${attr(rest, 'w:id')}]`; continue; }
    if (tag === 'w:tbl') {
      if (!close) tables.push({ rows: [], row: null, cell: null });
      else {
        const t = tables.pop();
        if (t) emit('\n' + mdTable(t.rows) + '\n');
      }
      continue;
    }
    const t = tables[tables.length - 1];
    if (!t) continue;
    if (tag === 'w:tr') { if (!close) t.row = []; else if (t.row) { if (t.rows.length < MAX_ROWS) t.rows.push(t.row); t.row = null; } continue; }
    if (tag === 'w:tc') {
      if (!close) t.cell = [];
      else if (t.cell) { if (t.row) t.row.push(t.cell.filter(Boolean).join('\n')); t.cell = null; }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function docxText(zip) {
  const levels = paragraphStyles(zip.read('word/styles.xml'));
  const parts = [];
  const body = zip.read('word/document.xml');
  if (body == null) throw new Error('no document text found inside');
  parts.push(wordXml(body, levels));
  for (const [file, title] of [['word/footnotes.xml', 'Footnotes'], ['word/endnotes.xml', 'Endnotes'], ['word/comments.xml', 'Comments']]) {
    const xml = zip.read(file);
    if (!xml) continue;
    const text = wordXml(xml, levels);
    if (text.replace(/\s/g, '').length > 2) parts.push(`## ${title}\n\n${text}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- PowerPoint

function rels(zip, file) {
  const xml = zip.read(file);
  const map = {};
  if (!xml) return map;
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) map[attr(m[1], 'Id')] = { target: attr(m[1], 'Target'), type: attr(m[1], 'Type') };
  return map;
}

function joinPath(dir, rel) { return path.posix.normalize(path.posix.join(dir, rel)).replace(/^\/+/, ''); }

function drawingText(xml) {
  const lines = [];
  const re = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    const runs = [];
    const r = /<a:t>([\s\S]*?)<\/a:t>|<a:br\/>/g;
    let t;
    while ((t = r.exec(m[1]))) runs.push(t[1] != null ? decode(t[1]) : '\n');
    const line = runs.join('').trim();
    if (line) lines.push(line);
  }
  return lines;
}

function pptxText(zip) {
  const pres = zip.read('ppt/presentation.xml') || '';
  const prel = rels(zip, 'ppt/_rels/presentation.xml.rels');
  let slides = [];
  const re = /<p:sldId\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(pres))) {
    const r = prel[attr(m[1], 'r:id')];
    if (r) slides.push(joinPath('ppt', r.target));
  }
  if (!slides.length) {
    slides = zip.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => +/(\d+)\.xml$/.exec(a)[1] - +/(\d+)\.xml$/.exec(b)[1]);
  }
  const out = [];
  slides.forEach((file, i) => {
    const xml = zip.read(file);
    if (xml == null) return;
    const lines = drawingText(xml);
    out.push(`## Slide ${i + 1}${lines.length ? ': ' + lines[0].slice(0, 120) : ''}`);
    if (lines.length > 1) out.push(lines.slice(1).map(l => `- ${l}`).join('\n'));
    const srel = rels(zip, file.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'));
    const note = Object.values(srel).find(x => /notesSlide$/.test(x.type));
    if (note) {
      const nx = zip.read(joinPath(path.posix.dirname(file), note.target));
      const nl = nx ? drawingText(nx).filter(l => !/^\d+$/.test(l)) : [];
      if (nl.length) out.push(`Notes: ${nl.join(' ')}`);
    }
    out.push('');
  });
  return out.join('\n').trim();
}

// ---------------------------------------------------------------- Excel

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function xlsxText(zip) {
  const shared = [];
  const ss = zip.read('xl/sharedStrings.xml');
  if (ss) {
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(ss))) {
      const parts = [];
      const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let x;
      while ((x = t.exec(m[1]))) parts.push(decode(x[1]));
      shared.push(parts.join(''));
    }
  }
  const book = zip.read('xl/workbook.xml') || '';
  const brel = rels(zip, 'xl/_rels/workbook.xml.rels');
  const sheets = [];
  const re = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(book))) {
    const r = brel[attr(m[1], 'r:id')];
    if (r) sheets.push({ name: attr(m[1], 'name'), file: r.target.startsWith('/') ? r.target.slice(1) : joinPath('xl', r.target) });
  }
  const out = [];
  for (const sh of sheets) {
    const xml = zip.read(sh.file);
    if (xml == null) continue;
    const rows = [];
    const rr = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let row;
    while ((row = rr.exec(xml)) && rows.length < MAX_ROWS) {
      const cells = [];
      const cr = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let c;
      while ((c = cr.exec(row[1]))) {
        const at = colIndex(attr(c[1], 'r'));
        const type = attr(c[1], 't');
        const inner = c[2] || '';
        let v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        v = v == null ? '' : decode(v);
        if (type === 's') v = shared[+v] != null ? shared[+v] : '';
        else if (type === 'inlineStr') v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => decode(x[1])).join('');
        else if (type === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        const col = at >= 0 ? at : cells.length;
        if (col < MAX_COLS) cells[col] = v;
      }
      if (cells.some(x => x !== undefined && x !== '')) rows.push(Array.from(cells, x => (x === undefined ? '' : x)));
    }
    out.push(`## Sheet: ${sh.name || sh.file}`);
    out.push(rows.length ? rows.map(r => r.map(csvCell).join(',')).join('\n') : '(empty)');
    out.push('');
  }
  return out.join('\n').trim();
}

// ---------------------------------------------------------------- OpenDocument

function odfText(zip, kind) {
  const xml = zip.read('content.xml');
  if (xml == null) throw new Error('no content found inside');
  const out = [];
  const tables = [];
  let para = null, slide = 0;
  const re = /<(\/?)(text:p|text:h|text:span|text:s|text:tab|text:line-break|table:table|table:table-row|table:table-cell|draw:page|text:list-item)\b([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  const emit = s => { const t = tables[tables.length - 1]; if (t && t.cell) t.cell.push(s); else out.push(s); };
  while ((m = re.exec(xml))) {
    if (m[5] != null) { if (para) para.text += decode(m[5]); continue; }
    const [, close, tag, rest, self] = m;
    if (tag === 'text:p' || tag === 'text:h') {
      if (!close && !self) para = { text: '', level: tag === 'text:h' ? Math.min(6, +attr(rest, 'text:outline-level') || 1) : 0 };
      else if (close && para) { const t = para.text.trim(); emit(para.level && t ? `${'#'.repeat(para.level)} ${t}` : t); para = null; }
      continue;
    }
    if (tag === 'text:s' && para) { para.text += ' '.repeat(Math.min(50, +attr(rest, 'text:c') || 1)); continue; }
    if (tag === 'text:tab' && para) { para.text += '\t'; continue; }
    if (tag === 'text:line-break' && para) { para.text += '\n'; continue; }
    if (tag === 'draw:page' && !close) { slide++; out.push(`\n## Slide ${slide}${attr(rest, 'draw:name') ? ': ' + attr(rest, 'draw:name') : ''}`); continue; }
    if (tag === 'table:table') {
      if (!close && !self) tables.push({ rows: [], row: null, cell: null, name: attr(rest, 'table:name') });
      else if (close) {
        const t = tables.pop();
        if (t) emit(`${kind === 'ods' && t.name ? `\n## Sheet: ${t.name}\n` : '\n'}${t.rows.length ? (kind === 'ods' ? t.rows.map(r => r.map(csvCell).join(',')).join('\n') : mdTable(t.rows)) : '(empty)'}\n`);
      }
      continue;
    }
    const t = tables[tables.length - 1];
    if (!t) continue;
    if (tag === 'table:table-row') {
      if (!close && !self) t.row = [];
      else if (close && t.row) { while (t.row.length && !t.row[t.row.length - 1]) t.row.pop(); if (t.row.length && t.rows.length < MAX_ROWS) t.rows.push(t.row); t.row = null; }
      continue;
    }
    if (tag === 'table:table-cell') {
      const repeat = Math.min(MAX_COLS, +attr(rest, 'table:number-columns-repeated') || 1);
      if (self && t.row) { for (let i = 0; i < repeat && t.row.length < MAX_COLS; i++) t.row.push(''); continue; }
      if (!close) t.cell = [];
      else if (t.cell && t.row) {
        const v = t.cell.filter(Boolean).join('\n');
        for (let i = 0; i < (v ? 1 : repeat) && t.row.length < MAX_COLS; i++) t.row.push(v);
        t.cell = null;
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------- entry point

// Returns { kind, text, truncated } for a supported file, or null when the file type is not one of these.
function extractText(file) {
  const kind = kindOf(file);
  if (!kind) return null;
  const size = fs.statSync(file).size;
  if (size > MAX_FILE) throw new Error(`the file is ${Math.round(size / 1048576)} MB; the limit is ${MAX_FILE / 1048576} MB`);
  const zip = readZip(fs.readFileSync(file));
  const ext = path.extname(file).slice(1).toLowerCase();
  let text;
  if (/^doc/.test(ext) || ext === 'dotx') text = docxText(zip);
  else if (/^pp/.test(ext)) text = pptxText(zip);
  else if (/^xls/.test(ext)) text = xlsxText(zip);
  else text = odfText(zip, ext);
  text = text.replace(/\u0000/g, '');
  const truncated = text.length > MAX_TEXT;
  return { kind, text: truncated ? text.slice(0, MAX_TEXT) : text, truncated };
}

module.exports = { extractText, kindOf, readZip, KINDS };
