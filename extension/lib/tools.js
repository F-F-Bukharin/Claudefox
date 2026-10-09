'use strict';
// Claude in Zen: the tools Claude can use on Zen (names and schemas live in host/lib/tools.js).
// Page work runs through tabs.executeScript, which puts the code in the add-on's isolated
// content-script world: the page's own scripts cannot see or change it.
//
// Fixed rules enforced here, whatever Claude asks:
//   - Google sign-in pages and non-web pages (about:, file:, moz-extension:) are never read or touched.
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
  // A real-looking click: pointer and mouse events first (many sites listen to those), then click().
  function realClick(el, x, y) {
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new P('pointerover', o));
    el.dispatchEvent(new MouseEvent('mouseover', o));
    el.dispatchEvent(new P('pointerdown', Object.assign({ buttons: 1, pointerType: 'mouse', isPrimary: true }, o)));
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, o)));
    if (el.focus) el.focus({ preventScroll: true });
    el.dispatchEvent(new P('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, o)));
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
    parts.push(`[${refOf(el)}]`);
    return parts.join(' ');
  }
  const page = extra => Object.assign({ title: document.title, url: location.href }, extra);

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
      const max = clamp(args.max_chars, 1000, 200000, 30000);
      const main = document.querySelector('article, main, [role=main]');
      const root = main && squash(main.innerText).length > 200 ? main : document.body;
      let text = String((root && root.innerText) || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const truncated = text.length > max;
      if (truncated) text = text.slice(0, max);
      return page({ text, truncated });
    }
    case 'find': {
      const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw new Error('Give some words to look for.');
      const limit = clamp(args.limit, 1, 100, 15);
      const out = [];
      for (const el of document.querySelectorAll(INTERACTIVE + ', ' + HEADINGS)) {
        if (!isVisible(el)) continue;
        const hay = (labelOf(el) + ' ' + roleOf(el) + ' ' + (el.getAttribute('name') || '')).toLowerCase();
        if (!words.every(w => hay.includes(w))) continue;
        out.push(describe(el));
        if (out.length >= limit) break;
      }
      return page({ text: out.length ? out.join('\n') : 'No matches.', truncated: false });
    }
    case 'click': {
      let el, x, y;
      if (args.x != null && args.y != null && !args.ref && !args.selector) {
        // Coordinates from a screenshot, in CSS pixels of the visible page.
        x = Number(args.x); y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers.');
        el = document.elementFromPoint(x, y);
        if (!el) throw new Error(`Nothing at ${x},${y}. The page is ${window.innerWidth}x${window.innerHeight}.`);
      } else {
        el = target();
        if (!isVisible(el)) throw new Error('That element is not visible on the page. Try a screenshot and click by x and y.');
        if (el.disabled) throw new Error('That element is disabled.');
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = boxOf(el);
        x = Math.round((r.left || 0) + (r.width || 0) / 2); y = Math.round((r.top || 0) + (r.height || 0) / 2);
      }
      realClick(el, x, y);
      return { clicked: `${roleOf(el)} "${labelOf(el).slice(0, 120)}"`, at: [x, y] };
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
      else if (act !== 'status') throw new Error('action must be play, pause, toggle, mute, unmute, seek or status.');
      return { action: act, paused: act === 'play' ? false : m.paused, muted: m.muted, time: Math.round(m.currentTime), duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null, players: all.length };
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
        return { filled: `${value.length} characters` };
      }
      if (el.tagName === 'INPUT' && /^(checkbox|radio|file|button|submit|reset|image|range|color|hidden)$/i.test(el.type)) {
        throw new Error(`A ${el.type} input takes no text. Use click instead.`);
      }
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') throw new Error('That element does not take text.');
      setValue(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: `${value.length} characters` };
    }
    case 'press': {
      const key = String(args.key || '');
      const KEYS = {
        Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40,
        ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32,
      };
      if (!(key in KEYS) && key.length !== 1) throw new Error(`Unknown key "${key.slice(0, 20)}".`);
      const el = (args.ref || args.selector) ? target() : (document.activeElement || document.body);
      if (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable) refuseSensitive(el);
      const k = key === 'Space' ? ' ' : key;
      const code = KEYS[key] || k.toUpperCase().charCodeAt(0);
      const opts = { key: k, keyCode: code, which: code, bubbles: true, cancelable: true };
      if ((args.ref || args.selector) && el.focus) el.focus();
      const go = el.dispatchEvent(new KeyboardEvent('keydown', opts));
      // Synthetic key events do not trigger the browser's own default action, so do the common ones.
      const textual = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type));
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
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { pressed: key };
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
    case 'exists': {
      if (args.selector) {
        try { return !!document.querySelector(String(args.selector)); } catch (e) { throw new Error('Not a valid CSS selector.'); }
      }
      const t = String(args.text || '').toLowerCase();
      return !!t && String((document.body && document.body.innerText) || '').toLowerCase().includes(t);
    }
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

// A tab Claude may read or act on: not a Google sign-in page, not a non-web page.
async function cizPageTab(args) {
  const tab = await cizTabFor(args);
  const gate = cizUrlBlocked(tab.url || '');
  if (gate.blocked) throw new Error(`Cannot use tab ${tab.id}: ${gate.reason}.`);
  return tab;
}

async function cizInPage(tab, op, args) {
  const code = '(function () { var sensitiveField = ' + cizSensitiveField.toString() + ';\n'
    + 'return (' + cizPageOp.toString() + ')(' + JSON.stringify(op) + ', ' + JSON.stringify(args || {}) + ', sensitiveField);\n})();';
  let res;
  try {
    res = await browser.tabs.executeScript(tab.id, { code, runAt: 'document_idle' });
  } catch (e) {
    throw new Error(String((e && e.message) || e).replace(/^Error:\s*/, ''));
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

function cizRefuseUrl(url) {
  const gate = cizUrlBlocked(url);
  if (gate.blocked) throw new Error(`Refused: ${gate.reason}.`);
}

const CIZ_TOOLS = {
  async ping() { return { pong: true, version: browser.runtime.getManifest().version }; },

  async tabs_list() {
    const tabs = await browser.tabs.query({});
    return tabs.map(t => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url }));
  },

  async tab_open(args) {
    const url = String(args.url || '').trim();
    cizRefuseUrl(url);
    const tab = await browser.tabs.create({ url, active: args.active !== false });
    return { tab_id: tab.id, url };
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
    else { cizRefuseUrl(want); await browser.tabs.update(tab.id, { url: want }); }
    return cizWaitLoaded(tab.id, 30000);
  },

  async read_page(args) { return cizInPage(await cizPageTab(args), 'read', args); },
  async get_page_text(args) { return cizInPage(await cizPageTab(args), 'text', args); },
  async find(args) { return cizInPage(await cizPageTab(args), 'find', args); },
  async click(args) { return cizInPage(await cizPageTab(args), 'click', args); },
  async fill(args) { return cizInPage(await cizPageTab(args), 'fill', args); },
  async press_key(args) { return cizInPage(await cizPageTab(args), 'press', args); },
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
      catch (e) { if (/Cannot use tab|No tab|selector/.test(e.message)) throw e; }
      if (found) return { found: true, waited_ms: Date.now() - t0 };
      if (Date.now() - t0 >= timeout) return { found: false, waited_ms: Date.now() - t0 };
      await cizSleep(250);
    }
  },

  async screenshot(args) {
    const tab = await cizPageTab(args);
    let dataUrl;
    // scale 1: one image pixel per CSS pixel, so click x/y can be read straight off the picture.
    try {
      dataUrl = await browser.tabs.captureTab(tab.id, { format: 'png', scale: 1 });
    } catch {
      await browser.tabs.update(tab.id, { active: true });
      await cizSleep(300);
      dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png', scale: 1 });
    }
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
    if (!m) throw new Error('Could not capture the tab.');
    let vp = null;
    try { vp = await cizInPage(tab, 'viewport', {}); } catch {}
    const note = vp ? `Visible page is ${vp.width}x${vp.height} CSS px; use these image pixels as click x and y.` : '';
    return { data: m[1], mimeType: 'image/png', title: tab.title || '', url: tab.url || '', note };
  },
};
