'use strict';
// Claudefox: real Office files from what Claude writes. create_file stores text (Markdown, HTML or CSV). When the
// user downloads a .docx or .xlsx, this builds the file: Markdown (rendered by lib/markdown.js) or HTML is walked into
// WordprocessingML with headings, lists, tables, code, quotes, links and page numbers; CSV (or Markdown tables) goes
// into a spreadsheet. The parts are zipped without compression, which Word and Excel open like any other file.

const CFX_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// ---------------------------------------------------------------- zip (stored, UTF-8 names)

const cfxCrcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

function cfxCrc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = cfxCrcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: string | Uint8Array }] -> Uint8Array of the zip.
function cfxZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = cfxCrc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

// ---------------------------------------------------------------- shared helpers

function cfxXml(s) {
  return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cfxLooksHtml(text) { return /^\s*</.test(String(text)) && /<\/?(p|div|h[1-6]|ul|ol|table|body|html|section|article|span|br|b|strong|em|a)\b/i.test(String(text)); }

function cfxBaseName(name) { return String(name || 'document').replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'document'; }

// The content as a detached DOM tree: Markdown through the panel's renderer, HTML through DOMParser (inert: no
// scripts run and nothing loads).
function cfxSourceDom(content, isHtml) {
  if (isHtml) {
    const doc = new DOMParser().parseFromString(String(content), 'text/html');
    for (const el of doc.querySelectorAll('script, style, noscript, template, iframe, object, embed')) el.remove();
    return doc.body || doc.documentElement;
  }
  const box = document.createElement('div');
  // \pagebreak (or \newpage) on a line of its own starts a new page in Word and in print.
  cfxMarkdown(box, String(content).replace(/^[ \t]*\\(pagebreak|newpage)[ \t]*$/gm, '⁣PAGEBREAK⁣'), null);
  return box;
}

// ---------------------------------------------------------------- Word

const CFX_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const CFX_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CFX_INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'img', 'ins', 'kbd', 'mark',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'label', 'font']);
const CFX_SKIP = /^(script|style|template|button|svg|canvas|input|select|textarea|noscript|iframe|video|audio|form)$/;

function cfxDocxBody(root) {
  const rels = [];          // hyperlinks: { id, url }
  const nums = [];          // ordered list instances: { id, start, depth }
  let numSeq = 2;           // numId 1 = bullets
  let out = [];
  let firstBlock = true;

  function rPr(f) {
    let p = '';
    if (f.style) p += `<w:rStyle w:val="${f.style}"/>`;
    if (f.code) p += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
    if (f.b) p += '<w:b/><w:bCs/>';
    if (f.i) p += '<w:i/><w:iCs/>';
    if (f.strike) p += '<w:strike/>';
    if (f.code) p += '<w:sz w:val="20"/><w:szCs w:val="20"/>';
    if (f.mark) p += '<w:highlight w:val="yellow"/>';
    if (f.u) p += '<w:u w:val="single"/>';
    if (f.code && !f.block) p += '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>';
    if (f.sup) p += '<w:vertAlign w:val="superscript"/>';
    else if (f.sub) p += '<w:vertAlign w:val="subscript"/>';
    return p ? `<w:rPr>${p}</w:rPr>` : '';
  }

  function runs(text, f) {
    const pr = rPr(f || {});
    let x = '';
    String(text).split('\n').forEach((line, i) => {
      if (i) x += `<w:r>${pr}<w:br/></w:r>`;
      line.split('\t').forEach((seg, j) => {
        if (j) x += `<w:r>${pr}<w:tab/></w:r>`;
        if (seg) x += `<w:r>${pr}<w:t xml:space="preserve">${cfxXml(seg)}</w:t></w:r>`;
      });
    });
    return x;
  }

  function inline(nodes, f) {
    let x = '';
    for (const n of nodes) {
      if (n.nodeType === 3) { x += runs(n.nodeValue.replace(/[ \t\r\n\f]+/g, ' '), f); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (CFX_SKIP.test(tag) || (n.classList && n.classList.contains('codehead'))) continue;
      if (tag === 'br') { x += '<w:r><w:br/></w:r>'; continue; }
      if (tag === 'img') { const alt = n.getAttribute('alt'); if (alt) x += runs(`[${alt}]`, Object.assign({}, f, { i: true })); continue; }
      const g = Object.assign({}, f);
      if (tag === 'strong' || tag === 'b') g.b = true;
      else if (tag === 'em' || tag === 'i' || tag === 'cite' || tag === 'dfn' || tag === 'var') g.i = true;
      else if (tag === 'u' || tag === 'ins') g.u = true;
      else if (tag === 's' || tag === 'del' || tag === 'strike') g.strike = true;
      else if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') g.code = true;
      else if (tag === 'mark') g.mark = true;
      else if (tag === 'sup') g.sup = true;
      else if (tag === 'sub') g.sub = true;
      if (tag === 'q') { x += runs('“', g) + inline(n.childNodes, g) + runs('”', g); continue; }
      if (tag === 'a') {
        const href = n.getAttribute('href') || '';
        if (/^(https?:|mailto:)/i.test(href)) {
          const id = `rIdL${rels.length + 1}`;
          rels.push({ id, url: href });
          x += `<w:hyperlink r:id="${id}" w:history="1">${inline(n.childNodes, Object.assign({}, g, { style: 'Hyperlink' }))}</w:hyperlink>`;
          continue;
        }
      }
      x += inline(n.childNodes, g);
    }
    return x;
  }

  const textOf = x => x.replace(/<[^>]+>/g, '');
  function para(content, pPr) {
    if (textOf(content) === '⁣PAGEBREAK⁣') return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
  }
  const push = x => { out.push(x); firstBlock = false; };
  const collect = fn => { const saved = out; out = []; fn(); const r = out.join(''); out = saved; return r; };

  function heading(el) {
    const m = /\bmdh([1-6])\b/.exec(el.className || '');
    let level = m ? +m[1] : +el.tagName[1];
    const style = firstBlock && level === 1 ? 'Title' : `Heading${Math.min(6, level)}`;
    push(para(inline(el.childNodes, {}), `<w:pStyle w:val="${style}"/>`));
  }

  function code(el) {
    const pre = el.tagName.toLowerCase() === 'pre' ? el : el.querySelector('pre');
    const text = (pre || el).textContent.replace(/\n$/, '');
    for (const line of text.split('\n')) push(para(runs(line, { code: true, block: true }), '<w:pStyle w:val="Code"/>'));
  }

  function list(el, depth, quote) {
    const ordered = el.tagName.toLowerCase() === 'ol';
    const d = Math.min(8, depth);
    let numId = 1;
    if (ordered) {
      numId = numSeq++;
      nums.push({ id: numId, start: Math.max(1, parseInt(el.getAttribute('start'), 10) || 1), depth: d });
    }
    const item = `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${d}"/><w:numId w:val="${numId}"/></w:numPr>`;
    const more = `<w:pStyle w:val="ListParagraph"/><w:ind w:left="${720 * (d + 1)}"/>`;
    for (const li of el.children) {
      if (li.tagName.toLowerCase() !== 'li') continue;
      let started = false, buf = [];
      const flush = () => {
        const content = inline(buf, {});
        buf = [];
        if (!started) { push(para(content, item)); started = true; }
        else if (textOf(content).trim()) push(para(content, more));
      };
      for (const n of li.childNodes) {
        const tag = n.nodeType === 1 ? n.tagName.toLowerCase() : '';
        if (tag === 'ul' || tag === 'ol') { flush(); list(n, depth + 1, quote); continue; }
        if (tag === 'p' || tag === 'div') { if (buf.some(b => (b.textContent || '').trim())) flush(); buf = Array.from(n.childNodes); flush(); continue; }
        if (tag === 'pre' || (n.classList && n.classList.contains('codeblock'))) { flush(); code(n); continue; }
        if (tag === 'table' || (n.classList && n.classList.contains('tablewrap'))) { flush(); blocks(n, quote); continue; }
        buf.push(n);
      }
      if (buf.length || !started) flush();
    }
  }

  function table(el) {
    const rows = Array.from(el.querySelectorAll('tr')).filter(tr => tr.closest('table') === el);
    if (!rows.length) return;
    const cellsOf = tr => Array.from(tr.children).filter(c => /^t[dh]$/i.test(c.tagName));
    const width = Math.max(1, ...rows.map(tr => cellsOf(tr).reduce((n, c) => n + (parseInt(c.getAttribute('colspan'), 10) || 1), 0)));
    const col = Math.floor(9000 / width);
    let x = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${col * width}" w:type="dxa"/>`
      + '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>'
      + `<w:tblGrid>${`<w:gridCol w:w="${col}"/>`.repeat(width)}</w:tblGrid>`;
    for (const tr of rows) {
      const cells = cellsOf(tr);
      const head = (tr.parentElement && tr.parentElement.tagName.toLowerCase() === 'thead') || (cells.length && cells.every(c => c.tagName.toLowerCase() === 'th'));
      x += `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
      let used = 0;
      for (const c of cells) {
        if (used >= width) break;
        const span = Math.max(1, Math.min(width - used, parseInt(c.getAttribute('colspan'), 10) || 1));
        used += span;
        const bold = head || c.tagName.toLowerCase() === 'th';
        const blocky = Array.from(c.children).some(k => /^(p|ul|ol|div|pre|table|h[1-6]|blockquote)$/i.test(k.tagName));
        const inner = blocky ? collect(() => blocks(c, false)) : para(inline(c.childNodes, bold ? { b: true } : {}));
        x += `<w:tc><w:tcPr><w:tcW w:w="${col * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}`
          + `${bold ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${inner || '<w:p/>'}</w:tc>`;
      }
      for (; used < width; used++) x += `<w:tc><w:tcPr><w:tcW w:w="${col}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`;
      x += '</w:tr>';
    }
    push(x + '</w:tbl>');
    push('<w:p/>');   // Word needs a paragraph after a table, and it keeps tables apart
  }

  function blocks(node, quote) {
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const content = inline(buf, {});
      buf = [];
      if (textOf(content).trim() || /<w:br\/>/.test(content)) push(para(content, quote ? '<w:pStyle w:val="Quote"/>' : ''));
    };
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) buf.push(n); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (CFX_SKIP.test(tag)) continue;
      if (CFX_INLINE.has(tag) && !(n.classList && n.classList.contains('codeblock'))) { buf.push(n); continue; }
      flush();
      if (/^h[1-6]$/.test(tag)) heading(n);
      else if (tag === 'p') { const c = inline(n.childNodes, {}); if (textOf(c).trim() || /<w:br\/>/.test(c)) push(para(c, quote ? '<w:pStyle w:val="Quote"/>' : '')); }
      else if (tag === 'ul' || tag === 'ol') list(n, 0, quote);
      else if (tag === 'table') table(n);
      else if (tag === 'pre' || (n.classList && n.classList.contains('codeblock'))) code(n);
      else if (tag === 'blockquote') blocks(n, true);
      else if (tag === 'hr') push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A6A6A6"/></w:pBdr></w:pPr></w:p>');
      else if (tag === 'dt') push(para(inline(n.childNodes, { b: true })));
      else if (tag === 'dd') push(para(inline(n.childNodes, {}), '<w:ind w:left="567"/>'));
      else if (tag === 'img') { const alt = n.getAttribute('alt'); if (alt) push(para(runs(`[${alt}]`, { i: true }))); }
      else if (n.classList && n.classList.contains('page-break')) push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
      else blocks(n, quote);   // div, section, article, figure, dl, details, tablewrap...
    }
    flush();
  }

  blocks(root, false);
  return { body: out.join(''), rels, nums };
}

function cfxDocxStyles(lang) {
  const font = '<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
  const head = (id, name, level, size, color, before) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>`
    + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>'
    + `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
    + `<w:rPr><w:b/><w:bCs/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${CFX_W}">`
    + `<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="${cfxXml(lang)}"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/>'
    + '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:color w:val="1F3864"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>'
    + head('Heading1', 'heading 1', 1, 32, '2F5496', 360) + head('Heading2', 'heading 2', 2, 28, '2F5496', 280)
    + head('Heading3', 'heading 3', 3, 24, '1F3763', 240) + head('Heading4', 'heading 4', 4, 22, '1F3763', 200)
    + head('Heading5', 'heading 5', 5, 22, '404040', 160) + head('Heading6', 'heading 6', 6, 22, '595959', 160)
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/>'
    + '<w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/>'
    + '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/>'
    + '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'
    + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/>'
    + '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/>'
    + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(b => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`).join('')
    + '</w:tblBorders></w:tblPr></w:style></w:styles>';
}

function cfxDocxNumbering(nums) {
  const bullets = ['•', '◦', '▪'];
  const fmts = [['decimal', '%1.'], ['lowerLetter', '%2.'], ['lowerRoman', '%3.']];
  const lvl = (i, fmt, text) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${CFX_W}">`;
  x += '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>';
  for (let i = 0; i < 9; i++) x += lvl(i, 'bullet', bullets[i % 3]);
  x += '</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>';
  for (let i = 0; i < 9; i++) x += lvl(i, fmts[i % 3][0], `%${i + 1}.`);
  x += '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
  for (const n of nums) x += `<w:num w:numId="${n.id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${n.depth}"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`;
  return x + '</w:numbering>';
}

// Markdown or HTML -> a .docx file (Uint8Array).
function cfxDocx(content, opts) {
  const o = opts || {};
  const title = String(o.title || 'Document');
  const lang = o.lang || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const { body, rels, nums } = cfxDocxBody(cfxSourceDom(content, o.html != null ? o.html : cfxLooksHtml(content)));
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${CFX_W}" xmlns:r="${CFX_R}"><w:body>${body || '<w:p/>'}`
    + '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr xmlns:w="${CFX_W}" xmlns:r="${CFX_R}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>`
    + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>';
  const rel = (id, type, target, ext) => `<Relationship Id="${id}" Type="${type}" Target="${cfxXml(target)}"${ext ? ' TargetMode="External"' : ''}/>`;
  const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + rel('rIdStyles', OD + 'styles', 'styles.xml') + rel('rIdNumbering', OD + 'numbering', 'numbering.xml')
    + rel('rIdSettings', OD + 'settings', 'settings.xml') + rel('rIdFooter', OD + 'footer', 'footer1.xml')
    + rels.map(l => rel(l.id, OD + 'hyperlink', l.url, true)).join('') + '</Relationships>';
  const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + `<Override PartName="/word/document.xml" ContentType="${CT}document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${CT}styles+xml"/>`
      + `<Override PartName="/word/numbering.xml" ContentType="${CT}numbering+xml"/><Override PartName="/word/settings.xml" ContentType="${CT}settings+xml"/>`
      + `<Override PartName="/word/footer1.xml" ContentType="${CT}footer+xml"/>`
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + rel('rId1', OD + 'officeDocument', 'word/document.xml') + rel('rId2', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml')
      + rel('rId3', OD + 'extended-properties', 'docProps/app.xml') + '</Relationships>' },
    { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + `<dc:title>${cfxXml(title)}</dc:title><dc:creator>Claudefox</dc:creator>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Claudefox</Application></Properties>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: cfxDocxStyles(lang) },
    { name: 'word/numbering.xml', data: cfxDocxNumbering(nums) },
    { name: 'word/settings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${CFX_W}"><w:defaultTabStop w:val="708"/>`
      + '<w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>' },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/footer1.xml', data: footer },
  ];
  return cfxZip(files);
}

// ---------------------------------------------------------------- Excel

function cfxCsvRows(text, sep) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Sheets from what Claude wrote: Markdown tables (one sheet each, named by the heading above) or CSV / TSV.
function cfxSheets(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const sheets = [];
  let title = '';
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (h) { title = h[1]; continue; }
    if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|').replace(/\*\*|__|`/g, ''));
      const rows = [cells(lines[i])];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      sheets.push({ name: title || `Table ${sheets.length + 1}`, rows });
      title = '';
    }
  }
  if (sheets.length) return sheets;
  const first = lines.find(l => l.trim()) || '';
  const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t'
    : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  return [{ name: 'Sheet1', rows: cfxCsvRows(text, sep).filter(r => r.some(c => String(c).trim())) }];
}

function cfxColName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

function cfxXlsx(content) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const sheets = cfxSheets(content).slice(0, 50);
  const used = new Set();
  const names = sheets.map((s, i) => {
    let n = String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    while (used.has(n.toLowerCase())) n = `${n.slice(0, 28)} ${i + 1}`;
    used.add(n.toLowerCase());
    return n;
  });
  const files = [];
  sheets.forEach((s, si) => {
    const rows = s.rows.slice(0, 100000);
    const widths = [];
    let data = '';
    rows.forEach((r, ri) => {
      data += `<row r="${ri + 1}">`;
      r.slice(0, 500).forEach((v, ci) => {
        const val = String(v == null ? '' : v);
        widths[ci] = Math.max(widths[ci] || 0, Math.min(60, val.length));
        if (val === '') return;
        const ref = `${cfxColName(ci)}${ri + 1}`;
        const style = ri === 0 ? ' s="1"' : '';
        if (ri > 0 && /^-?(\d+|\d*\.\d+)(e[+-]?\d+)?$/i.test(val) && val.length < 16) data += `<c r="${ref}"${style}><v>${val}</v></c>`;
        else data += `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${cfxXml(val)}</t></is></c>`;
      });
      data += '</row>';
    });
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, w + 2)}" customWidth="1"/>`).join('')}</cols>` : '';
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}">`
      + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + `${cols}<sheetData>${data}</sheetData></worksheet>` });
  });
  const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const R = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
  return cfxZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + `<Override PartName="/xl/workbook.xml" ContentType="${CT}sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}styles+xml"/>`
      + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}worksheet+xml"/>`).join('') + '</Types>' },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${R}"><Relationship Id="rId1" Type="${OD}officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${CFX_R}"><sheets>`
      + names.map((n, i) => `<sheet name="${cfxXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${R}">`
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${OD}worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${OD}styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}">`
      + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' },
    ...files,
  ]);
}

// ---------------------------------------------------------------- HTML page

const CFX_PAGE_CSS = 'body{margin:0;background:#fff;color:#1f1e1c;font:16px/1.6 system-ui,"Segoe UI",sans-serif}'
  + 'main{max-width:820px;margin:40px auto;padding:0 24px}h1,h2,h3,h4,h5,h6{font-family:Georgia,"Iowan Old Style",serif;line-height:1.25;margin:1.3em 0 .4em}'
  + 'code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;background:#f2efe8;border-radius:4px;padding:0 4px}'
  + 'pre{background:#f2efe8;padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}'
  + 'table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid #d9d4ca;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f2efe8}'
  + 'blockquote{border-left:3px solid #d9d4ca;margin:1em 0;padding-left:14px;color:#55524c}a{color:#b5532f}hr{border:0;border-top:1px solid #d9d4ca}'
  + '.page-break{break-after:page}@media print{main{margin:0;max-width:none}}';

// A complete web page from Markdown (rendered) or from HTML (kept as written).
function cfxHtmlPage(content, title) {
  if (cfxLooksHtml(content) && /<html[\s>]/i.test(content)) return String(content);
  let body;
  if (cfxLooksHtml(content)) body = String(content);
  else {
    const box = cfxSourceDom(content, false);
    for (const el of box.querySelectorAll('.codehead')) el.remove();
    for (const p of box.querySelectorAll('p')) if (p.textContent === '⁣PAGEBREAK⁣') { p.className = 'page-break'; p.textContent = ''; }
    for (const h of box.querySelectorAll('[class*="mdh"]')) {   // the panel renders # as h3: put real heading levels back
      const m = /\bmdh([1-6])\b/.exec(h.className);
      if (!m) continue;
      const n = document.createElement('h' + m[1]);
      while (h.firstChild) n.appendChild(h.firstChild);
      h.replaceWith(n);
    }
    body = box.innerHTML;
  }
  return `<!doctype html>\n<html lang="${cfxXml((typeof navigator !== 'undefined' && navigator.language) || 'en')}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${cfxXml(title)}</title><style>${CFX_PAGE_CSS}</style></head>`
    + `<body><main>${body}</main></body></html>\n`;
}

// What a file becomes for a download in one format: { data: Uint8Array | string, mime, name }.
// format: 'docx' | 'xlsx' | 'html' | 'md' | 'txt' | 'csv' | '' (the file's own format).
function cfxExport(file, format) {
  const ext = ((/\.([a-z0-9]{1,8})$/i.exec(file.name) || [])[1] || '').toLowerCase();
  const want = String(format || ext).toLowerCase();
  const base = cfxBaseName(file.name);
  const title = String(file.title || base);
  if (want === 'docx') return { data: cfxDocx(file.content, { title }), mime: CFX_MIME.docx, name: `${base}.docx` };
  if (want === 'xlsx') return { data: cfxXlsx(file.content), mime: CFX_MIME.xlsx, name: `${base}.xlsx` };
  if (want === 'html' && ext !== 'html' && ext !== 'htm') return { data: cfxHtmlPage(file.content, title), mime: 'text/html', name: `${base}.html` };
  if (want === ext || !want) return { data: file.content, mime: file.mime || 'text/plain', name: file.name };
  const mime = { md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html' }[want] || 'text/plain';
  return { data: file.content, mime, name: `${base}.${want}` };
}
