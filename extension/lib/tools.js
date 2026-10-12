'use strict';
// Claudefox: the tools Claude can use on Zen (names and schemas live in host/lib/tools.js).
// Page work runs through tabs.executeScript, which puts the code in the add-on's isolated
// content-script world: the page's own scripts cannot see or change it.
//
// Fixed rules enforced here, whatever Claude asks:
//   - Non-web pages (about:, moz-extension:) are never read or touched. file: pages only inside folders the user
//     allowed (lib/local.js), and never by army workers.
//   - Google sign-in pages are not read or touched unless Unsafe mode is on (Settings).
//   - Password, 2FA and payment fields are never filled or typed into.

const cizSleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- page side
// Injected into the tab with sensitiveField (from policy.js) passed in. Must stay self-contained.

function cizPageOp(op, args, sensitiveField) {
  const MAX_REFS = 3000;
  const st = window.__cizSt || (window.__cizSt = { seq: 0, refs: new Map() });
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, '
    + '[role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], '
    + '[role=option], [role=switch], [role=textbox], [role=combobox], [role=searchbox], '
    + '[contenteditable=""], [contenteditable="true"]';
  const HEADINGS = 'h1, h2, h3, h4, h5, h6';

  function clamp(v, lo, hi, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : dflt;
  }
  function squash(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return true;
    // display: contents and similar wrappers have no box of their own; their children do.
    return Array.from(el.children).some(c => { const b = c.getBoundingClientRect(); return b.width > 0 || b.height > 0; });
  }
  function boxOf(el) {
    let r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      const c = Array.from(el.children).find(k => { const b = k.getBoundingClientRect(); return b.width > 0 || b.height > 0; });
      if (c) r = c.getBoundingClientRect();
    }
    return r;
  }
  function centerOf(el) {
    const r = boxOf(el);
    return [Math.round((r.left || 0) + (r.width || 0) / 2), Math.round((r.top || 0) + (r.height || 0) / 2)];
  }
  const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  function hoverEvents(el, x, y) {
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y };
    el.dispatchEvent(new PointerCtor('pointerover', o));
    el.dispatchEvent(new PointerCtor('pointerenter', Object.assign({}, o, { bubbles: false })));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, o, { bubbles: false })));
    el.dispatchEvent(new PointerCtor('pointermove', o));
    el.dispatchEvent(new MouseEvent('mousemove', o));
  }
  // A real-looking click: pointer and mouse events first (many sites listen to those), then click().
  function realClick(el, x, y) {
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerCtor('pointerover', o));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new PointerCtor('pointerdown', Object.assign({ buttons: 1, pointerType: 'mouse', isPrimary: true }, o)));
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, o)));
    if (el.focus) el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerCtor('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, o)));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.click();
  }
  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return squash(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = squash(by.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(n => n.textContent).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = squash(Array.from(el.labels).map(l => l.textContent).join(' '));
      if (t) return t;
    }
    for (const a of ['placeholder', 'title', 'alt']) {
      const v = el.getAttribute(a);
      if (v && v.trim()) return squash(v);
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) return squash(el.value);
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return squash(el.getAttribute('name') || '');
    const t = squash(el.innerText || el.textContent);
    if (t) return t.slice(0, 160);
    const img = el.querySelector && el.querySelector('img[alt]');
    return img ? squash(img.getAttribute('alt')).slice(0, 160) : '';
  }
  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (/^(button|submit|reset|image)$/.test(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'file') return 'file picker';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }
  function refOf(el) {
    if (el.__cizRef && st.refs.get(el.__cizRef) === el) return el.__cizRef;
    if (st.refs.size >= MAX_REFS) st.refs.clear();
    const id = 'ref_' + (++st.seq);
    el.__cizRef = id;
    st.refs.set(id, el);
    return id;
  }
  function target() {
    if (args.ref) {
      const el = st.refs.get(String(args.ref));
      if (!el || !el.isConnected) throw new Error('That element is gone or the page changed. Call read_page or find again for fresh refs.');
      return el;
    }
    if (args.selector) {
      let el;
      try { el = document.querySelector(String(args.selector)); } catch (e) { throw new Error('Not a valid CSS selector.'); }
      if (!el) throw new Error('No element matches that selector.');
      return el;
    }
    throw new Error('Give a ref (from read_page or find) or a CSS selector.');
  }
  // An element by ref, selector, or the point x,y of the visible page.
  function targetOrPoint() {
    if (args.x != null && args.y != null && !args.ref && !args.selector) {
      const x = Number(args.x), y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers.');
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`Nothing at ${x},${y}. The page is ${window.innerWidth}x${window.innerHeight}.`);
      return { el, x: Math.round(x), y: Math.round(y) };
    }
    const el = target();
    if (!isVisible(el)) throw new Error('That element is not visible on the page. Try a screenshot and use x and y.');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const [x, y] = centerOf(el);
    // Something else on top (a player, a popup, a banner) would get the click instead: refuse.
    const rn = el.getRootNode ? el.getRootNode() : document;
    const root = typeof rn.elementFromPoint === 'function' ? rn : document;
    const hit = typeof root.elementFromPoint === 'function' ? root.elementFromPoint(x, y) : null;
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      throw new Error(`Covered: ${roleOf(hit)} "${labelOf(hit).slice(0, 60)}" is on top of it at ${x},${y}. Close or move what covers it, or click by x and y on purpose.`);
    }
    return { el, x, y };
  }
  function focusDesc() {
    const a = document.activeElement;
    return a && a !== document.body && a !== document.documentElement ? `${roleOf(a)} "${labelOf(a).slice(0, 80)}"` : 'nothing';
  }
  function fieldDesc(el) {
    return {
      type: el.getAttribute('type') || el.tagName.toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.id || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      label: labelOf(el),
      placeholder: el.getAttribute('placeholder') || '',
    };
  }
  function refuseSensitive(el) {
    const why = sensitiveField(fieldDesc(el));
    if (why) throw new Error(`Refused: this is a ${why}. Ask the user to type it themselves.`);
  }
  function isTextField(el) {
    return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i.test(el.type));
  }
  function setValue(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function describe(el) {
    const role = roleOf(el);
    const parts = [`${role} "${labelOf(el).replace(/"/g, "'").slice(0, 160)}"`];
    const why = /textbox|combobox|searchbox/.test(role) ? sensitiveField(fieldDesc(el)) : null;
    if (el.disabled) parts.push('(disabled)');
    if (role === 'link' && el.href) parts.push('-> ' + String(el.href).slice(0, 160));
    if (why) parts.push(`(${why}: Claude may not fill it)`);
    else if (/textbox|combobox|searchbox/.test(role) && el.value) parts.push(`value="${String(el.value).slice(0, 120)}"`);
    if (role === 'select' && el.selectedOptions && el.selectedOptions[0]) parts.push(`selected="${squash(el.selectedOptions[0].text).slice(0, 80)}"`);
    if (role === 'checkbox' || role === 'radio') parts.push(el.checked ? '(checked)' : '(unchecked)');
    if (el.getAttribute('aria-expanded')) parts.push(el.getAttribute('aria-expanded') === 'true' ? '(expanded)' : '(collapsed)');
    parts.push(`[${refOf(el)}]`);
    return parts.join(' ');
  }
  const page = extra => Object.assign({ title: document.title, url: location.href }, extra);

  // ---- Reading: the page as Markdown, with hidden things, scripts and page chrome left out.
  function shown(el) {
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.checkVisibility === 'function') {
      if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true;
      return getComputedStyle(el).display === 'contents';   // no box of its own, children may still show
    }
    const cs = getComputedStyle(el);
    return cs.display === 'contents' || (cs.display !== 'none' && cs.visibility !== 'hidden');
  }
  function mainRoot(scope) {
    if (scope === 'full') return document.body;
    let best = null, bestLen = 0;
    for (const c of document.querySelectorAll('article, main, [role=main], [itemprop=articleBody]')) {
      if (!shown(c)) continue;
      const n = String(c.innerText || '').length;
      if (n > bestLen) { best = c; bestLen = n; }
    }
    const bodyLen = String((document.body && document.body.innerText) || '').length;
    return best && bestLen > 400 && bestLen > bodyLen * 0.25 ? best : document.body;
  }
  function markdown(root, budget, opts) {
    const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|FRAME|OBJECT|EMBED|SELECT|OPTION|BUTTON|INPUT|TEXTAREA|DATALIST|MAP|AUDIO|VIDEO|SOURCE|TRACK|LINK|META|HEAD|DIALOG)$/;
    const CHROME = /^(NAV|FOOTER|ASIDE)$/;
    const CHROME_ROLES = /^(navigation|banner|contentinfo|complementary|search)$/;
    const BLOCK = /^(ADDRESS|ARTICLE|BLOCKQUOTE|BODY|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FORM|HEADER|LEGEND|LI|MAIN|P|SECTION|TR|CAPTION)$/;
    const skipChrome = opts.skipChrome;
    let size = 0, cut = false;
    const oneLine = s => String(s).replace(/\s+/g, ' ').trim();
    const wrap = (t, mark) => { const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t); return m[2] ? m[1] + mark + m[2] + mark + m[3] : t; };
    const grow = n => { size += n; if (size > budget) cut = true; };
    function kids(node, ctx) {
      let list = node.childNodes;
      const sr = node.openOrClosedShadowRoot || node.shadowRoot;
      if (sr) list = sr.childNodes;
      else if (node.tagName === 'SLOT') { const a = node.assignedNodes({ flatten: true }); if (a.length) list = a; }
      let s = '';
      for (const c of list) { if (cut) break; s += conv(c, ctx); }
      return s;
    }
    function list(el, ctx) {
      const ordered = el.tagName === 'OL';
      let n = Number(el.getAttribute('start')) || 1;
      const depth = ctx.depth || 0, pad = '  '.repeat(depth);
      let s = '\n\n';
      for (const li of el.children) {
        if (cut) break;
        if (li.tagName !== 'LI') { s += conv(li, ctx); continue; }
        if (!ctx.open && !shown(li)) continue;
        const body = kids(li, Object.assign({}, ctx, { depth: depth + 1 })).replace(/\n\s*\n/g, '\n').trim();
        if (!body) continue;
        const box = li.querySelector(':scope > input[type=checkbox]');
        const lines = body.split('\n').map((l, i) => i === 0 || /^\s*([-*]|\d+\.) /.test(l) ? l : pad + '  ' + l.trim());
        s += pad + (ordered ? `${n++}. ` : '- ') + (box ? (box.checked ? '[x] ' : '[ ] ') : '') + lines.join('\n') + '\n';
      }
      return s + '\n';
    }
    function table(el, ctx) {
      const rows = Array.from(el.rows || []);
      if (!rows.length) return '\n\n' + kids(el, ctx) + '\n\n';
      const nested = el.querySelector('table');
      const cells = rows.slice(0, 80).map(r => Array.from(r.cells).slice(0, 12).map(c => kids(c, ctx)));
      // A table used for layout: keep its content as blocks.
      if (nested || cells.some(r => r.some(c => c.length > 400))) return '\n\n' + cells.map(r => r.join('\n\n')).join('\n\n') + '\n\n';
      const flat = cells.map(r => r.map(c => oneLine(c).replace(/\|/g, '\\|')));
      const width = Math.max(...flat.map(r => r.length));
      if (width <= 1) return '\n\n' + flat.map(r => r[0] || '').join('\n') + '\n\n';
      const line = r => '| ' + Array.from({ length: width }, (_, i) => r[i] || '').join(' | ') + ' |';
      let s = '\n\n' + (el.caption ? `**${oneLine(el.caption.textContent)}**\n\n` : '') + line(flat[0]) + '\n|' + ' --- |'.repeat(width) + '\n' + flat.slice(1).map(line).join('\n');
      if (rows.length > 80) s += `\n\n(${rows.length - 80} more rows)`;
      return s + '\n\n';
    }
    function conv(node, ctx) {
      if (cut) return '';
      if (node.nodeType === 3) {
        const t = node.nodeValue.replace(/\s+/g, ' ');
        grow(t.length);
        return t;
      }
      if (node.nodeType !== 1) return node.nodeType === 11 ? kids(node, ctx) : '';
      const el = node, tag = el.tagName;
      if (SKIP.test(tag)) return '';
      if (!ctx.open && !shown(el)) return '';
      if (skipChrome && (CHROME.test(tag) || CHROME_ROLES.test(el.getAttribute('role') || '')
        || (tag === 'HEADER' && !el.closest('article, main, [role=main]')))) return '';
      switch (tag) {
        case 'BR': return '\n';
        case 'HR': return '\n\n---\n\n';
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
          const t = oneLine(kids(el, ctx));
          return t ? `\n\n${'#'.repeat(Number(tag[1]))} ${t}\n\n` : '';
        }
        case 'PRE': {
          const t = String(el.textContent || '').replace(/\s+$/, '');
          grow(t.length);
          const cls = el.className + ' ' + ((el.querySelector('code') || {}).className || '');
          const lang = (/(?:lang(?:uage)?-)([\w+#-]+)/.exec(cls) || [])[1] || '';
          return t ? `\n\n\`\`\`${lang}\n${t}\n\`\`\`\n\n` : '';
        }
        case 'CODE': case 'KBD': case 'SAMP': {
          const t = oneLine(el.textContent);
          grow(t.length);
          return t ? '`' + t.replace(/`/g, "'") + '`' : '';
        }
        case 'STRONG': case 'B': return wrap(kids(el, ctx), '**');
        case 'EM': case 'I': return wrap(kids(el, ctx), '*');
        case 'DEL': case 'S': case 'STRIKE': return wrap(kids(el, ctx), '~~');
        case 'A': {
          const t = kids(el, Object.assign({}, ctx, { link: true }));
          const href = String(el.href || '');
          if (ctx.link || !/^https?:/i.test(href)) return t;
          const label = oneLine(t);
          return label ? `[${label.replace(/[[\]]/g, '')}](${href.replace(/[()\s]/g, encodeURIComponent)})` : '';
        }
        case 'IMG': {
          const alt = oneLine(el.getAttribute('alt') || '');
          return alt ? `[image: ${alt.slice(0, 200)}]` : '';
        }
        case 'UL': case 'OL': return list(el, ctx);
        case 'TABLE': return table(el, ctx);
        case 'BLOCKQUOTE': {
          const t = kids(el, ctx).trim();
          return t ? '\n\n' + t.split('\n').map(l => '> ' + l).join('\n') + '\n\n' : '';
        }
        case 'DETAILS': return '\n\n' + kids(el, Object.assign({}, ctx, { open: true })) + '\n\n';
        case 'SUMMARY': { const t = oneLine(kids(el, ctx)); return t ? `\n\n**${t}**\n\n` : ''; }
        case 'DT': { const t = oneLine(kids(el, ctx)); return t ? `\n\n**${t}**\n` : ''; }
        case 'DD': return '\n' + kids(el, ctx) + '\n';
        case 'TD': case 'TH': return ' ' + kids(el, ctx) + ' ';
      }
      const inner = kids(el, ctx);
      if (!inner) return '';
      if (BLOCK.test(tag)) return `\n\n${inner}\n\n`;
      if (tag.includes('-') || tag === 'SPAN' || tag === 'LABEL') {
        // Custom elements and spans: a block when the page lays them out as one.
        const d = getComputedStyle(el).display;
        if (/^(block|flex|grid|list-item|table|flow-root)$/.test(d)) return `\n\n${inner}\n\n`;
      }
      return inner;
    }
    let md = conv(root, { depth: 0 });
    // Tidy: trim lines outside code blocks, collapse blank runs.
    const out = [];
    let fence = false, blank = 0;
    for (let line of md.split('\n')) {
      if (/^\s*```/.test(line)) fence = !fence;
      if (!fence && !/^\s*```/.test(line)) {
        const lead = /^(\s*)([-*]|\d+\.) /.test(line) ? /^\s*/.exec(line)[0] : '';
        line = lead + line.trim().replace(/[ \t]{2,}/g, ' ');
      }
      if (!line.trim()) { if (++blank > 1) continue; } else blank = 0;
      out.push(line);
    }
    return { text: out.join('\n').trim(), cut };
  }
  function metaInfo() {
    const m = n => {
      const e = document.querySelector(`meta[name="${n}" i], meta[property="${n}" i], meta[itemprop="${n}" i]`);
      return e ? squash(e.getAttribute('content')).slice(0, 400) : '';
    };
    const time = document.querySelector('article time[datetime], main time[datetime], time[datetime]');
    const author = m('author') || m('article:author') || squash((document.querySelector('[rel=author], [itemprop=author] [itemprop=name], .author, .byline') || {}).textContent || '').slice(0, 120);
    return {
      description: m('description') || m('og:description') || m('twitter:description'),
      site: m('og:site_name') || m('application-name'),
      type: m('og:type'),
      author: /^https?:/.test(author) ? '' : author,
      published: m('article:published_time') || m('datePublished') || m('uploadDate') || (time ? time.getAttribute('datetime') : ''),
      modified: m('article:modified_time') || m('og:updated_time') || m('dateModified'),
      lang: document.documentElement.lang || '',
      canonical: ((document.querySelector('link[rel=canonical]') || {}).href) || '',
    };
  }
  const words = s => (String(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  function structuredData() {
    const items = [];
    const take = o => {
      if (!o || typeof o !== 'object' || items.length >= 8) return;
      if (Array.isArray(o)) return o.forEach(take);
      if (Array.isArray(o['@graph'])) return o['@graph'].forEach(take);
      const type = [].concat(o['@type'] || []).join(', ');
      if (!type || /^(WebSite|WebPage|BreadcrumbList|SearchAction|ImageObject|SiteNavigationElement|Organization|WPHeader|WPFooter)$/i.test(type)) return;
      const off = [].concat(o.offers || [])[0] || {};
      const rate = o.aggregateRating || {};
      const who = [].concat(o.author || [])[0];
      const bits = [
        o.name || o.headline, who && (who.name || who),
        off.price != null ? `price ${off.price}${off.priceCurrency ? ' ' + off.priceCurrency : ''}` : '',
        off.availability ? String(off.availability).replace(/^https?:\/\/schema\.org\//, '') : '',
        rate.ratingValue ? `rating ${rate.ratingValue}${rate.reviewCount || rate.ratingCount ? ` (${rate.reviewCount || rate.ratingCount} reviews)` : ''}` : '',
        o.datePublished || o.uploadDate ? `published ${o.datePublished || o.uploadDate}` : '',
        o.duration ? `duration ${o.duration}` : '',
        o.recipeYield ? `yield ${o.recipeYield}` : '', o.totalTime ? `total time ${o.totalTime}` : '',
        o.startDate ? `starts ${o.startDate}` : '', o.location && o.location.name ? `at ${o.location.name}` : '',
      ].filter(Boolean).map(b => squash(typeof b === 'string' ? b : JSON.stringify(b)).slice(0, 160));
      items.push(`${type}: ${bits.join(' · ') || '(no details)'}`);
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { take(JSON.parse(s.textContent)); } catch {}
    }
    // Microdata (YouTube, many shops): the first item on the page.
    const scope = document.querySelector('[itemscope][itemtype]');
    if (scope && items.length < 8) {
      const get = p => { const e = scope.querySelector(`[itemprop="${p}"]`); return e ? squash(e.getAttribute('content') || e.getAttribute('datetime') || e.textContent).slice(0, 160) : ''; };
      const type = String(scope.getAttribute('itemtype')).replace(/^https?:\/\/schema\.org\//, '');
      const bits = [get('name'), get('duration') && `duration ${get('duration')}`, (get('uploadDate') || get('datePublished')) && `published ${get('uploadDate') || get('datePublished')}`,
        get('interactionCount') && `${get('interactionCount')} views`, get('genre'), get('price') && `price ${get('price')} ${get('priceCurrency')}`,
        get('ratingValue') && `rating ${get('ratingValue')}`].filter(Boolean);
      if (bits.length) items.push(`${type}: ${bits.join(' · ')}`);
    }
    return items;
  }
  function notices() {
    const out = [];
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare"], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form')) out.push('A CAPTCHA or bot check is on the page: the user has to solve it.');
    if (Array.from(document.querySelectorAll('input[type=password]')).some(isVisible)) out.push('A password field is visible (a sign-in form): Claude never types passwords.');
    const fixed = Array.from(document.querySelectorAll('div, section, aside, dialog')).filter(e => {
      if (!/cookie|consent|gdpr|privacy|tracking/i.test((e.id || '') + ' ' + (typeof e.className === 'string' ? e.className : ''))) return false;
      const cs = getComputedStyle(e);
      return (cs.position === 'fixed' || cs.position === 'sticky') && isVisible(e);
    });
    if (fixed.length) out.push('A cookie or consent banner is showing.');
    const modal = Array.from(document.querySelectorAll('dialog[open], [role=dialog], [aria-modal=true]')).find(isVisible);
    if (modal) out.push(`A dialog is open: "${squash(labelOf(modal) || modal.innerText).slice(0, 120)}".`);
    if (Array.from(document.querySelectorAll('[class*=paywall], [id*=paywall], [class*=regwall]')).some(isVisible)) out.push('A paywall or sign-up wall seems to cover part of the page.');
    return out;
  }
  function selectionText() {
    let text = String(window.getSelection ? window.getSelection().toString() : '');
    const ae = document.activeElement;
    if (!text.trim() && ae && isTextField(ae) && !sensitiveField(fieldDesc(ae))) {
      try { text = ae.value.slice(ae.selectionStart, ae.selectionEnd); } catch {}
    }
    return text.trim();
  }

  switch (op) {
    case 'read': {
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
    case 'text': {
      const max = clamp(args.max_chars, 1000, 200000, 40000);
      const start = clamp(args.start_at, 0, 50000000, 0);
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
    case 'analyze': {
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
    case 'selection': {
      const text = selectionText();
      const max = clamp(args.max_chars, 100, 100000, 20000);
      return page({ text: text ? text.slice(0, max) : 'Nothing is selected on this page.', truncated: text.length > max, selected: !!text });
    }
    case 'find': {
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
    case 'click': {
      const t = targetOrPoint();
      if (t.el.disabled) throw new Error('That element is disabled.');
      realClick(t.el, t.x, t.y);
      const after = t.el.isConnected ? squash(t.el.innerText || t.el.value || labelOf(t.el)).slice(0, 120) : '(gone from the page)';
      return { clicked: `${roleOf(t.el)} "${labelOf(t.el).slice(0, 120)}"`, at: [t.x, t.y], now_shows: after, focused: focusDesc() };
    }
    case 'hover': {
      const t = targetOrPoint();
      hoverEvents(t.el, t.x, t.y);
      return { hovered: `${roleOf(t.el)} "${labelOf(t.el).slice(0, 120)}"`, at: [t.x, t.y] };
    }
    case 'type': {
      const el = (args.ref || args.selector) ? target() : document.activeElement;
      if (!el || el === document.body || el === document.documentElement) throw new Error('No field has focus. Give the ref of the field to type into (or click it first).');
      if (!isTextField(el) && !el.isContentEditable) throw new Error('That element does not take text.');
      refuseSensitive(el);
      if (el.disabled || el.readOnly) throw new Error('That field is disabled or read-only.');
      const text = String(args.text == null ? '' : args.text);
      if (text.length > 5000) throw new Error('Type at most 5000 characters at once (use fill for long text).');
      if (el.focus) el.focus();
      if (document.activeElement !== el && !el.contains(document.activeElement)) throw new Error('Could not focus that field. Click it first, then type.');
      if (args.clear) {
        if (el.isContentEditable) { document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
        else setValue(el, '');
      }
      for (const ch of text) {
        const o = { key: ch === '\n' ? 'Enter' : ch, bubbles: true, cancelable: true };
        const go = el.dispatchEvent(new KeyboardEvent('keydown', o));
        el.dispatchEvent(new KeyboardEvent('keypress', o));
        if (go) {
          if (el.isContentEditable) document.execCommand(ch === '\n' ? 'insertParagraph' : 'insertText', false, ch);
          else if (ch !== '\n' || el.tagName === 'TEXTAREA') {
            const s = el.selectionStart, e = el.selectionEnd, v = el.value;
            if (typeof s === 'number' && typeof e === 'number') {
              setValue(el, v.slice(0, s) + ch + v.slice(e));
              try { el.setSelectionRange(s + 1, s + 1); } catch {}
            } else setValue(el, v + ch);
          }
        }
        el.dispatchEvent(new KeyboardEvent('keyup', o));
      }
      if (!el.isContentEditable) el.dispatchEvent(new Event('change', { bubbles: true }));
      if (args.submit) {
        const o = { key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const go = el.dispatchEvent(new KeyboardEvent('keydown', o));
        if (go && el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
        el.dispatchEvent(new KeyboardEvent('keyup', o));
      }
      const now = el.isContentEditable ? squash(el.innerText) : String(el.value || '');
      return { typed: `${[...text].length} characters`, submitted: !!args.submit, field_now: now.slice(0, 200) };
    }
    case 'media': {
      const all = Array.from(document.querySelectorAll('video, audio'));
      let m = args.ref || args.selector ? target() : null;
      if (m && !/^(VIDEO|AUDIO)$/.test(m.tagName)) m = m.querySelector('video, audio');
      if (!m) {
        // The biggest visible player is almost always the one the user means.
        m = all.filter(isVisible).sort((a, b) => { const A = boxOf(a), B = boxOf(b); return B.width * B.height - A.width * A.height; })[0] || all[0];
      }
      if (!m) throw new Error('No video or audio on this page.');
      const act = String(args.action || 'status');
      if (act === 'play' || (act === 'toggle' && m.paused)) { const p = m.play(); if (p && p.catch) p.catch(() => {}); }
      else if (act === 'pause' || act === 'toggle') m.pause();
      else if (act === 'mute') m.muted = true;
      else if (act === 'unmute') m.muted = false;
      else if (act === 'seek') { const s = Number(args.seconds); if (!Number.isFinite(s)) throw new Error('Give seconds to seek to.'); m.currentTime = Math.max(0, s); }
      else if (act === 'speed') { const r = Number(args.rate); if (!Number.isFinite(r) || r < 0.25 || r > 4) throw new Error('Give a rate between 0.25 and 4.'); m.playbackRate = r; }
      else if (act === 'volume') { const v = Number(args.volume); if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('Give a volume between 0 and 1.'); m.volume = v; m.muted = v === 0; }
      else if (act !== 'status') throw new Error('action must be play, pause, toggle, mute, unmute, seek, speed, volume or status.');
      return {
        action: act, paused: act === 'play' ? false : m.paused, muted: m.muted, time: Math.round(m.currentTime),
        duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null, rate: m.playbackRate, volume: Math.round(m.volume * 100) / 100, players: all.length,
      };
    }
    case 'viewport':
      return { width: window.innerWidth, height: window.innerHeight, scroll_y: Math.round(window.scrollY) };
    case 'fill': {
      const el = target();
      refuseSensitive(el);
      if (el.disabled || el.readOnly) throw new Error('That field is disabled or read-only.');
      const value = String(args.value == null ? '' : args.value);
      el.scrollIntoView({ block: 'center' });
      if (el.focus) el.focus({ preventScroll: true });
      if (el.tagName === 'SELECT') {
        const opt = Array.from(el.options).find(o => o.value === value || squash(o.text) === squash(value))
          || Array.from(el.options).find(o => squash(o.text).toLowerCase() === squash(value).toLowerCase());
        if (!opt) throw new Error(`No option "${value.slice(0, 80)}". Options: ${Array.from(el.options).map(o => squash(o.text)).slice(0, 30).join(' | ')}`);
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: squash(opt.text) };
      }
      if (el.isContentEditable) {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, value);
        return { filled: `${value.length} characters`, field_now: squash(el.innerText).slice(0, 200) };
      }
      if (el.tagName === 'INPUT' && /^(checkbox|radio|file|button|submit|reset|image|range|color|hidden)$/i.test(el.type)) {
        throw new Error(`A ${el.type} input takes no text. Use click instead.`);
      }
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') throw new Error('That element does not take text.');
      setValue(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: `${value.length} characters`, field_now: String(el.value).slice(0, 200) };
    }
    case 'press': {
      const key = String(args.key || '');
      const KEYS = {
        Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40,
        ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
      };
      if (!(key in KEYS) && key.length !== 1) throw new Error(`Unknown key "${key.slice(0, 20)}".`);
      const el = (args.ref || args.selector) ? target() : (document.activeElement || document.body);
      const bare = el === document.body || el === document.documentElement;
      if (bare && (key.length === 1 || /^(Enter|Backspace|Delete|Space)$/.test(key))) {
        throw new Error('No element has focus, so the key would go nowhere useful. Give the ref of the field or button.');
      }
      if (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable) refuseSensitive(el);
      const k = key === 'Space' ? ' ' : key;
      const code = KEYS[key] || k.toUpperCase().charCodeAt(0);
      const opts = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
      if ((args.ref || args.selector) && el.focus) el.focus();
      const go = el.dispatchEvent(new KeyboardEvent('keydown', opts));
      // Synthetic key events do not trigger the browser's own default action, so do the common ones.
      const textual = isTextField(el);
      if (go) {
        if (key === 'Enter' && el.tagName === 'INPUT' && el.form) {
          if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
        } else if (key === 'Enter' && el.tagName === 'TEXTAREA') {
          setValue(el, el.value + '\n');
        } else if (textual && k.length === 1) {
          setValue(el, el.value + k);
        } else if (textual && key === 'Backspace') {
          setValue(el, el.value.slice(0, -1));
        } else if (el.isContentEditable && k.length === 1) {
          document.execCommand('insertText', false, k);
        } else if (key === 'Tab') {
          const all = Array.from(document.querySelectorAll(INTERACTIVE + ', [tabindex]:not([tabindex="-1"])')).filter(isVisible);
          const next = all[all.indexOf(el) + 1];
          if (next && next.focus) next.focus();
        } else if (key === 'Space' && /^(BUTTON|SUMMARY)$/.test(el.tagName)) {
          el.click();
        } else if (/^(PageDown|PageUp|Home|End|ArrowDown|ArrowUp)$/.test(key) && !textual && !el.isContentEditable) {
          const doc = document.scrollingElement || document.documentElement;
          const step = { PageDown: innerHeight * 0.9, PageUp: -innerHeight * 0.9, ArrowDown: 60, ArrowUp: -60 }[key];
          if (key === 'Home') window.scrollTo(0, 0); else if (key === 'End') window.scrollTo(0, doc.scrollHeight); else window.scrollBy(0, step);
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { pressed: key, focused: focusDesc() };
    }
    case 'scroll': {
      if (args.ref || args.selector) {
        const el = target();
        el.scrollIntoView({ block: 'center' });
        return { scrolled_to: `${roleOf(el)} "${labelOf(el).slice(0, 80)}"` };
      }
      const dir = args.direction || 'down';
      const amount = clamp(args.amount, 20, 50000, Math.round(window.innerHeight * 0.8));
      const doc = document.scrollingElement || document.documentElement;
      if (dir === 'top') window.scrollTo(0, 0);
      else if (dir === 'bottom') window.scrollTo(0, doc.scrollHeight);
      else window.scrollBy(0, dir === 'up' ? -amount : amount);
      return { y: Math.round(window.scrollY), max_y: Math.max(0, Math.round(doc.scrollHeight - window.innerHeight)) };
    }
    case 'scrollto':
      window.scrollTo(0, clamp(args.y, 0, 1e9, 0));
      return { y: Math.round(window.scrollY) };
    case 'exists': {
      if (args.selector) {
        try { return !!document.querySelector(String(args.selector)); } catch (e) { throw new Error('Not a valid CSS selector.'); }
      }
      const t = String(args.text || '').toLowerCase();
      return !!t && String((document.body && document.body.innerText) || '').toLowerCase().includes(t);
    }
    case 'ctype':
      return String(document.contentType || '');
  }
  throw new Error('Unknown page operation: ' + op);
}

// ---------------------------------------------------------------- add-on side

async function cizTabFor(args) {
  if (args && args.tab_id != null) {
    try { return await browser.tabs.get(Number(args.tab_id)); } catch { throw new Error(`No tab with id ${args.tab_id}. Call tabs_list.`); }
  }
  const [t] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('No active tab. Pass a tab_id from tabs_list.');
  return t;
}

// Army workers (lib/army.js) stay on web pages, and Google sign-in is hands-off for them even in Unsafe mode.
function cizArmyRefuse(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Army workers only work on web pages.');
  if (cizUrlBlocked(url, { unsafe: false }).blocked) throw new Error('Army workers can\'t use Google sign-in pages, even in Unsafe mode.');
}

function cizGateOpts() {
  const s = cizState.get();
  return { unsafe: !!s.unsafe, localGrants: s.localGrants || [] };
}

// A file: tab (never an army call, those are refused before): Zen must let the add-on in, and the user must allow
// the folder. Outside the grants this asks the user and waits for the answer.
async function cizLocalGate(gate) {
  if ((await cizLocal.fileAccess()) === 'no') throw new Error(CIZ_FILE_ACCESS_OFF);
  if (gate.local) return;
  const r = await cizLocal.ask(gate.needGrant);
  if (!r.ok) throw new Error(r.error);
}

// The tab a tool will use, and the gate it passed (view: the looser screenshot rule). A file: tab outside the allowed
// folders waits for the user's answer in the confirm window, up to two minutes, and the page or the user may move the
// tab meanwhile. So after an answer the tab is read again and checked from the start: the tool only ever acts on what
// was allowed, never on whatever the tab shows by then.
async function cizGatedTab(args, view) {
  for (let round = 0; ; round++) {
    const tab = await cizTabFor(args);
    if (args && args.__army) { cizArmyRefuse(tab.url); return { tab, gate: { blocked: false } }; }
    const gate = (view ? cizViewBlocked : cizUrlBlocked)(tab.url || '', cizGateOpts());
    if (!gate.local && !gate.needGrant) return { tab, gate };
    await cizLocalGate(gate);
    if (!gate.needGrant) return { tab, gate };
    if (round >= 2) throw new Error(`Tab ${tab.id} kept moving to other folders while the user was asked, so Claude did not use it.`);
  }
}

// A tab Claude may read or act on: not a non-web page, and not a Google sign-in page unless Unsafe mode is on.
async function cizPageTab(args) {
  const { tab, gate } = await cizGatedTab(args, false);
  if (gate.blocked) {
    if (/^about:/i.test(tab.url || '') && !cizViewBlocked(tab.url).blocked) {
      throw new Error(`Tab ${tab.id} is a browser page (${String(tab.url).split(/[?#]/)[0]}): add-ons can't read or click inside those, but screenshot shows it.`);
    }
    throw new Error(`Cannot use tab ${tab.id}: ${gate.reason}.`);
  }
  return tab;
}

async function cizInPage(tab, op, args) {
  const { __army, ...pageArgs } = args || {};   // which worker is calling is the add-on's business, not the page's
  const code = '(function () { var sensitiveField = ' + cizSensitiveField.toString() + ';\n'
    + 'return (' + cizPageOp.toString() + ')(' + JSON.stringify(op) + ', ' + JSON.stringify(pageArgs) + ', sensitiveField);\n})();';
  let res;
  try {
    res = await browser.tabs.executeScript(tab.id, { code, runAt: 'document_idle' });
  } catch (e) {
    const why = String((e && e.message) || e).replace(/^Error:\s*/, '');
    // Zen's "Access local files" switch is off (or was turned off since the last check).
    if (/^file:/i.test(tab.url || '') && /permission|not allowed|denied|cannot access/i.test(why)) throw new Error(CIZ_FILE_ACCESS_OFF);
    throw new Error(why);
  }
  return res && res[0];
}

async function cizWaitLoaded(tabId, ms) {
  const t0 = Date.now();
  await cizSleep(250);
  for (;;) {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete' || Date.now() - t0 > ms) {
      return { tab_id: tabId, url: t.url || '', title: t.title || '', loaded: t.status === 'complete' };
    }
    await cizSleep(200);
  }
}

// After a click or Enter: did the page navigate (or start to), and did a new tab open? Tells Claude what
// happened without an extra screenshot.
async function cizAfterAction(tab, run) {
  const opened = [];
  const onCreated = t => { if (t.openerTabId === tab.id) opened.push(t); };
  const ev = browser.tabs.onCreated;
  if (ev) ev.addListener(onCreated);
  try {
    const out = await run();
    const before = tab.url || '';
    let t = null;
    for (let i = 0; i < 5; i++) {
      await cizSleep(100);
      try { t = await browser.tabs.get(tab.id); } catch { return Object.assign(out, { tab_closed: true }); }
      if (t.status === 'loading' || (t.url && t.url !== before)) break;
    }
    if (t && t.status === 'loading') {
      const done = await cizWaitLoaded(tab.id, 15000);
      Object.assign(out, { navigated: true, url: done.url, title: done.title, loaded: done.loaded });
    } else if (t && t.url && t.url !== before) {
      Object.assign(out, { navigated: true, url: t.url, title: t.title || '' });
    } else Object.assign(out, { navigated: false });
    if (opened.length) out.opened_tab = { tab_id: opened[0].id, url: opened[0].url || opened[0].pendingUrl || '' };
    return out;
  } finally {
    if (ev) ev.removeListener(onCreated);
  }
}

function cizRefuseUrl(url, army) {
  if (army) {
    try { cizArmyRefuse(url); } catch (e) { throw new Error(`Refused: ${e.message}`); }
    return;
  }
  // Firefox refuses to open file: URLs from add-ons; local pages open through the helper's local_page_open.
  if (/^file:/i.test(url)) throw new Error('Refused: file: pages are off-limits to tab_open and navigate. To open a file from this computer, use local_page_open.');
  const gate = cizUrlBlocked(url, { unsafe: !!cizState.get().unsafe });
  if (gate.blocked) throw new Error(`Refused: ${gate.reason}.`);
}

function cizBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Zen shows PDFs in its own viewer, which add-ons cannot read. Fetch the file instead: the helper saves it
// and Claude reads it with its Read tool.
async function cizPdfOf(tab) {
  const url = tab.url || '';
  let pdf = /\.pdf(?:$|[?#])/i.test(url);
  if (!pdf) { try { pdf = (await cizInPage(tab, 'ctype', {})) === 'application/pdf'; } catch { pdf = false; } }
  if (!pdf) return null;
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`This tab shows a PDF, but downloading it failed (HTTP ${r.status}).`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error('This tab shows a PDF larger than 30 MB, too big to read.');
  return { pdf_base64: cizBase64(buf), title: tab.title || '', url, bytes: buf.byteLength };
}

// Google Docs, Slides and Sheets draw their text on a canvas, so the page itself has little to read. Their export
// links give the whole text with the user's own session (docs.google.com is not a sign-in page).
async function cizGoogleExport(tab, args) {
  const m = /^https:\/\/docs\.google\.com\/(document|presentation|spreadsheets)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(tab.url || '');
  if (!m) return null;
  const [, kind, id] = m;
  const base = `https://docs.google.com/${kind}/d/${id}`;
  let gid = '';
  try { const u = new URL(tab.url); gid = (/gid=(\d+)/.exec(u.hash) || [])[1] || u.searchParams.get('gid') || ''; } catch {}
  const tries = kind === 'document' ? [`${base}/export?format=md`, `${base}/export?format=txt`]
    : kind === 'presentation' ? [`${base}/export/txt`, `${base}/export?format=txt`]
      : [`${base}/export?format=csv${gid ? `&gid=${gid}` : ''}`];
  for (const url of tries) {
    let text;
    try {
      const r = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
      if (!r.ok || /text\/html/i.test(r.headers.get('content-type') || '')) continue;   // a sign-in page or an error page
      text = await r.text();
    } catch { continue; }
    const title = String(tab.title || '').replace(/\s+-\s+Google (Docs|Slides|Sheets|Documentos|Apresentações|Planilhas)$/i, '');
    const max = Math.min(Math.max(Math.round(Number(args.max_chars) || 40000), 1000), 200000);
    const start = Math.max(0, Math.round(Number(args.start_at) || 0));
    const part = text.slice(start, start + max);
    const more = start + max < text.length;
    const what = kind === 'document' ? 'Google Doc' : kind === 'presentation' ? 'Google Slides deck' : 'Google Sheet (this sheet, as CSV)';
    return { title, url: tab.url, text: `${start ? '' : `${what}, read through its export. ${text.length.toLocaleString('en')} characters.\n\n`}${part}`,
      truncated: more, next_start: more ? start + max : null, total_chars: text.length };
  }
  return null;
}

const CIZ_TOOLS = {
  async ping() { return { pong: true, version: browser.runtime.getManifest().version }; },

  async tabs_list() {
    const tabs = await browser.tabs.query({});
    return tabs.map(t => {
      const army = cizArmy.owner(t.id);   // a tab an army worker is using, so Claude leaves it to that worker
      return Object.assign({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, audible: !!t.audible }, army ? { army: army.worker } : {});
    });
  },

  async tab_open(args) {
    const url = String(args.url || '').trim();
    cizRefuseUrl(url, args.__army);
    const since = Date.now();
    const tab = await browser.tabs.create({ url, active: args.active !== false });
    // Registered before the page loads, so Stop or the worker's end closes it even mid-load (or at once, when that
    // came while the tab was being made).
    if (args.__army && !cizArmy.register(tab.id, args.__army, since)) throw new Error('This worker was stopped, so its new tab was closed.');
    if (args.wait === false) return { tab_id: tab.id, url };
    const done = await cizWaitLoaded(tab.id, 30000);
    return { tab_id: tab.id, url: done.url || url, title: done.title, loaded: done.loaded };
  },

  async tab_activate(args) {
    if (args.tab_id == null) throw new Error('Give the tab_id to switch to.');
    const tab = await cizTabFor(args);
    await browser.tabs.update(tab.id, { active: true });
    try { await browser.windows.update(tab.windowId, { focused: true }); } catch {}
    return { tab_id: tab.id, title: tab.title || '' };
  },

  async tab_close(args) {
    if (args.tab_id == null) throw new Error('Give the tab_id to close.');
    const tab = await cizTabFor(args);
    await browser.tabs.remove(tab.id);
    return { closed: tab.id, title: tab.title || '' };
  },

  async navigate(args) {
    const want = String(args.url || '').trim();
    if (!want) throw new Error('Give a URL, or "back", "forward" or "reload".');
    const tab = await cizPageTab(args);
    const word = want.toLowerCase();
    if (word === 'back') await browser.tabs.goBack(tab.id);
    else if (word === 'forward') await browser.tabs.goForward(tab.id);
    else if (word === 'reload') await browser.tabs.reload(tab.id);
    else { cizRefuseUrl(want, args.__army); await browser.tabs.update(tab.id, { url: want }); }
    return cizWaitLoaded(tab.id, 30000);
  },

  async read_page(args) { return cizInPage(await cizPageTab(args), 'read', args); },

  async get_page_text(args) {
    const tab = await cizPageTab(args);
    const google = await cizGoogleExport(tab, args);
    if (google) return google;
    const pdf = await cizPdfOf(tab);
    if (pdf) return pdf;
    const n = Number(args.scroll_to_load);
    const rounds = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 10) : 0;
    let back = null;
    if (rounds) {
      // Pull in content that loads as you scroll (comments, feeds), then put the page back where it was.
      try { back = (await cizInPage(tab, 'viewport', {})).scroll_y; } catch {}
      for (let i = 0; i < rounds; i++) { await cizInPage(tab, 'scroll', { direction: 'bottom' }); await cizSleep(900); }
    }
    try { return await cizInPage(tab, 'text', args); }
    finally { if (back != null) { try { await cizInPage(tab, 'scrollto', { y: back }); } catch {} } }
  },

  async analyze_page(args) { return cizInPage(await cizPageTab(args), 'analyze', args); },
  async get_selection(args) { return cizInPage(await cizPageTab(args), 'selection', args); },
  async find(args) { return cizInPage(await cizPageTab(args), 'find', args); },

  async click(args) {
    const tab = await cizPageTab(args);
    return cizAfterAction(tab, () => cizInPage(tab, 'click', args));
  },
  async hover(args) { return cizInPage(await cizPageTab(args), 'hover', args); },
  async fill(args) { return cizInPage(await cizPageTab(args), 'fill', args); },
  async type_text(args) {
    const tab = await cizPageTab(args);
    return args.submit ? cizAfterAction(tab, () => cizInPage(tab, 'type', args)) : cizInPage(tab, 'type', args);
  },
  async press_key(args) {
    const tab = await cizPageTab(args);
    return String(args.key) === 'Enter' ? cizAfterAction(tab, () => cizInPage(tab, 'press', args)) : cizInPage(tab, 'press', args);
  },
  async scroll(args) { return cizInPage(await cizPageTab(args), 'scroll', args); },
  async media(args) { return cizInPage(await cizPageTab(args), 'media', args); },

  async wait_for(args, signal) {
    if (!args.text && !args.selector) throw new Error('Give text or a CSS selector to wait for.');
    const n = Number(args.timeout_ms);
    const timeout = Number.isFinite(n) ? Math.min(Math.max(n, 500), 60000) : 10000;
    const probe = { text: args.text || '', selector: args.selector || '' };
    const t0 = Date.now();
    for (;;) {
      if (signal && signal.aborted) throw new Error('Stopped');
      // Re-check the tab each round: it may have navigated somewhere off-limits.
      let found = false;
      try { found = await cizInPage(await cizPageTab(args), 'exists', probe); }
      catch (e) { if (/Cannot use tab|No tab|selector|Army workers|did not allow|No answer about|Zen keeps add-ons out/.test(e.message)) throw e; }
      if (found) return { found: true, waited_ms: Date.now() - t0 };
      if (Date.now() - t0 >= timeout) return { found: false, waited_ms: Date.now() - t0 };
      await cizSleep(250);
    }
  },

  async screenshot(args) {
    // Looking is allowed on more pages than acting: about: pages too (see cizViewBlocked).
    const { tab, gate } = await cizGatedTab(args, true);
    if (gate.blocked) throw new Error(`Cannot use tab ${tab.id}: ${gate.reason}.`);
    // captureTab only: bringing the tab to the front to capture it would take the user's tab away from them.
    // scale 1: one image pixel per CSS pixel, so click x/y can be read straight off the picture.
    let dataUrl, why = 'Zen returned no image';
    try {
      dataUrl = await browser.tabs.captureTab(tab.id, { format: 'png', scale: 1 });
    } catch (e) { why = String((e && e.message) || e).replace(/^Error:\s*/, '').replace(/\.$/, '') || why; }
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
    if (!m) {
      if (gate.about) throw new Error('Zen did not let the add-on capture this browser page.');
      if (args.__army) throw new Error(`Could not capture tab ${tab.id}: ${why}. Read the page with get_page_text or find instead.`);
      throw new Error(`Could not capture tab ${tab.id}: ${why}. Zen draws a tab only while it is in front. If you need this picture, ask the user, or bring the tab to the front with tab_activate first.`);
    }
    let vp = null;
    try { vp = await cizInPage(tab, 'viewport', {}); } catch {}
    const note = vp ? `Visible page is ${vp.width}x${vp.height} CSS px; use these image pixels as click x and y.` : '';
    return { data: m[1], mimeType: 'image/png', title: tab.title || '', url: tab.url || '', note };
  },

  // Debugging: the tab's requests and redirects (metadata only, see lib/netlog.js) and its console messages.
  async network_log(args) {
    const tab = await cizTabFor(args);
    return cizNetLog(tab.id, args);
  },
  async console_log(args) {
    return cizConsoleLog(await cizPageTab(args), args);
  },

  // Documents and other text files Claude makes for the user. They live in the add-on (Files in the panel),
  // with Open and Download buttons; nothing is written to disk until the user downloads.
  async create_file(args) {
    const ctx = typeof cizFileContext === 'function' ? cizFileContext() : {};   // the chat turn it belongs to
    const file = await cizFiles.add(Object.assign({ name: args.name, content: args.content, title: args.title, source: 'Claude' }, ctx));
    if (typeof cizOnFileCreated === 'function') cizOnFileCreated(file);
    return {
      file_id: file.id, name: file.name, size: file.size, type: file.mime,
      shown: 'The file card with Open and Download buttons is in the panel. Link to it in your reply with [' + file.name + '](zen://file/' + file.id + ').',
    };
  },
};
