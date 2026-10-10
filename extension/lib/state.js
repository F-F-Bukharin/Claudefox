'use strict';
// Session state. Lives in storage.session, so quitting Zen wipes it. Sign-in comes back on its own at
// startup from a remembered marker in storage.local (see background.js, "Remembered sign-in").

const CIZ_DEFAULT_STATE = Object.freeze({
  mods: [],                   // from the helper: { id, name, description, panel, style, enabled, broken }
  modsKnown: false,           // true once the helper has listed the mods folder; the panel loads the on mods then, once
  agent: 'active',            // 'active' | 'stopped'
  signedIn: false,
  account: null,              // { email, name, uuid, via }
  signedInAt: null,
  filesEnabled: false,        // Stop always forces it off
  filesMode: 'read',          // 'read' | 'write' when file tools are on
  filesFolder: '',            // the one folder file tools may use
  unsafe: false,              // Unsafe mode: Claude may act on Google sign-in pages. Session only (load() clears it)
  accounts: [],               // chat accounts from the helper: { id, email, plan, loggedIn, active }
  accountLogin: null,         // { id, isNew } while a sign-in window is open
  accountBusy: '',            // the account id whose switch is waiting for the helper
  accountNote: null,          // { ok, text } about the last switch, shown in Profile
  folderPicking: false,       // a folder window is open (Choose folder)
  chatModel: 'speed',          // 'speed' (Haiku 5.5, high effort) | 'quality' (Opus 5.5, high effort)
  chatPlus: false,            // Speed Plus: Haiku 5.5 at max effort (only applies in Speed)
  caveman: false,             // Caveman mode: short replies (the + menu). Remembered across restarts (storage.local)
  outputMode: 'download',     // Files: 'download' (Downloads, as before) or 'store' (the output folder beside the mods folder). Remembered across restarts (storage.local)
  tools: null,                // Settings > Tools and plugins, as the helper last reported it
  toolLogin: null,            // { name, label } while a tool's sign-in window is open
  chatSession: '',            // Claude Code session id, so follow-ups keep the conversation
  native: 'unknown',          // 'unknown' | 'connected' | 'missing' | 'error'
  nativeDetail: '',
  hostVersion: '',
  sourceVersion: '',          // add-on version in the project folder the helper runs from
  canUpdate: false,           // the helper can rebuild and reinstall the add-on (source present)
  updating: false,
  updateNote: '',             // what the last update did, shown under the Add-on row
  linked: false,              // Zen loads the add-on straight from the project folder (link.ps1)
  clients: [],                // names of local clients connected through the helper
  claude: null,               // { installed, loggedIn, email, plan, checkedAt } from the helper
  debugPort: 'unknown',       // 'unknown' | 'off' | 'on'
  pending: 0,
});

const cizState = {
  _cache: null,
  _listeners: new Set(),

  async load() {
    const got = await browser.storage.session.get(['state', 'log']);
    this._cache = Object.assign({}, CIZ_DEFAULT_STATE, got.state || {}, { unsafe: false });   // never survives a restart
    this._log = Array.isArray(got.log) ? got.log : [];
    return this._cache;
  },

  get() { return Object.assign({}, this._cache); },
  log() { return this._log.slice(); },

  async set(patch) {
    Object.assign(this._cache, patch);
    await browser.storage.session.set({ state: this._cache });
    this._emit();
  },

  async addLog(kind, text) {
    this._log.push({ t: Date.now(), kind, text: String(text).slice(0, 500) });
    if (this._log.length > CIZ.LOG_LIMIT) this._log.splice(0, this._log.length - CIZ.LOG_LIMIT);
    await browser.storage.session.set({ log: this._log });
    this._emit();
  },

  async clearLog() {
    this._log = [];
    await browser.storage.session.set({ log: [] });
    this._emit();
  },

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); },
  _emit() { for (const fn of this._listeners) { try { fn(this.get(), this.log()); } catch {} } },
};
