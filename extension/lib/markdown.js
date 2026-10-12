'use strict';
// Claudefox: small Markdown renderer for replies and file previews. Builds DOM nodes (never HTML
// strings), so nothing in a reply can run as code. Links: http(s) opens a tab, zen://tab/<id> switches
// to a tab, zen://file/<id> opens a file Claude made. onLink(kind, value) handles the click.

function cizMarkdown(target, src, onLink) {
  const doc = target.ownerDocument;
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  target.textContent = '';

  function link(label, href) {
    const m = /^zen:\/\/(tab|file)\/([\w-]+)$/i.exec(href);
    const ok = m || /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
    if (!ok) return doc.createTextNode(label);
    const a = el('a', m ? 'zenlink ' + m[1].toLowerCase() : 'weblink');
    a.href = m ? '#' : href;
    a.title = m ? (m[1].toLowerCase() === 'tab' ? 'Switch to this tab' : 'Open this file') : href;
    a.textContent = label || href;
    a.addEventListener('click', e => {
      e.preventDefault();
      if (onLink) onLink(m ? m[1].toLowerCase() : 'url', m ? m[2] : href);
    });
    return a;
  }

  // Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), bare URLs.
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(\[[^\]\n]*\]\((?:[^()\s]|\([^()\s]*\))+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\])])/;
  function inline(parent, text) {
    let rest = String(text);
    while (rest) {
      const m = INLINE.exec(rest);
      if (!m) { parent.appendChild(doc.createTextNode(rest)); break; }
      if (m.index) parent.appendChild(doc.createTextNode(rest.slice(0, m.index)));
      const tok = m[0];
      if (m[1]) parent.appendChild(el('code', '', tok.slice(1, -1)));
      else if (m[2]) inline(parent.appendChild(el('strong')), tok.slice(2, -2));
      else if (m[3]) inline(parent.appendChild(el('del')), tok.slice(2, -2));
      else if (m[4]) inline(parent.appendChild(el('em')), tok.slice(1, -1));
      else if (m[5]) {
        const mm = /^\[([^\]]*)\]\((.+)\)$/.exec(tok);
        parent.appendChild(link(mm[1], mm[2]));
      } else if (m[6]) parent.appendChild(link(tok, tok));
      rest = rest.slice(m.index + tok.length);
    }
  }

  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const isBlockStart = l => /^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|\|)/.test(l) || /^\s*(---+|\*\*\*+|___+)\s*$/.test(l);
  function list(parent, indent) {
    const first = lines[i];
    const ordered = /^\s*\d+[.)]\s/.test(first);
    const ul = parent.appendChild(el(ordered ? 'ol' : 'ul'));
    if (ordered) { const n = parseInt(first, 10); if (n > 1) ul.start = n; }
    while (i < lines.length) {
      const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
      if (!m) break;
      const ind = m[1].replace(/\t/g, '    ').length;
      if (ind < indent) break;
      if (ind > indent) { list(ul.lastElementChild || ul.appendChild(el('li')), ind); continue; }
      const li = ul.appendChild(el('li'));
      let text = m[3];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
      if (task) { const box = li.appendChild(el('span', 'task' + (task[1] !== ' ' ? ' done' : ''), task[1] !== ' ' ? '☑' : '☐')); box.setAttribute('aria-hidden', 'true'); text = task[2]; }
      inline(li, text);
      i++;
      while (i < lines.length && lines[i].trim() && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i]) && !isBlockStart(lines[i])) {
        li.appendChild(doc.createTextNode(' ')); inline(li, lines[i].trim()); i++;
      }
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const box = target.appendChild(el('div', 'codeblock'));
      const head = box.appendChild(el('div', 'codehead'));
      head.appendChild(el('span', 'lang', fence[1] || 'code'));
      const copy = head.appendChild(el('button', 'codecopy', 'Copy'));
      copy.type = 'button';
      const code = body.join('\n');
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(code).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; });
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      });
      box.appendChild(el('pre')).appendChild(el('code', '', code));
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { inline(target.appendChild(el('h' + Math.min(6, h[1].length + 2), 'mdh mdh' + h[1].length)), h[2]); i++; continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { target.appendChild(el('hr')); i++; continue; }
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      cizMarkdown(target.appendChild(el('blockquote')), q.join('\n'), onLink);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { list(target, /^\s*/.exec(line)[0].length); continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const row = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const wrap = target.appendChild(el('div', 'tablewrap'));
      const table = wrap.appendChild(el('table'));
      const tr = table.appendChild(el('thead')).appendChild(el('tr'));
      for (const c of row(line)) inline(tr.appendChild(el('th')), c);
      i += 2;
      const tb = table.appendChild(el('tbody'));
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const r = tb.appendChild(el('tr'));
        for (const c of row(lines[i++])) inline(r.appendChild(el('td')), c);
      }
      continue;
    }
    const p = target.appendChild(el('p'));
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++]);
    para.forEach((l, k) => { if (k) p.appendChild(el('br')); inline(p, l); });
  }
}
