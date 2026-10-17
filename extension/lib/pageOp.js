'use strict';
// Claudefox: the page side of the page tools. The code in this file and in pageOpRead.js and pageOpAct.js runs
// inside the tab. cfxPageCode joins the text of these functions into the script that cfxInPage (pageTools.js) injects,
// so each one may use only the page's own globals and the other injected functions, never anything from the add-on.

// ---------------------------------------------------------------- page side
// Injected into the tab with sensitiveField (from policy.js) passed in. Must stay self-contained.
// The helpers and constants are in cfxPageEnv; the operations are in pageOpRead.js and pageOpAct.js.

function cfxPageEnv(args, sensitiveField) {
  const MAX_REFS = 3000;
  const st = window.__cfxSt || (window.__cfxSt = { seq: 0, refs: new Map() });
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
    if (el.__cfxRef && st.refs.get(el.__cfxRef) === el) return el.__cfxRef;
    if (st.refs.size >= MAX_REFS) st.refs.clear();
    const id = 'ref_' + (++st.seq);
    el.__cfxRef = id;
    st.refs.set(id, el);
    return id;
  }
  function target(a) {
    a = a || args;
    if (a.ref) {
      const el = st.refs.get(String(a.ref));
      if (!el || !el.isConnected) throw new Error('That element is gone or the page changed. Call read_page or find again for fresh refs.');
      return el;
    }
    if (a.selector) {
      let el;
      try { el = document.querySelector(String(a.selector)); } catch (e) { throw new Error('Not a valid CSS selector.'); }
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
  return { MAX_REFS, sensitiveField, st, INTERACTIVE, HEADINGS, clamp, squash, isVisible, boxOf, centerOf,
      PointerCtor, hoverEvents, realClick, labelOf, roleOf, refOf, target, targetOrPoint, focusDesc,
      fieldDesc, refuseSensitive, isTextField, setValue, describe, page, shown, mainRoot, markdown,
      metaInfo, words, structuredData, notices, selectionText };
}

function cfxPageOp(op, args, sensitiveField) {
  const env = cfxPageEnv(args, sensitiveField);
  switch (op) {
    case 'read': return cfxOpRead(env, args);
    case 'text': return cfxOpText(env, args);
    case 'analyze': return cfxOpAnalyze(env, args);
    case 'selection': return cfxOpSelection(env, args);
    case 'find': return cfxOpFind(env, args);
    case 'click': return cfxDialogGuard(args, () => cfxOpClick(env, args));
    case 'hover': return cfxOpHover(env, args);
    case 'type': return cfxDialogGuard(args, () => cfxOpType(env, args));
    case 'media': return cfxOpMedia(env, args);
    case 'viewport': return cfxOpViewport(env, args);
    case 'fill': return cfxOpFill(env, args);
    case 'press': return cfxDialogGuard(args, () => cfxOpPress(env, args));
    case 'scroll': return cfxOpScroll(env, args);
    case 'scrollto': return cfxOpScrollto(env, args);
    case 'exists': return cfxOpExists(env, args);
    case 'ctype': return cfxOpCtype(env, args);
    case 'classify': return cfxOpClassify(env, args);
    case 'formlabels': return cfxOpFormLabels(env, args);
    case 'attach': return cfxOpAttach(env, args);
    case 'attachpart': return cfxOpAttachPart(env, args);
  }
  throw new Error('Unknown page operation: ' + op);
}

// The page code, the same for every call: sensitiveField (from policy.js), then the page-side functions. Built once.
function cfxPageBody() {
  if (cfxPageBody.text) return cfxPageBody.text;
  const parts = [ cfxPageEnv, cfxPageOp, cfxOpRead, cfxOpText, cfxOpAnalyze, cfxOpSelection,
      cfxOpFind, cfxOpClick, cfxOpHover, cfxOpType, cfxOpMedia, cfxOpViewport, cfxOpFill,
      cfxOpPress, cfxOpScroll, cfxOpScrollto, cfxOpExists, cfxOpCtype, cfxOpClassify, cfxOpFormLabels,
      cfxOpAttach, cfxOpAttachPart, cfxDialogGuard ];
  return (cfxPageBody.text = 'var sensitiveField = ' + cfxSensitiveField.toString() + ';\n' + parts.map(f => f.toString() + '\n').join(''));
}

// The version of the page code: a hash of its source (FNV-1a), computed once. A page that holds another version is
// given the new code.
function cfxPageVersion() {
  if (cfxPageVersion.v) return cfxPageVersion.v;
  let h = 0x811c9dc5;
  const b = cfxPageBody();
  for (let i = 0; i < b.length; i++) { h ^= b.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (cfxPageVersion.v = h.toString(36) + '.' + b.length.toString(36));
}

// The script cfxInPage runs in the tab the first time: installs the page operation as window.__cfxOp with its version in
// window.__cfxOpV, then runs the operation. Self-contained: it works on a fresh page. The tab's isolated content-script
// world holds window.__cfxOp, so page scripts cannot see or replace it.
function cfxPageCode(op, args) {
  return '(function () {\n' + cfxPageBody()
    + 'window.__cfxOp = function (op, args) { return cfxPageOp(op, args, sensitiveField); };\n'
    + 'window.__cfxOpV = ' + JSON.stringify(cfxPageVersion()) + ';\n'
    + 'return window.__cfxOp(' + JSON.stringify(op) + ', ' + JSON.stringify(args) + ');\n})();';
}

// The small script every later call sends: runs the installed operation when it is this version, else answers with
// the marker that tells cfxInPage to send cfxPageCode.
function cfxPageProbe(op, args) {
  return '(function () { return window.__cfxOpV === ' + JSON.stringify(cfxPageVersion()) + ' && typeof window.__cfxOp === "function"'
    + ' ? window.__cfxOp(' + JSON.stringify(op) + ', ' + JSON.stringify(args) + ') : { __cfxNeedInstall: true }; })();';
}
