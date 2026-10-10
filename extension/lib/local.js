'use strict';
// Local pages and files: Claude may look at a page or file on this computer only after the user allows its folder.
// The panel asks ("Allow this folder" or "Deny"); a yes covers the folder and its subfolders until the user removes
// it in Profile > Permissions. Army workers never get here: lib/tools.js refuses them on every non-web page first.

const CIZ_FILE_ACCESS_OFF = "Zen keeps add-ons out of files on this computer. Turn on 'Access local files on your computer' for Claude in Zen: about:addons -> Claude in Zen -> Permissions and data.";

const cizLocal = {
  ASK_MS: 120000,   // how long a question waits for the user (tests lower it)
  TAB_MS: 10000,    // how long local_tab waits for Zen to show the file (tests lower it)
  _asks: [],        // open questions, the first one shown: { id, folder, waiters, timer }
  _seq: 0,

  async init() {
    let saved = [];
    try { saved = (await browser.storage.local.get('localGrants')).localGrants; } catch {}
    const list = [];
    for (const f of Array.isArray(saved) ? saved : []) {
      const n = cizNormFolder(f);
      if (n && !list.some(g => cizSamePath(g, n))) list.push(n);
    }
    await cizState.set({ localGrants: list, grantAsk: null });   // a question from before a reload has no one waiting
    await this.fileAccess();
  },

  grants() { return (cizState.get().localGrants || []).slice(); },
  granted(folder) { return this.grants().some(g => cizInFolder(folder, g)); },

  async ensure(folder) { return (await this.ask(folder)).ok; },

  // Resolves { ok } or { ok: false, error } with the text Claude sees. A second ask for the same folder joins the open one.
  ask(folder) {
    const f = cizNormFolder(folder);
    if (!f) return Promise.resolve({ ok: false, error: 'That is not a full folder path on this computer.' });
    if (this.granted(f)) return Promise.resolve({ ok: true });
    return new Promise(resolve => {
      let a = this._asks.find(x => cizSamePath(x.folder, f));
      if (!a) {
        // The wait counts from the question, not from when it shows, so every caller hears back in ASK_MS.
        a = { id: 'g' + (++this._seq), folder: f, waiters: [] };
        a.timer = setTimeout(() => {
          cizState.addLog('info', `No answer about ${f}: Claude did not look.`);
          this._end(a, { ok: false, error: `No answer about ${f}, so Claude did not look.` });
        }, this.ASK_MS);
        this._asks.push(a);
        cizState.addLog('info', `Claude asks to look in ${f}. Answer in the panel.`);
      }
      a.waiters.push(resolve);
      this._show();
    });
  },

  answer(id, allow) {
    const a = this._asks.find(x => x.id === String(id));
    if (!a) return;
    // cizState.set changes the list at once (storage follows), so _end sees the new grant for queued questions.
    const saved = allow ? this._add(a.folder) : null;
    this._end(a, allow ? { ok: true } : { ok: false, error: `You did not allow Claude to look in ${a.folder}.` });
    return Promise.all([saved, cizState.addLog('info', allow ? `Allowed Claude to look in ${a.folder} and its subfolders.` : `Did not allow Claude to look in ${a.folder}.`)]);
  },

  async remove(folder) {
    const before = this.grants();
    const list = before.filter(g => !cizSamePath(g, folder));
    if (list.length === before.length) return;
    await cizState.set({ localGrants: list });
    try { await browser.storage.local.set({ localGrants: list }); } catch {}
    await cizState.addLog('info', `Removed ${cizNormFolder(folder)}: Claude asks again before looking there.`);
  },

  // Stop: every open or waiting question counts as no.
  cancelAll() {
    for (const a of this._asks.slice()) this._settle(a, { ok: false, error: `You did not allow Claude to look in ${a.folder}.` });
    return cizState.set({ grantAsk: null });
  },

  // 'yes' | 'no' | 'unknown'. From Gecko 153 the add-on has its own "Access local files" switch, off by default, and
  // the API reports it. Before 153 there is no switch and the API always says false although access works.
  async fileAccess() {
    const ua = typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '';
    const m = /Firefox\/(\d+)/.exec(ua);
    const gecko = m ? Number(m[1]) : 0;
    let v = 'unknown';
    if (gecko && gecko < 153) v = 'yes';
    else {
      let allowed = null;
      try { allowed = await browser.extension.isAllowedFileSchemeAccess(); } catch {}
      if (allowed === true) v = 'yes';
      else if (allowed === false && gecko) v = 'no';   // with no version to go by, a false may be the old wrong answer
    }
    if (cizState.get().fileAccess !== v) await cizState.set({ fileAccess: v });
    return v;
  },

  // The tab that shows a file: URL (the helper opened it with zen.exe -new-tab). Paths are compared decoded, Windows
  // ones without case. The newest such tab wins; it waits for the page to load until TAB_MS.
  async findTab(url) {
    const want = cizFilePath(url);
    if (!want) return { ok: false, error: 'That is not a file: URL on this computer.' };
    const end = Date.now() + this.TAB_MS;
    let hit = null;
    for (;;) {
      let tabs = [];
      try { tabs = await browser.tabs.query({}); } catch {}
      const found = tabs.filter(t => { const p = cizFilePath(t.url || ''); return p && cizSamePath(p, want); }).sort((x, y) => y.id - x.id)[0];
      if (found) hit = found;
      if ((hit && hit.status === 'complete') || Date.now() >= end) break;
      await new Promise(r => setTimeout(r, 200));
    }
    return hit ? { ok: true, tab_id: hit.id, title: hit.title || '' }
      : { ok: false, error: `No Zen tab showed ${want} within ${Math.max(1, Math.round(this.TAB_MS / 1000))} s.` };
  },

  _add(folder) {
    const list = this.grants();
    if (!list.some(g => cizInFolder(folder, g))) list.push(folder);
    return Promise.all([cizState.set({ localGrants: list }), browser.storage.local.set({ localGrants: list }).catch(() => {})]);
  },

  _settle(a, result) {
    const i = this._asks.indexOf(a);
    if (i < 0) return;
    clearTimeout(a.timer);
    this._asks.splice(i, 1);
    for (const w of a.waiters) w(result);
  },

  // A question is over: answer the queued ones a new grant now covers, then show the next.
  _end(a, result) {
    this._settle(a, result);
    for (const b of this._asks.slice()) if (this.granted(b.folder)) this._settle(b, { ok: true });
    this._show();
  },

  _show() {
    const a = this._asks[0];
    const want = a ? { id: a.id, folder: a.folder } : null;
    const cur = cizState.get().grantAsk;
    if ((cur && cur.id) !== (want && want.id)) cizState.set({ grantAsk: want }).catch(() => {});
  },
};
