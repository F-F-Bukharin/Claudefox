'use strict';
// Army workers (lib/army.js): which tools a worker may use, in which tabs, and how much. Pure functions on a worker
// record, no I/O, so the rules can be checked on their own. The helper runs checkCall before it forwards a worker's
// call to the add-on and noteResult on the add-on's answer.

// The single list of tools a worker gets. The tool server (zen-mcp.js) publishes exactly these in worker mode.
const WORKER_TOOLS = ['navigate', 'get_page_text', 'read_page', 'find', 'analyze_page', 'scroll', 'wait_for', 'click', 'hover',
  'fill', 'type_text', 'press_key', 'screenshot', 'tab_open', 'tab_close'];

const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
// Each limit can be lowered for tests through its environment variable.
const LIMITS = {
  calls: num('CLAUDE_IN_ZEN_ARMY_CALLS', 40),        // tool calls per worker
  navs: num('CLAUDE_IN_ZEN_ARMY_NAVS', 6),           // page loads per worker (navigate and tab_open)
  pages: num('CLAUDE_IN_ZEN_ARMY_PAGES', 15),        // page loads per message: every worker of every run, first tabs too
  extraTabs: num('CLAUDE_IN_ZEN_ARMY_EXTRA_TABS', 3), // tabs a worker may have besides its first one (4 in all, 20 a run)
  softMs: num('CLAUDE_IN_ZEN_ARMY_SOFT_MS', 150000), // after this, tools refuse and the worker writes its report
  hardMs: num('CLAUDE_IN_ZEN_ARMY_HARD_MS', 180000), // after this, the worker is killed
  runMs: num('CLAUDE_IN_ZEN_ARMY_RUN_MS', 360000),   // the whole run
};

const BUDGET = 'Budget reached: stop using tools and write your report now.';
const ids = w => [...w.tabs].join(', ');

// True when the tab is one of this worker's own. Every tab rule rests on it.
function ownsTab(worker, id) {
  return worker.tabs.has(id);
}

// '' while the worker may load another page, else why not. worker.budget is shared by every worker of the message.
function pageLoadsLeft(worker) {
  if (worker.navs >= LIMITS.navs) return `You have loaded ${worker.navs} pages, the most allowed for one worker. Write your report.`;
  if (worker.budget && worker.budget.pages >= LIMITS.pages) return `The army has loaded ${worker.budget.pages} pages for this message, the most allowed. Write your report with what you have.`;
  return '';
}

// { ok: true, args } with the arguments to forward, or { ok: false, error } for the worker. Counts accepted calls.
function checkCall(worker, tool, args, now) {
  if (tool === 'tab_activate') return { ok: false, error: 'Workers never bring a tab to the front.' };
  if (!WORKER_TOOLS.includes(tool)) return { ok: false, error: `Workers can't use ${tool}. Work with the tools you have.` };
  if (worker.ended) return { ok: false, error: 'This worker was stopped. Do not use any more tools.' };
  if (worker.calls >= LIMITS.calls || now - worker.started > LIMITS.softMs) return { ok: false, error: BUDGET };
  const a = Object.assign({}, args && typeof args === 'object' ? args : {});
  let nav = false;

  if (tool === 'tab_open') {
    if (!String(a.url || '').trim()) return { ok: false, error: 'Give the url to open.' };
    if (worker.extra >= LIMITS.extraTabs || worker.tabs.size >= 1 + LIMITS.extraTabs) {
      return { ok: false, error: `You already have ${worker.tabs.size} tabs, the most allowed. Use one of yours: ${ids(worker)}.` };
    }
    const full = pageLoadsLeft(worker);
    if (full) return { ok: false, error: full };
    a.active = false;   // worker tabs always open in the background
    delete a.tab_id;
    nav = true;
  } else if (tool === 'tab_close') {
    const id = Number(a.tab_id);
    if (a.tab_id == null || !Number.isFinite(id)) return { ok: false, error: 'Give the tab_id of one of your tabs to close.' };
    if (!ownsTab(worker, id)) return { ok: false, error: `Tab ${id} is not one of your tabs (yours: ${ids(worker)}). Work only in your own tabs.` };
    if (id === worker.mainTab) return { ok: false, error: `Tab ${id} is your first tab: keep it open.` };
    a.tab_id = id;
  } else {
    const id = a.tab_id == null || a.tab_id === '' ? worker.mainTab : Number(a.tab_id);
    if (!ownsTab(worker, id)) return { ok: false, error: `Tab ${a.tab_id} is not one of your tabs (yours: ${ids(worker)}). Work only in your own tabs.` };
    a.tab_id = id;
    if (tool === 'navigate') {
      const full = pageLoadsLeft(worker);
      if (full) return { ok: false, error: full };
      nav = true;
    }
  }
  worker.calls++;
  if (nav) {
    worker.navs++;
    if (worker.budget) worker.budget.pages++;
  }
  return { ok: true, args: a };
}

function hostOf(url) {
  try { const u = new URL(String(url)); return /^https?:$/.test(u.protocol) ? u.hostname : ''; } catch { return ''; }
}

function addSource(worker, url) {
  if (!hostOf(url) || worker.sources.includes(url) || worker.sources.length >= 8) return;
  worker.sources.push(String(url));
}

const LABELS = {
  navigate: 'Opening', get_page_text: 'Reading the page', read_page: 'Looking at the page', find: 'Looking for a control',
  analyze_page: 'Looking at the page', scroll: 'Scrolling', wait_for: 'Waiting for the page', click: 'Clicking', hover: 'Pointing',
  fill: 'Filling a field', type_text: 'Typing', press_key: 'Pressing a key', screenshot: 'Taking a screenshot',
  tab_open: 'Opening a tab', tab_close: 'Closing a tab',
};

// Updates the worker after the add-on answered: its tabs, its sources, its step count and its action for the trail.
function noteResult(worker, tool, args, res) {
  const a = args || {};
  const r = res && res.ok && res.result && typeof res.result === 'object' ? res.result : null;
  worker.urls = worker.urls || {};
  if (r) {
    if (tool === 'tab_open' && Number.isFinite(Number(r.tab_id))) {
      worker.tabs.add(Number(r.tab_id));
      worker.extra++;
      worker.urls[Number(r.tab_id)] = r.url || a.url;
    }
    // The page opened a tab of its own (a link with target=_blank): it belongs to the worker too, while the worker has
    // fewer than 4 tabs. Past that the add-on closes it at once (extension/lib/army.js).
    if ((tool === 'click' || tool === 'press_key' || tool === 'type_text') && r.opened_tab && Number.isFinite(Number(r.opened_tab.tab_id))
      && worker.tabs.size < 1 + LIMITS.extraTabs) {
      worker.tabs.add(Number(r.opened_tab.tab_id));
      worker.urls[Number(r.opened_tab.tab_id)] = r.opened_tab.url || '';
    }
    if (tool === 'tab_close') worker.tabs.delete(Number(a.tab_id));
    if ((tool === 'navigate' || tool === 'tab_open' || tool === 'get_page_text') && r.url) addSource(worker, r.url);
    if (r.url && a.tab_id != null && tool !== 'tab_open') worker.urls[Number(a.tab_id)] = r.url;
  }
  worker.steps++;
  const tab = tool === 'tab_open' && r ? Number(r.tab_id) : Number(a.tab_id);
  const host = hostOf((r && r.url) || worker.urls[tab] || (tool === 'tab_open' ? a.url : ''));
  if (host) worker.host = host;
  const label = LABELS[tool] || tool;
  worker.action = tool === 'tab_close' || !host ? label : `${label}: ${host}`;
}

module.exports = { WORKER_TOOLS, LIMITS, checkCall, noteResult, ownsTab, hostOf };
