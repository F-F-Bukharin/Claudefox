'use strict';
// The page operations that act on the page: click, hover, type, media, fill, press, scroll, scrollto. classify (last) only reads.
// Same shape as pageOpRead.js: declarations joined into the injected script by cizPageCode (pageOp.js).

function cizOpClick(env, args) {
  const { squash, realClick, labelOf, roleOf, targetOrPoint, focusDesc, page } = env;
  const t = targetOrPoint();
  if (t.el.disabled) throw new Error('That element is disabled.');
  realClick(t.el, t.x, t.y);
  const after = t.el.isConnected ? squash(t.el.innerText || t.el.value || labelOf(t.el)).slice(0, 120) : '(gone from the page)';
  return { clicked: `${roleOf(t.el)} "${labelOf(t.el).slice(0, 120)}"`, at: [t.x, t.y], now_shows: after, focused: focusDesc() };
}

function cizOpHover(env, args) {
  const { hoverEvents, labelOf, roleOf, targetOrPoint } = env;
  const t = targetOrPoint();
  hoverEvents(t.el, t.x, t.y);
  return { hovered: `${roleOf(t.el)} "${labelOf(t.el).slice(0, 120)}"`, at: [t.x, t.y] };
}

function cizOpType(env, args) {
  const { squash, target, refuseSensitive, isTextField, setValue } = env;
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

function cizOpMedia(env, args) {
  const { isVisible, boxOf, target, page } = env;
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

function cizOpFill(env, args) {
  const { squash, target, refuseSensitive, setValue } = env;
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

function cizOpPress(env, args) {
  const { INTERACTIVE, isVisible, target, focusDesc, refuseSensitive, isTextField, setValue } = env;
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

function cizOpScroll(env, args) {
  const { clamp, labelOf, roleOf, target } = env;
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

function cizOpScrollto(env, args) {
  const { clamp } = env;
  window.scrollTo(0, clamp(args.y, 0, 1e9, 0));
  return { y: Math.round(window.scrollY) };
}

// What a click, an Enter or a submitting type_text on the target would do: post a form, or leave the site. The target is
// found as click, type and press find theirs. Read only: no click, focus, scroll or change, and no field values back.
function cizOpClassify(env, args) {
  const { target } = env;
  let el = null;
  if (args.x != null && args.y != null && !args.ref && !args.selector) {
    const x = Number(args.x), y = Number(args.y);
    el = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
  } else if (args.ref || args.selector) {
    try { el = target(); } catch (e) { el = null; }   // a stale ref, no match or a bad selector: not found
  } else {
    el = document.activeElement;
    if (el === document.body || el === document.documentElement) el = null;
  }
  if (!el) return { submitsPost: false, leavesTo: null, found: false };
  // The form posts when its method says POST (any case). formmethod on a submit control wins over its form's method.
  const formPosts = f => !!f && String(f.getAttribute('method') || '').toLowerCase() === 'post';
  const controlPosts = c => c.hasAttribute('formmethod') ? String(c.getAttribute('formmethod')).toLowerCase() === 'post' : formPosts(c.form);
  // A click often lands on text or an icon inside the button, so the button around the target counts too.
  const ctl = el.tagName === 'INPUT' ? el : el.closest('button');
  const submitControl = !!ctl && ((ctl.tagName === 'BUTTON' && ctl.type === 'submit') || (ctl.tagName === 'INPUT' && (ctl.type === 'submit' || ctl.type === 'image')));
  // Enter in a field, or type_text with submit, sends the field's form with the form's own method (cizOpPress and cizOpType do that).
  const fieldPosts = (args.key === 'Enter' || !!args.submit) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && formPosts(el.form);
  const submitsPost = (submitControl && controlPosts(ctl)) || fieldPosts;
  // The site of an http(s) URL: lowercase host, one leading www. dropped; '' for any other. The page cannot call the add-on's
  // cizSiteOf, so the same rule is repeated here.
  const siteOf = s => {
    let u;
    try { u = new URL(String(s), document.baseURI); } catch (e) { return ''; }
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : '';
  };
  const a = el.closest('a[href]');
  const link = a ? siteOf(a.getAttribute('href')) : '';
  return { submitsPost, leavesTo: link && link !== siteOf(location.href) ? link : null, found: true };
}
