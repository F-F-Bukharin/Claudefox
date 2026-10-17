'use strict';
// The army: Haiku workers the lead Claude sends to work in their own background tabs. This file keeps which
// tab belongs to which worker, refuses calls a worker may not make, and keeps the user's own tab in front.
// The user's current tab must never change because of the army.

// What a worker may do. No tab switching, no tab list, no files, no debugging tools.
const CFX_ARMY_TOOLS = new Set(['navigate', 'get_page_text', 'read_page', 'find', 'analyze_page', 'scroll', 'wait_for',
  'click', 'hover', 'fill', 'type_text', 'press_key', 'screenshot', 'tab_open', 'tab_close']);

// An army tab that comes to the front this soon after a worker acted on it was brought there by the worker's
// page, not by the user, so the user's tab goes back in front.
const CFX_ARMY_FOCUS_MS = 3000;

// The tabs one worker may have at once: its first tab and 3 more (20 for a run of five). A tab a worker's page opens
// past that is closed at once (the helper's armyguard.js keeps the same count).
const CFX_ARMY_MAX_TABS = 4;

const cfxArmy = {
  tabs: new Map(),   // tabId -> { run, worker, at }   at = time of the last army action on it
  userTab: null,     // { tabId, windowId }: the last tab the user had in front that is not an army tab
  ended: new Set(),  // runs and "run/worker" pairs that are over: a tab of theirs that finishes opening late is closed
  stopAt: 0,         // when Stop (or the helper's end) closed every army tab: a tab that started opening before is closed
  shown: null,       // { tabId, until }: the user asked to see this worker's tab (Show in the panel), so it stays in front

  // Throws when a worker's call is refused; nothing runs then.
  check(tool, args, army) {
    if (!army || !army.run || !army.worker) throw new Error('Bad army call.');
    if (!CFX_ARMY_TOOLS.has(tool)) throw new Error(`Army workers can't use ${tool}.`);
    if (tool === 'tab_open') return;
    const id = args && args.tab_id;
    if (!Number.isInteger(id)) throw new Error('Army calls must name their tab.');
    const own = this.tabs.get(id);
    if (!own || own.run !== army.run || own.worker !== army.worker) throw new Error(`Tab ${id} is not this worker's tab.`);
  },

  // since: when the tab started opening (tab_open), so a Stop in between closes it too. False when the tab was closed
  // at once because its worker, its run or the whole army ended while it opened.
  register(tabId, army, since) {
    if (!Number.isInteger(tabId) || !army) return false;
    const run = String(army.run), worker = String(army.worker);
    if (this.ended.has(run) || this.ended.has(`${run}/${worker}`) || (since && since <= this.stopAt)) {
      browser.tabs.remove(tabId).catch(() => {});
      return false;
    }
    this.tabs.set(tabId, { run, worker, at: Date.now() });
    return true;
  },
  count(run, worker) {
    let n = 0;
    for (const t of this.tabs.values()) if (t.run === run && t.worker === worker) n++;
    return n;
  },
  // The user's own Show click in the panel: this switch to a worker's tab is theirs, so it is not undone.
  show(tabId) { if (this.tabs.has(tabId)) this.shown = { tabId, until: Date.now() + 3000 }; },
  unregister(tabId) { this.tabs.delete(tabId); },
  owner(tabId) { return this.tabs.get(tabId) || null; },
  touch(tabId) { const t = this.tabs.get(tabId); if (t) t.at = Date.now(); },

  // A worker finished (or the whole run did): close its tabs. The user's tabs are never in the registry.
  async closeRun(run, worker) {
    this.ended.add(worker ? `${run}/${worker}` : run);
    if (this.ended.size > 300) this.ended.delete(this.ended.values().next().value);
    const ids = [...this.tabs].filter(([, t]) => t.run === run && (!worker || t.worker === worker)).map(([id]) => id);
    return this._close(ids);
  },
  async closeAll() {
    this.stopAt = Date.now();
    return this._close([...this.tabs.keys()]);
  },
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
      const s = this.shown;
      if (s && s.tabId === info.tabId && Date.now() < s.until) { this.shown = null; return; }
      if (Date.now() - t.at < CFX_ARMY_FOCUS_MS) this._restore(info.windowId);
    });
    // A tab a worker's page opens (a link with target=_blank, a popup) belongs to that worker, up to its 4 tabs.
    browser.tabs.onCreated.addListener(tab => {
      const parent = tab && this.tabs.get(tab.openerTabId);
      if (!parent) return;
      if (this.count(parent.run, parent.worker) >= CFX_ARMY_MAX_TABS) browser.tabs.remove(tab.id).catch(() => {});
      else this.register(tab.id, parent);
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
