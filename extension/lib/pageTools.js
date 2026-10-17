'use strict';
// Claudefox: the tools Claude can use on Zen (names and schemas live in host/lib/toolSchemas.js).
// Page work runs through tabs.executeScript, which puts the code in the add-on's isolated
// content-script world: the page's own scripts cannot see or change it.
//
// Fixed rules enforced here, whatever Claude asks:
//   - Non-web pages (about:, moz-extension:) are never read or touched. file: pages only inside folders the user
//     allowed (lib/local.js), and never by army workers.
//   - Google sign-in pages are not read or touched unless Unsafe mode is on (Settings).
//   - Password, 2FA and payment fields are never filled or typed into.

const cfxSleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- add-on side

async function cfxTabFor(args) {
  if (args && args.tab_id != null) {
    try { return await browser.tabs.get(Number(args.tab_id)); } catch { throw new Error(`No tab with id ${args.tab_id}. Call tabs_list.`); }
  }
  const [t] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error('No active tab. Pass a tab_id from tabs_list.');
  return t;
}

// Army workers (lib/army.js) stay on web pages, and Google sign-in is hands-off for them even in Unsafe mode.
function cfxArmyRefuse(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Army workers only work on web pages.');
  if (cfxUrlBlocked(url, { unsafe: false }).blocked) throw new Error('Army workers can\'t use Google sign-in pages, even in Unsafe mode.');
}

function cfxGateOpts() {
  const s = cfxState.get();
  return { unsafe: !!s.unsafe, localGrants: s.localGrants || [] };
}

// A file: tab (never an army call, those are refused before): Zen must let the add-on in, and the user must allow
// the folder. Outside the grants this asks the user and waits for the answer.
async function cfxLocalGate(gate) {
  if ((await cfxLocal.fileAccess()) === 'no') throw new Error(CFX_FILE_ACCESS_OFF);
  if (gate.local) return;
  const r = await cfxLocal.ask(gate.needGrant);
  if (!r.ok) throw new Error(r.error);
}

// The site gate (lib/siteGate.js) for web tabs. Acting tools are 'act'; everything else that looks at a tab is 'read'.
const CFX_ACT_TOOLS = new Set(['click', 'hover', 'fill', 'fill_form', 'type_text', 'press_key', 'scroll', 'media', 'navigate', 'upload_attach']);

// Automatic mode (the state key is still `trusted`) or Unsafe mode, which includes it: the one rule for "this ask is answered Yes
// by itself" (site cards, form sends, uploads, fill_form). A scheduled macro's turn only reads its own sites, so it is never
// automatic. Blocked sites, Google sign-in pages and protected folders are refused by their own checks, not by this rule.
function cfxAutomatic() {
  const s = cfxState.get();
  if (!s.trusted && !s.unsafe) return false;
  return !(typeof cfxSiteGate !== 'undefined' && cfxSiteGate.scheduled && cfxSiteGate.scheduled());
}

async function cfxSiteOpts(args) {
  let blocks = {};
  try { blocks = (await browser.storage.local.get('sites')).sites || {}; } catch {}
  return { trusted: cfxAutomatic(), blocks, army: (args && args.__army) || null };
}

// true when the tab may be used; false when the tab moved to another site while the user was asked (read it again).
async function cfxSiteStep(tab, args, tool) {
  const site = cfxSiteOf(tab.url);
  if (!site) return true;   // not a web page: the folder grants and the fixed rules above decide
  await cfxSiteGate.use(site, CFX_ACT_TOOLS.has(tool) ? 'act' : 'read', await cfxSiteOpts(args));
  return cfxSiteOf((await cfxTabFor(args)).url) === site;
}

// A file: tab read during a turn: the helper hears that local content went to Claude.
function cfxLocalRead(tool) {
  if (CFX_ACT_TOOLS.has(tool) || typeof cfxChatId !== 'function') return;
  const id = cfxChatId();
  if (id) sendNative({ type: 'local_read', id });
}

// The tab a tool will use, and the gate it passed (view: the looser screenshot rule; tool: for the site gate's read/act).
// A file: tab outside the allowed folders waits for the user's answer in the confirm window, up to two minutes, and a web
// tab outside the chat's sites waits for the card; the page or the user may move the tab meanwhile. So after an answer
// the tab is read again and checked from the start: the tool only ever acts on what was allowed, never on whatever the
// tab shows by then.
async function cfxGatedTab(args, view, tool) {
  for (let round = 0; ; round++) {
    const tab = await cfxTabFor(args);
    if (args && args.__army) {
      cfxArmyRefuse(tab.url);
      if (await cfxSiteStep(tab, args, tool)) return { tab, gate: { blocked: false } };
    } else {
      const gate = (view ? cfxViewBlocked : cfxUrlBlocked)(tab.url || '', cfxGateOpts());
      if (!gate.local && !gate.needGrant) {
        if (gate.blocked || await cfxSiteStep(tab, args, tool)) return { tab, gate };
      } else {
        await cfxLocalGate(gate);
        if (!gate.needGrant) { cfxLocalRead(tool); return { tab, gate }; }
      }
    }
    if (round >= 2) throw new Error(`Tab ${tab.id} kept moving to other folders or sites while the user was asked, so Claude did not use it.`);
  }
}

// A tab Claude may read or act on: not a non-web page, and not a Google sign-in page unless Unsafe mode is on.
async function cfxPageTab(args, tool) {
  const { tab, gate } = await cfxGatedTab(args, false, tool);
  if (gate.blocked) {
    if (/^about:/i.test(tab.url || '') && !cfxViewBlocked(tab.url).blocked) {
      throw new Error(`Tab ${tab.id} is a browser page (${String(tab.url).split(/[?#]/)[0]}): add-ons can't read or click inside those, but screenshot shows it.`);
    }
    throw new Error(`Cannot use tab ${tab.id}: ${gate.reason}.`);
  }
  return tab;
}

async function cfxInPage(tab, op, args) {
  const { __army, ...pageArgs } = args || {};   // which worker is calling is the add-on's business, not the page's
  // The page code is installed once per document (window.__cfxOp, version window.__cfxOpV): a call first sends a small
  // probe, and sends the full code only when the page answers that it has none of this version.
  const run = async code => {
    try {
      const res = await browser.tabs.executeScript(tab.id, { code, runAt: 'document_idle' });
      return res && res[0];
    } catch (e) {
      const why = String((e && e.message) || e).replace(/^Error:\s*/, '');
      // Zen's "Access local files" switch is off (or was turned off since the last check).
      if (/^file:/i.test(tab.url || '') && /permission|not allowed|denied|cannot access/i.test(why)) throw new Error(CFX_FILE_ACCESS_OFF);
      throw new Error(why);
    }
  };
  const first = await run(cfxPageProbe(op, pageArgs));
  if (first && first.__cfxNeedInstall === true) return run(cfxPageCode(op, pageArgs));
  return first;
}

async function cfxWaitLoaded(tabId, ms) {
  const t0 = Date.now();
  await cfxSleep(250);
  for (;;) {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete' || Date.now() - t0 > ms) {
      return { tab_id: tabId, url: t.url || '', title: t.title || '', loaded: t.status === 'complete' };
    }
    await cfxSleep(200);
  }
}

// A click, Enter or submitting type_text, once the message has read page content: would it post a form or leave the site?
// Asked of the page (the 'classify' op, read only); the gate's risky card decides. An older page script that does not know
// the op lets the call through; any other failure refuses it.
async function cfxRiskCheck(tab, args) {
  if (!cfxSiteGate.isRead()) return;
  let c;
  try { c = await cfxInPage(tab, 'classify', args); }
  catch (e) {
    if (/Unknown page operation/.test((e && e.message) || '')) return;
    throw new Error('Could not check what this action does, so Claude did not do it.');
  }
  if (!c || c.found === false) return;
  const opts = await cfxSiteOpts(args);
  if (c.submitsPost) await cfxSiteGate.risky(cfxSiteOf(tab.url), 'post', opts);
  if (c.leavesTo) await cfxSiteGate.risky(String(c.leavesTo), 'leave', opts);
}

// navigate to a URL / tab_open: the target site is opened with the gate's 'open' check; a different site than where the
// page is now is 'leave' (asked only once the message has read a page). Army workers open tabs in the background and
// are held to the run's list by the 'open' check alone.
async function cfxOpenCheck(url, fromUrl, args) {
  const site = cfxSiteOf(url);
  if (!site) return;
  const opts = await cfxSiteOpts(args);
  await cfxSiteGate.use(site, 'open', opts);
  if (site !== cfxSiteOf(fromUrl)) await cfxSiteGate.risky(site, 'leave', opts);
}

// The page the chat window shows now: where a new tab "leaves" from.
async function cfxWindowTabUrl() {
  const wid = cfxSiteGate.windowId();
  try {
    const [t] = await browser.tabs.query(wid != null ? { active: true, windowId: wid } : { active: true, lastFocusedWindow: true });
    return (t && t.url) || '';
  } catch { return ''; }
}

// After a click or Enter: did the page navigate (or start to), and did a new tab open? Tells Claude what
// happened without an extra screenshot.
async function cfxAfterAction(tab, run) {
  const opened = [];
  const onCreated = t => { if (t.openerTabId === tab.id) opened.push(t); };
  const ev = browser.tabs.onCreated;
  if (ev) ev.addListener(onCreated);
  try {
    const out = await run();
    const before = tab.url || '';
    let t = null;
    for (let i = 0; i < 5; i++) {
      await cfxSleep(100);
      try { t = await browser.tabs.get(tab.id); } catch { return Object.assign(out, { tab_closed: true }); }
      if (t.status === 'loading' || (t.url && t.url !== before)) break;
    }
    if (t && t.status === 'loading') {
      const done = await cfxWaitLoaded(tab.id, 15000);
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

function cfxRefuseUrl(url, army) {
  if (army) {
    try { cfxArmyRefuse(url); } catch (e) { throw new Error(`Refused: ${e.message}`); }
    return;
  }
  // Firefox refuses to open file: URLs from add-ons; local pages open through the helper's local_page_open.
  if (/^file:/i.test(url)) throw new Error('Refused: file: pages are off-limits to tab_open and navigate. To open a file from this computer, use local_page_open.');
  const gate = cfxUrlBlocked(url, { unsafe: !!cfxState.get().unsafe });
  if (gate.blocked) throw new Error(`Refused: ${gate.reason}.`);
}

function cfxBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Zen shows PDFs in its own viewer, which add-ons cannot read. Fetch the file instead: the helper saves it
// and Claude reads it with its Read tool.
async function cfxPdfOf(tab) {
  const url = tab.url || '';
  let pdf = /\.pdf(?:$|[?#])/i.test(url);
  if (!pdf) { try { pdf = (await cfxInPage(tab, 'ctype', {})) === 'application/pdf'; } catch { pdf = false; } }
  if (!pdf) return null;
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`This tab shows a PDF, but downloading it failed (HTTP ${r.status}).`);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 30 * 1024 * 1024) throw new Error('This tab shows a PDF larger than 30 MB, too big to read.');
  return { pdf_base64: cfxBase64(buf), title: tab.title || '', url, bytes: buf.byteLength };
}

// Google Docs, Slides and Sheets draw their text on a canvas, so the page itself has little to read. Their export
// links give the whole text with the user's own session (docs.google.com is not a sign-in page).
async function cfxGoogleExport(tab, args) {
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

// fill_form's card (the panel shows it): one at a time. The panel shows it within CFX_FILL_MS.shown and answers within
// CFX_FILL_MS.answer; a card never shown, never answered, or ended by Stop is a Deny. Automatic mode and Unsafe mode skip it.
const CFX_FILL_MS = { shown: 5000, answer: 120000 };
let cfxFillCard = null, cfxFillSeq = 0;
function cfxFillCut(v) {
  const chars = [...(v == null ? '' : String(v))];
  return chars.length > 80 ? chars.slice(0, 79).join('') + '…' : chars.join('');
}
function cfxFillAsk(site, rows) {
  return new Promise(resolve => {
    const card = { id: 'fill-' + (++cfxFillSeq), shown: false, timer: null, done: resolve };
    cfxFillCard = card;
    card.timer = setTimeout(() => cfxFillEnd(card, false), CFX_FILL_MS.shown);
    cfxState.set({ fillAsk: { id: card.id, site, rows } });
  });
}
function cfxFillEnd(card, allow) {
  if (cfxFillCard !== card) return;
  cfxFillCard = null;
  clearTimeout(card.timer);
  cfxState.set({ fillAsk: null });
  card.done(allow);
}
function cfxFillShown(id) {
  const card = cfxFillCard;
  if (!card || card.id !== id || card.shown) return;
  card.shown = true;
  clearTimeout(card.timer);
  card.timer = setTimeout(() => cfxFillEnd(card, false), CFX_FILL_MS.answer);
}
function cfxFillAnswer(id, allow) { if (cfxFillCard && cfxFillCard.id === id) cfxFillEnd(cfxFillCard, !!allow); }
function cfxFillCancel() { if (cfxFillCard) cfxFillEnd(cfxFillCard, false); }

// ---------------------------------------------------------------- uploads (upload_file) and page dialogs

// "2.4 MB", "35 KB": the size in the upload card (the same rule as sizeText in panel-chat.js).
function cfxSizeText(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

// The upload card: "Claude wants to upload <name> (<size>) to <site>". Every upload asks, except in Automatic or Unsafe mode. The panel calls
// shown(id) when the card is on screen (SHOWN_MS), then answer(id, allow) (ANSWER_MS); no shown or no answer refuses. One
// card at a time: wait() refuses a second one while one is open. cancel() (Stop) refuses the open card. State: uploadAsk
// { id, name, size, site } while the card is open, else null. Timers are looked up at call time and always cleared.
const cfxUploadGate = (() => {
  const SHOWN_MS = 5000, ANSWER_MS = 120000;
  let cur = null;   // { id, resolve, timer }
  const end = allow => {
    if (!cur) return;
    const c = cur;
    cur = null;
    clearTimeout(c.timer);
    cfxState.set({ uploadAsk: null });
    c.resolve(allow === true);
  };
  return {
    // Resolves true (Allow) or false (Deny, a timer, Stop, or another card already open).
    wait(ask) {
      return new Promise(resolve => {
        if (cur) { resolve(false); return; }
        cur = { id: ask.id, resolve, timer: setTimeout(() => end(false), SHOWN_MS) };
        cfxState.set({ uploadAsk: { id: ask.id, name: ask.name, size: cfxSizeText(ask.size), site: ask.site } });
      });
    },
    shown(id) {
      if (!cur || cur.id !== id) return;
      clearTimeout(cur.timer);
      cur.timer = setTimeout(() => end(false), ANSWER_MS);
    },
    answer(id, allow) { if (cur && cur.id === id) end(allow === true); },
    cancel() { cfxUploads.clear(); end(false); },
  };
})();

// The upload the user allowed and the parts of its bytes that reached the add-on: id -> { tabId, key, site, count, parts[], target, name, type }.
// An upload stays here between its card and its attach; Stop (cfxUploadGate.cancel) and a refusal drop it.
const cfxUploads = new Map();
const CFX_UPLOAD_REFUSED = 'The user did not allow this upload.';
const CFX_UPLOAD_PART_MAX = 720000;   // base64 characters in one part (the helper sends 700 KB parts)
const CFX_UPLOAD_MAX_PARTS = 64;

// The line a click, key press or typing result gets when the page showed an alert, confirm or prompt meanwhile.
function cfxDialogNote(res) {
  const d = res && res.dialog;
  if (!d) return res;
  const more = res.more_dialogs ? ` (and ${res.more_dialogs} more)` : '';
  res.note = `The page showed a ${d.kind}: "${d.text}" (answered ${d.answered}).${more}`;
  return res;
}

async function cfxUploadAttach(args) {
  const id = String(args.id || '').slice(0, 40);
  if (!id) throw new Error('Missing upload id.');
  if (args.ask) {
    const name = String(args.name || '').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const size = Number(args.size);
    const count = Number(args.parts);
    if (!name || !Number.isFinite(size) || size < 0 || !Number.isInteger(count) || count < 1 || count > CFX_UPLOAD_MAX_PARTS) throw new Error('Bad upload request.');
    if (!args.ref && !args.selector) throw new Error('Give a ref or a CSS selector for the file field.');
    const tab = await cfxPageTab(args, 'upload_attach');
    const site = cfxSiteOf(tab.url);
    const where = site || (/^file:/i.test(tab.url || '') ? 'a local page' : 'this page');
    const target = args.ref ? { ref: String(args.ref) } : { selector: String(args.selector) };
    const allowed = cfxAutomatic() || await cfxUploadGate.wait({ id, name, size, site: where });
    if (!allowed) throw new Error(CFX_UPLOAD_REFUSED);
    cfxUploads.set(id, { tabId: tab.id, key: site || String(tab.url || '').split(/[?#]/)[0], site: where, count, parts: [], target, name, type: String(args.type || 'application/octet-stream').slice(0, 100) });
    return { accepted: true };
  }
  const up = cfxUploads.get(id);
  if (!up) throw new Error(CFX_UPLOAD_REFUSED);
  try {
    for (let i = 0; i < up.count; i++) if (typeof up.parts[i] !== 'string') throw new Error('Part ' + i + ' of the file did not arrive.');
    // The page may have moved to another site while the user was asked or the bytes travelled: attach only where it was allowed.
    const tab = await cfxPageTab({ tab_id: up.tabId }, 'upload_attach');
    const now = cfxSiteOf(tab.url) || String(tab.url || '').split(/[?#]/)[0];
    if (now !== up.key) throw new Error('The tab moved to another site after the upload was allowed, so the file was not attached.');
    const base = Object.assign({ name: up.name, type: up.type }, up.target);
    let res;
    if (up.count === 1) res = await cfxInPage(tab, 'attach', Object.assign({ data: up.parts[0] }, base));
    else {
      for (let i = 0; i < up.count; i++) await cfxInPage(tab, 'attachpart', { id, index: i, data: up.parts[i] });
      res = await cfxInPage(tab, 'attach', Object.assign({ id }, base));
    }
    return Object.assign({}, res, { site: up.site });
  } finally {
    cfxUploads.delete(id);
  }
}

async function cfxUploadPart(args) {
  const id = String(args.id || '').slice(0, 40);
  const up = cfxUploads.get(id);
  if (!up) throw new Error(CFX_UPLOAD_REFUSED);
  const index = Number(args.index);
  if (!Number.isInteger(index) || index < 0 || index >= up.count) throw new Error('Bad part number.');
  if (typeof args.data !== 'string' || args.data.length > CFX_UPLOAD_PART_MAX) throw new Error('Bad part.');
  up.parts[index] = args.data;
  return { stored: index };
}

const CFX_TOOLS = {
  async ping() { return { pong: true, version: browser.runtime.getManifest().version }; },

  async tabs_list() {
    // Only the chat window's tabs, and a site outside the chat's list shows as id and site only (siteGate.tabView).
    const wid = cfxSiteGate.windowId();
    const tabs = await browser.tabs.query(wid != null ? { windowId: wid } : { lastFocusedWindow: true });
    const opts = { trusted: cfxAutomatic(), blocks: (await cfxSiteOpts({})).blocks };
    return tabs.map(t => {
      const view = cfxSiteGate.tabView(t, opts);
      const army = view.url !== undefined && cfxArmy.owner(t.id);   // a tab an army worker is using, so Claude leaves it to that worker
      return army ? Object.assign(view, { army: army.worker }) : view;
    });
  },

  async tab_open(args) {
    const url = String(args.url || '').trim();
    cfxRefuseUrl(url, args.__army);
    // A worker's tab opens in the background, so it leaves nothing: the run's list (the 'open' check) is its only rule.
    await cfxOpenCheck(url, args.__army ? url : await cfxWindowTabUrl(), args);
    const since = Date.now();
    const tab = await browser.tabs.create({ url, active: args.active !== false });
    // Registered before the page loads, so Stop or the worker's end closes it even mid-load (or at once, when that
    // came while the tab was being made).
    if (args.__army && !cfxArmy.register(tab.id, args.__army, since)) throw new Error('This worker was stopped, so its new tab was closed.');
    if (args.wait === false) return { tab_id: tab.id, url };
    const done = await cfxWaitLoaded(tab.id, 30000);
    return { tab_id: tab.id, url: done.url || url, title: done.title, loaded: done.loaded };
  },

  async tab_activate(args) {
    if (args.tab_id == null) throw new Error('Give the tab_id to switch to.');
    const tab = await cfxTabFor(args);
    await browser.tabs.update(tab.id, { active: true });
    try { await browser.windows.update(tab.windowId, { focused: true }); } catch {}
    return { tab_id: tab.id, title: tab.title || '' };
  },

  async tab_close(args) {
    if (args.tab_id == null) throw new Error('Give the tab_id to close.');
    const tab = await cfxTabFor(args);
    await browser.tabs.remove(tab.id);
    return { closed: tab.id, title: tab.title || '' };
  },

  async navigate(args) {
    const want = String(args.url || '').trim();
    if (!want) throw new Error('Give a URL, or "back", "forward" or "reload".');
    const tab = await cfxPageTab(args, 'navigate');
    const word = want.toLowerCase();
    if (word === 'back') await browser.tabs.goBack(tab.id);
    else if (word === 'forward') await browser.tabs.goForward(tab.id);
    else if (word === 'reload') await browser.tabs.reload(tab.id);
    else { cfxRefuseUrl(want, args.__army); await cfxOpenCheck(want, tab.url, args); await browser.tabs.update(tab.id, { url: want }); }
    return cfxWaitLoaded(tab.id, 30000);
  },

  async read_page(args) { return cfxInPage(await cfxPageTab(args, 'read_page'), 'read', args); },

  async get_page_text(args) {
    const tab = await cfxPageTab(args, 'get_page_text');
    const google = await cfxGoogleExport(tab, args);
    if (google) return google;
    const pdf = await cfxPdfOf(tab);
    if (pdf) return pdf;
    const n = Number(args.scroll_to_load);
    const rounds = Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 10) : 0;
    let back = null;
    if (rounds) {
      // Pull in content that loads as you scroll (comments, feeds), then put the page back where it was.
      try { back = (await cfxInPage(tab, 'viewport', {})).scroll_y; } catch {}
      for (let i = 0; i < rounds; i++) { await cfxInPage(tab, 'scroll', { direction: 'bottom' }); await cfxSleep(900); }
    }
    // A worker reads 12,000 characters a part unless it asks for a size; start_at reads on. Other callers read 40,000.
    const textArgs = args.max_chars == null ? { ...args, max_chars: args.__army ? 12000 : 40000 } : args;
    try { return await cfxInPage(tab, 'text', textArgs); }
    finally { if (back != null) { try { await cfxInPage(tab, 'scrollto', { y: back }); } catch {} } }
  },

  async analyze_page(args) { return cfxInPage(await cfxPageTab(args, 'analyze_page'), 'analyze', args); },
  async get_selection(args) { return cfxInPage(await cfxPageTab(args, 'get_selection'), 'selection', args); },
  async find(args) { return cfxInPage(await cfxPageTab(args, 'find'), 'find', args); },

  async click(args) {
    const tab = await cfxPageTab(args, 'click');
    await cfxRiskCheck(tab, args);
    return cfxDialogNote(await cfxAfterAction(tab, () => cfxInPage(tab, 'click', args)));
  },
  async hover(args) { return cfxInPage(await cfxPageTab(args, 'hover'), 'hover', args); },
  async fill(args) { return cfxInPage(await cfxPageTab(args, 'fill'), 'fill', args); },
  // Several fields at once. The page gives each field's label first: a sensitive field refuses the call before any card.
  // The user approves the list in a card; Approve fills each field as fill does. Nothing is submitted.
  async fill_form(args) {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    if (fields.length < 1 || fields.length > 30) throw new Error('fill_form takes 1 to 30 fields.');
    const tab = await cfxPageTab(args, 'fill_form');
    const site = cfxSiteOf(tab.url);
    const labels = (await cfxInPage(tab, 'formlabels', { fields: fields.map(f => ({ ref: f.ref, selector: f.selector })) })).fields;
    const sensitive = labels.find(l => l.sensitive);
    if (sensitive) throw new Error(`Refused: this is a ${sensitive.sensitive}. Ask the user to type it themselves.`);
    if (cfxFillCard) throw new Error("Another form fill is waiting for the user's answer. Try again when it is done.");
    const rows = fields.map((f, i) => ({ label: labels[i].label, value: cfxFillCut(f.value) }));
    if (!cfxAutomatic() && !(await cfxFillAsk(site, rows))) throw new Error('The user did not approve filling this form.');
    const now = await cfxTabFor(args);
    if (now.id !== tab.id || cfxSiteOf(now.url) !== site) throw new Error('The tab moved to another site while the user was asked. Read the page again.');
    const out = [];
    for (let i = 0; i < fields.length; i++) {
      try {
        const r = await cfxInPage(tab, 'fill', { ref: fields[i].ref, selector: fields[i].selector, value: fields[i].value });
        out.push({ label: labels[i].label, filled: r.filled || r.selected });
      } catch (e) { out.push({ label: labels[i].label, error: String((e && e.message) || e) }); }
    }
    return { submitted: false, fields: out };
  },
  async type_text(args) {
    const tab = await cfxPageTab(args, 'type_text');
    if (args.submit) await cfxRiskCheck(tab, args);
    return cfxDialogNote(await (args.submit ? cfxAfterAction(tab, () => cfxInPage(tab, 'type', args)) : cfxInPage(tab, 'type', args)));
  },
  async press_key(args) {
    const tab = await cfxPageTab(args, 'press_key');
    if (String(args.key) === 'Enter') await cfxRiskCheck(tab, args);
    return cfxDialogNote(await (String(args.key) === 'Enter' ? cfxAfterAction(tab, () => cfxInPage(tab, 'press', args)) : cfxInPage(tab, 'press', args)));
  },
  async scroll(args) { return cfxInPage(await cfxPageTab(args, 'scroll'), 'scroll', args); },
  // upload_file (host/lib/upload.js): the card and the bytes arrive in three steps (see cfxUploadAttach).
  async upload_attach(args) { return cfxUploadAttach(args || {}); },
  async upload_part(args) { return cfxUploadPart(args || {}); },
  async media(args) { return cfxInPage(await cfxPageTab(args, 'media'), 'media', args); },

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
      try { found = await cfxInPage(await cfxPageTab(args, 'wait_for'), 'exists', probe); }
      catch (e) { if (/Cannot use tab|No tab|selector|Army workers|did not allow|is blocked in your site list|Outside the sites|Workers cannot|No answer about|Zen keeps add-ons out/.test(e.message)) throw e; }
      if (found) return { found: true, waited_ms: Date.now() - t0 };
      if (Date.now() - t0 >= timeout) return { found: false, waited_ms: Date.now() - t0 };
      await cfxSleep(250);
    }
  },

  async screenshot(args) {
    // Looking is allowed on more pages than acting: about: pages too (see cfxViewBlocked).
    const { tab, gate } = await cfxGatedTab(args, true, 'screenshot');
    if (gate.blocked) throw new Error(`Cannot use tab ${tab.id}: ${gate.reason}.`);
    // captureTab only: bringing the tab to the front to capture it would take the user's tab away from them.
    // JPEG at quality 80 is smaller than PNG. scale 1 (the default): one image pixel per CSS pixel, so click x/y can be read
    // straight off the picture. scale 0.5: half size, so x and y are doubled.
    const half = Number(args.scale) === 0.5;
    let dataUrl, why = 'Zen returned no image';
    try {
      dataUrl = await browser.tabs.captureTab(tab.id, { format: 'jpeg', quality: 80, scale: half ? 0.5 : 1 });
    } catch (e) { why = String((e && e.message) || e).replace(/^Error:\s*/, '').replace(/\.$/, '') || why; }
    const m = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl || '');
    if (!m) {
      if (gate.about) throw new Error('Zen did not let the add-on capture this browser page.');
      if (args.__army) throw new Error(`Could not capture tab ${tab.id}: ${why}. Read the page with get_page_text or find instead.`);
      throw new Error(`Could not capture tab ${tab.id}: ${why}. Zen draws a tab only while it is in front. If you need this picture, ask the user, or bring the tab to the front with tab_activate first.`);
    }
    let note = 'This image is at half size: double x and y for click and hover.';
    if (!half) {
      let vp = null;
      try { vp = await cfxInPage(tab, 'viewport', {}); } catch {}
      note = vp ? `Visible page is ${vp.width}x${vp.height} CSS px; use these image pixels as click x and y.` : '';
    }
    return { data: m[1], mimeType: 'image/jpeg', title: tab.title || '', url: tab.url || '', note };
  },

  // Debugging: the tab's requests and redirects (metadata only, see lib/netlog.js) and its console messages.
  async network_log(args) {
    const tab = await cfxPageTab(args, 'network_log');
    return cfxNetLog(tab.id, args);
  },
  async console_log(args) {
    return cfxConsoleLog(await cfxPageTab(args, 'console_log'), args);
  },

  // Documents and other text files Claude makes for the user. They live in the add-on (Files in the panel),
  // with Open and Download buttons; nothing is written to disk until the user downloads.
  async create_file(args) {
    const ctx = typeof cfxFileContext === 'function' ? cfxFileContext() : {};   // the chat turn it belongs to
    const file = await cfxFiles.add(Object.assign({ name: args.name, content: args.content, title: args.title, source: 'Claude' }, ctx));
    if (typeof cfxOnFileCreated === 'function') cfxOnFileCreated(file);
    return {
      file_id: file.id, name: file.name, size: file.size, type: file.mime,
      shown: 'The file card with Open and Download buttons is in the panel. Link to it in your reply with [' + file.name + '](zen://file/' + file.id + ').',
    };
  },
};
