'use strict';
// The page operations that only read the page: read, text, analyze, selection, find, viewport, exists, ctype.
// Each is a declaration in the script cizPageCode (pageOp.js) injects into the tab. env is what cizPageEnv returns
// (the helpers and constants) and args is the call's arguments.

function cizOpRead(env, args) {
  const { INTERACTIVE, HEADINGS, clamp, isVisible, labelOf, refOf, describe, page } = env;
  const max = clamp(args.max_chars, 1000, 200000, 20000);
  const sel = args.filter === 'interactive' ? INTERACTIVE : INTERACTIVE + ', ' + HEADINGS;
  const lines = [];
  let total = 0, truncated = false;
  for (const el of document.querySelectorAll(sel)) {
    if (!isVisible(el)) continue;
    const line = /^H[1-6]$/.test(el.tagName)
      ? `${el.tagName.toLowerCase()}: ${labelOf(el).slice(0, 200)} [${refOf(el)}]`
      : describe(el);
    total += line.length + 1;
    if (total > max) { truncated = true; break; }
    lines.push(line);
  }
  return page({ text: lines.join('\n') || '(no visible headings or controls)', truncated });
}

function cizOpText(env, args) {
  const { clamp, page, mainRoot, markdown, metaInfo, words } = env;
  const max = clamp(args.max_chars, 1000, 200000, 40000);
  const start = clamp(args.start_at, 0, 50000000, 0);
  if (typeof args.query === 'string' && args.query.trim()) {
    // Query: the Markdown blocks (paragraphs, list items, table rows, code) that have a query word of 3 letters or more, in
    // any case, in page order, each under its nearest heading. Nothing matches: the first 40 headings instead.
    const root = mainRoot(args.scope);
    const md = markdown(root, 400000, { skipChrome: root === document.body && args.scope !== 'full' });
    const blocks = [], heads = [];
    let heading = null, cur = null, kind = null;   // kind: the open block, 'para', 'item' or 'code'
    for (const line of md.text.split('\n')) {
      if (kind === 'code') { cur.text += '\n' + line; if (/^\s*```\s*$/.test(line)) kind = null; continue; }
      if (!line.trim()) { kind = null; continue; }
      if (/^```/.test(line)) { kind = 'code'; cur = { heading, text: line }; blocks.push(cur); continue; }
      if (/^#{1,6} /.test(line)) { heading = line; heads.push(line); kind = null; continue; }
      if (/^\|/.test(line)) {   // a table row; the |---| line under the header is not text
        kind = null;
        if (!(/^[|\s:-]+$/.test(line) && line.includes('-'))) blocks.push({ heading, text: line.trim() });
        continue;
      }
      if (/^\s*([-*]|\d+\.) /.test(line)) { kind = 'item'; cur = { heading, text: line.replace(/\s+$/, '') }; blocks.push(cur); continue; }
      if (kind === 'item' && /^\s+\S/.test(line)) { cur.text += '\n' + line.replace(/\s+$/, ''); continue; }
      if (kind === 'para') { cur.text += '\n' + line.trim(); continue; }
      kind = 'para'; cur = { heading, text: line.trim() }; blocks.push(cur);
    }
    const want = (args.query.match(/\p{L}{3,}/gu) || []).map(x => x.toLowerCase());
    const hits = blocks.filter(b => want.some(x => b.text.toLowerCase().includes(x)));
    if (!hits.length) {
      const none = `No part of the page matches "${args.query.trim()}".`;
      return page({ text: heads.length ? none + '\n\n' + heads.slice(0, 40).join('\n') : none, truncated: false });
    }
    let out = '', shown;   // the heading written last
    for (const b of hits) {
      if (b.heading !== shown) { shown = b.heading; if (b.heading) out += (out ? '\n\n' : '') + b.heading; }
      out += (out ? '\n\n' : '') + b.text;
    }
    return page({ text: out.slice(0, max), truncated: out.length > max });
  }
  if (args.format === 'text') {
    const root = mainRoot(args.scope);
    let text = String((root && root.innerText) || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const total = text.length;
    text = text.slice(start, start + max);
    return page({ text, truncated: start + max < total, next_start: start + max < total ? start + max : null, total_chars: total });
  }
  const root = mainRoot(args.scope);
  const md = markdown(root, start + max + 2000, { skipChrome: root === document.body && args.scope !== 'full' });
  const total = md.text.length;
  const more = md.cut || start + max < total;
  const body = md.text.slice(start, start + max);
  let head = '';
  if (start === 0) {
    const mi = metaInfo();
    const n = words(md.text);
    head = [
      mi.site && `Site: ${mi.site}`, mi.author && `By: ${mi.author}`, mi.published && `Published: ${mi.published}`,
      mi.description && `Description: ${mi.description}`,
      `About ${n.toLocaleString('en')} words${n > 200 ? ` (${Math.max(1, Math.round(n / 230))} min read)` : ''}${more ? ' in this part; the page has more' : ''}.`,
    ].filter(Boolean).join('\n') + '\n\n---\n\n';
  }
  return page({ text: head + (body || '(no readable text on this page)'), truncated: more, next_start: more ? start + body.length : null });
}

function cizOpAnalyze(env, args) {
  const { squash, isVisible, labelOf, page, mainRoot, markdown, metaInfo, words, structuredData,
      notices } = env;
  const mi = metaInfo();
  const root = mainRoot('main');
  const md = markdown(root, 400000, { skipChrome: root === document.body });
  const n = words(md.text);
  const all = Array.from(document.querySelectorAll('a[href]')).filter(a => /^https?:/i.test(a.href));
  const host = location.hostname.replace(/^www\./, '');
  const internal = all.filter(a => { try { return new URL(a.href).hostname.replace(/^www\./, '') === host; } catch { return false; } }).length;
  const imgs = Array.from(document.images).filter(isVisible);
  const media = Array.from(document.querySelectorAll('video, audio'));
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4')).filter(isVisible).slice(0, 60);
  const forms = Array.from(document.forms).filter(isVisible).slice(0, 6);
  const tables = Array.from(document.querySelectorAll('table')).filter(t => isVisible(t) && t.rows.length > 1 && !t.querySelector('table'));
  const L = [];
  L.push('## Page');
  L.push(`- Title: ${document.title || '(none)'}`);
  L.push(`- URL: ${location.href}`);
  if (mi.site || mi.type) L.push(`- ${[mi.site && `Site: ${mi.site}`, mi.type && `Type: ${mi.type}`].filter(Boolean).join(' · ')}`);
  if (mi.lang) L.push(`- Language: ${mi.lang}`);
  if (mi.description) L.push(`- Description: ${mi.description}`);
  if (mi.author || mi.published || mi.modified) L.push(`- ${[mi.author && `By ${mi.author}`, mi.published && `published ${mi.published}`, mi.modified && `updated ${mi.modified}`].filter(Boolean).join(' · ')}`);
  L.push('', '## Content');
  L.push(`- About ${n.toLocaleString('en')} words of main text (${Math.max(1, Math.round(n / 230))} min read)`);
  L.push(`- ${headings.length} headings · ${document.querySelectorAll('p').length} paragraphs · ${tables.length} data tables · ${document.querySelectorAll('pre').length} code blocks`);
  L.push(`- Links: ${all.length} (${internal} on this site, ${all.length - internal} elsewhere)`);
  L.push(`- Images: ${imgs.length} visible${imgs.length ? ` (${imgs.filter(i => !squash(i.getAttribute('alt'))).length} without alt text)` : ''} · Video: ${media.filter(m => m.tagName === 'VIDEO').length} · Audio: ${media.filter(m => m.tagName === 'AUDIO').length} · Embedded frames: ${document.querySelectorAll('iframe').length}`);
  if (headings.length) {
    L.push('', '## Outline');
    for (const h of headings) L.push(`${'  '.repeat(Number(h.tagName[1]) - 1)}- ${squash(labelOf(h)).slice(0, 140)}`);
  }
  const sd = structuredData();
  if (sd.length) { L.push('', '## Structured data'); for (const s of sd) L.push(`- ${s}`); }
  if (media.length) {
    L.push('', '## Media');
    for (const m of media.slice(0, 5)) {
      const d = Number.isFinite(m.duration) ? Math.round(m.duration) : null;
      L.push(`- ${m.tagName.toLowerCase()}: ${m.paused ? 'paused' : 'playing'}${m.muted ? ', muted' : ''}, at ${Math.round(m.currentTime)} s${d != null ? ` of ${d} s` : ''}`);
    }
  }
  if (forms.length) {
    L.push('', '## Forms');
    for (const f of forms) {
      const fields = Array.from(f.elements).filter(e => isVisible(e) && /^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && !/^(hidden|submit|button)$/i.test(e.type));
      const names = fields.slice(0, 8).map(e => labelOf(e) || e.name || e.type).map(s => s.slice(0, 40));
      L.push(`- ${labelOf(f) || f.getAttribute('name') || f.id || 'Form'}: ${fields.length} field${fields.length === 1 ? '' : 's'}${names.length ? ` (${names.join(', ')})` : ''}`);
    }
  }
  if (tables.length) {
    L.push('', '## Tables');
    for (const t of tables.slice(0, 5)) {
      const head = Array.from(t.rows[0].cells).map(c => squash(c.textContent).slice(0, 30)).slice(0, 8).join(' | ');
      L.push(`- ${t.caption ? squash(t.caption.textContent).slice(0, 80) + ': ' : ''}${t.rows.length} rows × ${t.rows[0].cells.length} columns (${head})`);
    }
  }
  const notes = notices();
  if (notes.length) { L.push('', '## Notices'); for (const s of notes) L.push(`- ${s}`); }
  const seen = new Set(), top = [];
  for (const a of root.querySelectorAll('a[href]')) {
    if (top.length >= 20) break;
    const t = squash(a.innerText || a.getAttribute('aria-label') || '');
    if (t.length < 3 || !/^https?:/i.test(a.href) || seen.has(a.href) || !isVisible(a)) continue;
    seen.add(a.href); top.push(`- [${t.slice(0, 90).replace(/[[\]]/g, '')}](${a.href})`);
  }
  if (top.length) { L.push('', '## Main links'); L.push(...top); }
  const excerpt = md.text.replace(/\s+/g, ' ').slice(0, 700);
  if (excerpt) { L.push('', '## Opening text', excerpt + (md.text.length > 700 ? '…' : '')); }
  return page({ text: L.join('\n'), truncated: false });
}

function cizOpSelection(env, args) {
  const { clamp, page, selectionText } = env;
  const text = selectionText();
  const max = clamp(args.max_chars, 100, 100000, 20000);
  return page({ text: text ? text.slice(0, max) : 'Nothing is selected on this page.', truncated: text.length > max, selected: !!text });
}

function cizOpFind(env, args) {
  const { INTERACTIVE, HEADINGS, clamp, isVisible, labelOf, roleOf, describe, page, words } = env;
  const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error('Give some words to look for.');
  const limit = clamp(args.limit, 1, 100, 15);
  const out = [];
  for (const el of document.querySelectorAll(INTERACTIVE + ', ' + HEADINGS)) {
    if (!isVisible(el)) continue;
    const hay = (labelOf(el) + ' ' + roleOf(el) + ' ' + (el.getAttribute('name') || '')).toLowerCase();
    if (!terms.every(w => hay.includes(w))) continue;
    out.push(describe(el));
    if (out.length >= limit) break;
  }
  return page({ text: out.length ? out.join('\n') : 'No matches.', truncated: false });
}

function cizOpViewport(env, args) {
  return { width: window.innerWidth, height: window.innerHeight, scroll_y: Math.round(window.scrollY) };
}

function cizOpExists(env, args) {
  if (args.selector) {
    try { return !!document.querySelector(String(args.selector)); } catch (e) { throw new Error('Not a valid CSS selector.'); }
  }
  const t = String(args.text || '').toLowerCase();
  return !!t && String((document.body && document.body.innerText) || '').toLowerCase().includes(t);
}

function cizOpCtype(env, args) {
  return String(document.contentType || '');
}
