'use strict';
// The army: Haiku workers the lead Claude sends to work in their own background tabs. This file keeps which
// tab belongs to which worker, refuses calls a worker may not make, and keeps the user's own tab in front.
// The user's current tab must never change because of the army.

// What a worker may do. No tab switching, no tab list, no files, no debugging tools.
const CIZ_ARMY_TOOLS = new Set(['navigate', 'get_page_text', 'read_page', 'find', 'analyze_page', 'scroll', 'wait_for',
  'click', 'hover', 'fill', 'type_text', 'press_key', 'screenshot', 'tab_open', 'tab_close']);

// An army tab that comes to the front this soon after a worker acted on it was brought there by the worker's
// page, not by the user, so the user's tab goes back in front.
const CIZ_ARMY_FOCUS_MS = 3000;

const cizArmy = {
  tabs: new Map(),   // tabId -> { run, worker, at }   at = time of the last army action on it
  userTab: null,     // { tabId, windowId }: the last tab the user had in front that is not an army tab

  // Throws when a worker's call is refused; nothing runs then.
  check(tool, args, army) {
    if (!army || !army.run || !army.worker) throw new Error('Bad army call.');
    if (!CIZ_ARMY_TOOLS.has(tool)) throw new Error(`Army workers can't use ${tool}.`);
    if (tool === 'tab_open') return;
    const id = args && args.tab_id;
    if (!Number.isInteger(id)) throw new Error('Army calls must name their tab.');
    const own = this.tabs.get(id);
    if (!own || own.run !== army.run || own.worker !== army.worker) throw new Error(`Tab ${id} is not this worker's tab.`);
  },

  register(tabId, army) {
    if (!Number.isInteger(tabId) || !army) return;
    this.tabs.set(tabId, { run: String(army.run), worker: String(army.worker), at: Date.now() });
  },
  unregister(tabId) { this.tabs.delete(tabId); },
  owner(tabId) { return this.tabs.get(tabId) || null; },
  touch(tabId) { const t = this.tabs.get(tabId); if (t) t.at = Date.now(); },

  // A worker finished (or the whole run did): close its tabs. The user's tabs are never in the registry.
  async closeRun(run, worker) {
    const ids = [...this.tabs].filter(([, t]) => t.run === run && (!worker || t.worker === worker)).map(([id]) => id);
    return this._close(ids);
  },
  async closeAll() { return this._close([...this.tabs.keys()]); },
  async _close(ids) {
    for (const id of ids) this.tabs.delete(id);
    if (!ids.length) return 0;
    try { await browser.tabs.remove(ids); } catch {
      for (const id of ids) { try { await browser.tabs.remove(id); } catch {} }   // one was gone already: close the rest
    }
    return ids.length;
  },

  // The one place army code changes the active tab: the user's own tab goes back in front.
  _restore(windowId) {
    const u = this.userTab;
    if (!u || u.windowId !== windowId) return;
    browser.tabs.update(u.tabId, { active: true }).catch(() => {});
  },

  install() {
    browser.tabs.onActivated.addListener(info => {
      const t = this.tabs.get(info.tabId);
      if (!t) { this.userTab = { tabId: info.tabId, windowId: info.windowId }; return; }
      if (Date.now() - t.at < CIZ_ARMY_FOCUS_MS) this._restore(info.windowId);
    });
    // A tab a worker's page opens (a link with target=_blank, a popup) belongs to that worker.
    browser.tabs.onCreated.addListener(tab => {
      const parent = tab && this.tabs.get(tab.openerTabId);
      if (!parent) return;
      this.register(tab.id, parent);
      if (tab.active) this._restore(tab.windowId);
    });
    browser.tabs.onRemoved.addListener(tabId => {
      this.tabs.delete(tabId);
      if (this.userTab && this.userTab.tabId === tabId) this.userTab = null;
    });
    browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => {
      if (t && !this.userTab && !this.tabs.has(t.id)) this.userTab = { tabId: t.id, windowId: t.windowId };
    }).catch(() => {});
  },
};
