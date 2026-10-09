'use strict';
// Session state. Lives in storage.session only, so quitting Zen wipes it:
// sign-in is required again on every launch (plan section 4).

const CIZ_DEFAULT_STATE = Object.freeze({
  agent: 'active',            // 'active' | 'stopped'
  signedIn: false,
  account: null,              // { email, name, uuid, via }
  signedInAt: null,
  filesEnabled: false,        // Stop always forces it off
  filesMode: 'read',          // 'read' | 'write' when file tools are on
  filesFolder: '',            // the one folder file tools may use
  switching: false,           // account switch in progress (sign-in window open)
  chatModel: 'speed',         // 'speed' (Haiku 5.5, high effort) | 'quality' (Opus 5.5, high effort)
  chatSession: '',            // Claude Code session id, so follow-ups keep the conversation
  native: 'unknown',          // 'unknown' | 'connected' | 'missing' | 'error'
  nativeDetail: '',
  hostVersion: '',
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
    this._cache = Object.assign({}, CIZ_DEFAULT_STATE, got.state || {});
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
