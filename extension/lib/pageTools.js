'use strict';
// Claude in Zen: the tools Claude can use on Zen (names and schemas live in host/lib/toolSchemas.js).
// Page work runs through tabs.executeScript, which puts the code in the add-on's isolated
// content-script world: the page's own scripts cannot see or change it.
//
// Fixed rules enforced here, whatever Claude asks:
//   - Non-web pages (about:, moz-extension:) are never read or touched. file: pages only inside folders the user
//     allowed (lib/local.js), and never by army workers.
//   - Google sign-in pages are not read or touched unless Unsafe mode is on (Settings).
//   - Password, 2FA and payment fields are never filled or typed into.

const cizSleep = ms => new Promise(r => setTimeout(r, ms));

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

// The site gate (lib/siteGate.js) for web tabs. Acting tools are 'act'; everything else that looks at a tab is 'read'.
const CIZ_ACT_TOOLS = new Set(['click', 'hover', 'fill', 'type_text', 'press_key', 'scroll', 'media', 'navigate']);

async function cizSiteOpts(args) {
  let blocks = {};
  try { blocks = (await browser.storage.local.get('sites')).sites || {}; } catch {}
  return { trusted: !!cizState.get().trusted, blocks, army: (args && args.__army) || null };
}

// true when the tab may be used; false when the tab moved to another site while the user was asked (read it again).
async function cizSiteStep(tab, args, tool) {
  const site = cizSiteOf(tab.url);
  if (!site) return true;   // not a web page: the folder grants and the fixed rules above decide
  await cizSiteGate.use(site, CIZ_ACT_TOOLS.has(tool) ? 'act' : 'read', await cizSiteOpts(args));
  return cizSiteOf((await cizTabFor(args)).url) === site;
}

// A file: tab read during a turn: the helper hears that local content went to Claude.
function cizLocalRead(tool) {
  if (CIZ_ACT_TOOLS.has(tool) || typeof cizChatId !== 'function') return;
  const id = cizChatId();
  if (id) sendNative({ type: 'local_read', id });
}

// The tab a tool will use, and the gate it passed (view: the looser screenshot rule; tool: for the site gate's read/act).
// A file: tab outside the allowed folders waits for the user's answer in the confirm window, up to two minutes, and a web
// tab outside the chat's sites waits for the card; the page or the user may move the tab meanwhile. So after an answer
// the tab is read again and checked from the start: the tool only ever acts on what was allowed, never on whatever the
// tab shows by then.
async function cizGatedTab(args, view, tool) {
  for (let round = 0; ; round++) {
    const tab = await cizTabFor(args);
    if (args && args.__army) {
      cizArmyRefuse(tab.url);
      if (await cizSiteStep(tab, args, tool)) return { tab, gate: { blocked: false } };
    } else {
      const gate = (view ? cizViewBlocked : cizUrlBlocked)(tab.url || '', cizGateOpts());
      if (!gate.local && !gate.needGrant) {
        if (gate.blocked || await cizSiteStep(tab, args, tool)) return { tab, gate };
      } else {
        await cizLocalGate(gate);
        if (!gate.needGrant) { cizLocalRead(tool); return { tab, gate }; }
      }
    }
    if (round >= 2) throw new Error(`Tab ${tab.id} kept moving to other folders or sites while the user was asked, so Claude did not use it.`);
  }
}

// A tab Claude may read or act on: not a non-web page, and not a Google sign-in page unless Unsafe mode is on.
async function cizPageTab(args, tool) {
  const { tab, gate } = await cizGatedTab(args, false, tool);
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
  const code = cizPageCode(op, pageArgs);
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

// A click, Enter or submitting type_text, once the message has read page content: would it post a form or leave the site?
// Asked of the page (the 'classify' op, read only); the gate's risky card decides. An older page script that does not know
// the op lets the call through; any other failure refuses it.
async function cizRiskCheck(tab, args) {
  if (!cizSiteGate.isRead()) return;
  let c;
  try { c = await cizInPage(tab, 'classify', args); }
  catch (e) {
    if (/Unknown page operation/.test((e && e.message) || '')) return;
    throw new Error('Could not check what this action does, so Claude did not do it.');
  }
  if (!c || c.found === false) return;
  const opts = await cizSiteOpts(args);
  if (c.submitsPost) await cizSiteGate.risky(cizSiteOf(tab.url), 'post', opts);
  if (c.leavesTo) await cizSiteGate.risky(String(c.leavesTo), 'leave', opts);
}

// navigate to a URL / tab_open: the target site is opened with the gate's 'open' check; a different site than where the
// page is now is 'leave' (asked only once the message has read a page). Army workers open tabs in the background and
// are held to the run's list by the 'open' check alone.
async function cizOpenCheck(url, fromUrl, args) {
  const site = cizSiteOf(url);
  if (!site) return;
  const opts = await cizSiteOpts(args);
  await cizSiteGate.use(site, 'open', opts);
  if (site !== cizSiteOf(fromUrl)) await cizSiteGate.risky(site, 'leave', opts);
}

// The page the chat window shows now: where a new tab "leaves" from.
async function cizWindowTabUrl() {
  const wid = cizSiteGate.windowId();
  try {
    const [t] = await browser.tabs.query(wid != null ? { active: true, windowId: wid } : { active: true, lastFocusedWindow: true });
    return (t && t.url) || '';
  } catch { return ''; }
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
    // Only the chat window's tabs, and a site outside the chat's list shows as id and site only (siteGate.tabView).
    const wid = cizSiteGate.windowId();
    const tabs = await browser.tabs.query(wid != null ? { windowId: wid } : { lastFocusedWindow: true });
    const opts = { trusted: !!cizState.get().trusted, blocks: (await cizSiteOpts({})).blocks };
    return tabs.map(t => {
      const view = cizSiteGate.tabView(t, opts);
      const army = view.url !== undefined && cizArmy.owner(t.id);   // a tab an army worker is using, so Claude leaves it to that worker
      return army ? Object.assign(view, { army: army.worker }) : view;
    });
  },

  async tab_open(args) {
    const url = String(args.url || '').trim();
    cizRefuseUrl(url, args.__army);
    // A worker's tab opens in the background, so it leaves nothing: the run's list (the 'open' check) is its only rule.
    await cizOpenCheck(url, args.__army ? url : await cizWindowTabUrl(), args);
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
    const tab = await cizPageTab(args, 'navigate');
    const word = want.toLowerCase();
    if (word === 'back') await browser.tabs.goBack(tab.id);
    else if (word === 'forward') await browser.tabs.goForward(tab.id);
    else if (word === 'reload') await browser.tabs.reload(tab.id);
    else { cizRefuseUrl(want, args.__army); await cizOpenCheck(want, tab.url, args); await browser.tabs.update(tab.id, { url: want }); }
    return cizWaitLoaded(tab.id, 30000);
  },

  async read_page(args) { return cizInPage(await cizPageTab(args, 'read_page'), 'read', args); },

  async get_page_text(args) {
    const tab = await cizPageTab(args, 'get_page_text');
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

  async analyze_page(args) { return cizInPage(await cizPageTab(args, 'analyze_page'), 'analyze', args); },
  async get_selection(args) { return cizInPage(await cizPageTab(args, 'get_selection'), 'selection', args); },
  async find(args) { return cizInPage(await cizPageTab(args, 'find'), 'find', args); },

  async click(args) {
    const tab = await cizPageTab(args, 'click');
    await cizRiskCheck(tab, args);
    return cizAfterAction(tab, () => cizInPage(tab, 'click', args));
  },
  async hover(args) { return cizInPage(await cizPageTab(args, 'hover'), 'hover', args); },
  async fill(args) { return cizInPage(await cizPageTab(args, 'fill'), 'fill', args); },
  async type_text(args) {
    const tab = await cizPageTab(args, 'type_text');
    if (args.submit) await cizRiskCheck(tab, args);
    return args.submit ? cizAfterAction(tab, () => cizInPage(tab, 'type', args)) : cizInPage(tab, 'type', args);
  },
  async press_key(args) {
    const tab = await cizPageTab(args, 'press_key');
    if (String(args.key) === 'Enter') await cizRiskCheck(tab, args);
    return String(args.key) === 'Enter' ? cizAfterAction(tab, () => cizInPage(tab, 'press', args)) : cizInPage(tab, 'press', args);
  },
  async scroll(args) { return cizInPage(await cizPageTab(args, 'scroll'), 'scroll', args); },
  async media(args) { return cizInPage(await cizPageTab(args, 'media'), 'media', args); },

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
      try { found = await cizInPage(await cizPageTab(args, 'wait_for'), 'exists', probe); }
      catch (e) { if (/Cannot use tab|No tab|selector|Army workers|did not allow|is blocked in your site list|Outside the sites|Workers cannot|No answer about|Zen keeps add-ons out/.test(e.message)) throw e; }
      if (found) return { found: true, waited_ms: Date.now() - t0 };
      if (Date.now() - t0 >= timeout) return { found: false, waited_ms: Date.now() - t0 };
      await cizSleep(250);
    }
  },

  async screenshot(args) {
    // Looking is allowed on more pages than acting: about: pages too (see cizViewBlocked).
    const { tab, gate } = await cizGatedTab(args, true, 'screenshot');
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
    const tab = await cizPageTab(args, 'network_log');
    return cizNetLog(tab.id, args);
  },
  async console_log(args) {
    return cizConsoleLog(await cizPageTab(args, 'console_log'), args);
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
