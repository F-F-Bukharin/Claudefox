'use strict';
// Local pages and files: Claude may look at a page or file on this computer only inside a folder the user allowed.
// The helper keeps the allowed folders and asks about a new one in its own confirm window ("Allow this folder" or
// "Deny"), outside Zen, which nothing in the add-on or the panel can answer for the user, a mod included. This file
// keeps the helper's list for the page tools' file: gate (lib/tools.js), asks the helper when a file: tab is outside
// it, and tells the panel while the window is open. Army workers never get here: lib/tools.js refuses them on every
// non-web page first.

const CIZ_FILE_ACCESS_OFF = "Zen keeps add-ons out of files on this computer. Turn on 'Access local files on your computer' for Claudefox: about:addons -> Claudefox -> Permissions and data.";

const cizLocal = {
  ASK_MS: 150000,   // how long a question waits (the helper's window gives the user 120 s; tests lower it)
  TAB_MS: 10000,    // how long local_tab waits for Zen to show the file (tests lower it)
  _asks: new Map(), // questions sent to the helper: id -> { folder, waiters, timer }
  _seq: 0,

  async init() {
    try { await browser.storage.local.remove('localGrants'); } catch {}   // the helper keeps the list now
    await cizState.set({ localGrants: [], grantAsk: null });
    await this.fileAccess();
  },

  grants() { return (cizState.get().localGrants || []).slice(); },
  granted(folder) { return this.grants().some(g => cizInFolder(folder, g)); },

  // The helper's list, sent when it connects and whenever it changes.
  setGrants(list) {
    const out = [];
    for (const f of Array.isArray(list) ? list : []) {
      const n = cizNormFolder(f);
      if (n && !out.some(g => cizSamePath(g, n))) out.push(n);
    }
    return cizState.set({ localGrants: out });
  },

  // The helper's window is asking about this folder ('' once it is answered): the panel says so.
  setQuestion(folder) {
    const f = cizNormFolder(folder);
    return cizState.set({ grantAsk: f ? { folder: f } : null });
  },

  // A file: tab outside the allowed folders: the helper asks the user. Resolves { ok } or { ok: false, error } with the
  // text Claude sees. A second ask for the same folder joins the open one.
  ask(folder) {
    const f = cizNormFolder(folder);
    if (!f) return Promise.resolve({ ok: false, error: 'That is not a full folder path on this computer.' });
    if (this.granted(f)) return Promise.resolve({ ok: true });
    for (const a of this._asks.values()) if (cizSamePath(a.folder, f)) return new Promise(r => a.waiters.push(r));
    return new Promise(resolve => {
      const id = 'l' + (++this._seq);
      const a = { folder: f, waiters: [resolve] };
      a.timer = setTimeout(() => this._settle(id, { ok: false, error: `No answer about ${f}, so Claude did not look.` }), this.ASK_MS);
      this._asks.set(id, a);
      cizState.addLog('info', `Claude asks to look in ${f}. Answer in the Claudefox window.`);
      if (!sendNative({ type: 'local_ask', id, folder: f })) this._settle(id, { ok: false, error: 'The helper is not connected, so nobody can allow that folder now.' });
    });
  },

  // The helper's answer to local_ask.
  answer(id, msg) {
    const a = this._asks.get(String(id));
    if (!a) return;
    this._settle(String(id), msg && msg.ok ? { ok: true } : { ok: false, error: String((msg && msg.error) || `You did not allow Claude to look in ${a.folder}.`).slice(0, 400) });
  },

  // Profile, Permissions: Remove. The helper forgets the folder and sends the new list.
  remove(folder) {
    const f = cizNormFolder(folder);
    if (!f) return;
    if (!sendNative({ type: 'local_grant_remove', folder: f })) return cizState.addLog('error', 'Removing a folder needs the helper. Press Start, then try again.');
    return cizState.addLog('info', `Removed ${f}: Claude asks again before looking there.`);
  },

  // Stop, or the helper went away: every open question counts as no.
  cancelAll() {
    for (const id of [...this._asks.keys()]) this._settle(id, { ok: false, error: 'Stopped, so Claude did not look.' });
    return cizState.set({ grantAsk: null });
  },

  _settle(id, result) {
    const a = this._asks.get(id);
    if (!a) return;
    clearTimeout(a.timer);
    this._asks.delete(id);
    for (const w of a.waiters) w(result);
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
      : { ok: false, error: `No Firefox tab showed ${want} within ${Math.max(1, Math.round(this.TAB_MS / 1000))} s.` };
  },
};
