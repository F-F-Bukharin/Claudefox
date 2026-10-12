// The site gate (page safety, A1): which sites Claude may read, act on or open in this chat, and the card that asks when it is
// outside them. Plain browser script (no modules); loaded in the background scripts before lib/pageTools.js.
// This file is the logic only; pageTools.js, bg-router.js, bg-chat.js and army.js call it.
//
// Sites
//   cizSiteOf(url)            -> lowercase host of an http(s) URL without one leading "www." and one trailing dot; IPv4, [IPv6] and
//                                localhost as they are; '' for anything else.
//   cizSiteMatch(list, site)  -> true when an entry equals site or site ends with "." + entry. IPs, [IPv6] and localhost: exact only.
//   cizSitesInText(text)      -> sites of http(s) URLs in the text plus bare domains (.com .net .org ... .br); no email domains,
//                                lowercase, no www., no duplicates.
//
// cizSiteGate (one object; a message is one chat turn)
//   begin(id, { tabUrl, windowId, text, newChat, allow }) -> string[]   starts a message. newChat clears the chat list. The message
//        list is the site of tabUrl plus cizSitesInText(text); allow is the sites marked "allow" in storage `sites`.
//        Returns the effective list (allow + chat + message, no duplicates).
//   end(id)            ends the message: its list, its denials and the page-read flag go. An end() for another id than the
//                      running message is ignored. Outside a turn the message scope lives until the next begin().
//   list() -> string[]   the effective list now.       windowId() -> number|null   the window the message started in.
//   onChange = fn(list)  set by the wiring; called whenever the effective list changes (after a "message" or "chat" answer).
//   async use(site, action, opts)   action 'read'|'act'|'open'; opts { trusted, blocks: {site:'allow'|'block'}, army: {run, worker} }.
//        Resolves when allowed, throws Error(fixed text) when not. Order: a blocked entry (or a subdomain of one) -> blocked text,
//        always; trusted -> allowed; army -> only the run's list (the effective list at the run's FIRST call), never a card; in the
//        list or an allow entry in blocks -> allowed; denied earlier in this message -> refused text; else a card.
//   async risky(site, action, opts)  action 'post'|'leave'; same blocks/trusted; army -> the workers text; page not read in this
//        message -> allowed; else a kind 'risky' card (answers allow/deny). Denials are kept under action+site for the message.
//   begin(id, { scheduled: [sites] })  a scheduled macro's turn (E8): use() allows exactly those sites and refuses the rest with
//        "Outside this scheduled macro's sites: <site>.", no card, Trusted or not; risky() allows. The chat's own lists are untouched.
//   markRead() / isRead()   the message has (not) read page content.
//   tabView(tab, { trusted, blocks }) -> { id, site, active } for a blocked site or (not trusted) a site outside the list,
//        else { id, windowId, active, title, url, audible }.
//   The card: cizState.set({ siteAsk: { id, site, action, kind } }), kind 'site' (answers message|chat|deny) or 'risky'
//        (allow|deny). The panel calls shown(id) when the card is on screen (waits SHOWN_MS), then answer(id, choice) (ANSWER_MS);
//        no shown or no answer -> refused (and remembered like a Deny). One card at a time; a call for the same site and kind
//        joins the open card; others queue and are re-checked when their turn comes. siteAsk goes back to null when a card ends.
//   shown(id), answer(id, choice), cancel()   cancel refuses the open card and everything queued (Stop, helper gone).
//   SHOWN_MS = 5000, ANSWER_MS = 120000   setTimeout/clearTimeout are looked up at call time.

function cizSiteOf(url) {
  const m = /^https?:\/\/([^\/?#\s]*)/i.exec(String(url == null ? '' : url).trim());
  if (!m) return '';
  let h = m[1].slice(m[1].lastIndexOf('@') + 1).toLowerCase();
  if (h.charAt(0) === '[') {
    const end = h.indexOf(']');
    return end < 0 ? '' : h.slice(0, end + 1);
  }
  h = h.replace(/:\d*$/, '').replace(/\.$/, '').replace(/^www\./, '');
  return /^[a-z0-9._-]+$/.test(h) ? h : '';
}

function cizSiteMatch(list, site) {
  if (!site || !list) return false;
  const exact = site.charAt(0) === '[' || site === 'localhost' || /^\d+(\.\d+){3}$/.test(site);
  for (let i = 0; i < list.length; i++) {
    const e = String(list[i] || '').toLowerCase();
    if (!e) continue;
    if (e === site || (!exact && site.length > e.length && site.slice(-(e.length + 1)) === '.' + e)) return true;
  }
  return false;
}

const CIZ_BARE_DOMAIN = /(^|[^\w@.\-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|edu|gov|io|dev|app|ai|co|me|tv|info|br|pt|uk|us|de|fr|es|it))(?![\w@-]|\.\w)/gi;

function cizSitesInText(text) {
  let s = String(text == null ? '' : text);
  const out = [];
  const add = site => { if (site && out.indexOf(site) < 0) out.push(site); };
  s = s.replace(/(https?:\/\/(?:\[[^\]\s]*\]|[\w.\-@:]+))[^\s]*/gi, (all, head) => { add(cizSiteOf(head)); return ' '; });
  let m;
  CIZ_BARE_DOMAIN.lastIndex = 0;
  while ((m = CIZ_BARE_DOMAIN.exec(s))) add(cizSiteOf('http://' + m[2]));
  return out;
}

const cizSiteGate = (() => {
  const SHOWN_MS = 5000, ANSWER_MS = 120000;
  let allowed = [], chat = [], msg = [], denied = {}, pageRead = false, winId = null, curId = null;
  let sched = null;   // a scheduled macro's turn (E8): only these sites, no cards
  let pending = [];   // sites that menu items named (addNext), taken by the next begin()
  let seq = 0, open = null, queue = [];
  const runs = {};

  const push = (arr, site) => { if (site && arr.indexOf(site) < 0) arr.push(site); };
  const refusedText = site => `The user did not allow ${site}. Do not try it again in this message.`;
  const dedupe = arr => { const out = []; arr.forEach(s => push(out, s)); return out; };
  const list = () => (sched ? sched.slice() : dedupe(allowed.concat(chat, msg)));
  const entryOf = (blocks, value, site) => !!blocks && Object.keys(blocks).some(k => blocks[k] === value && cizSiteMatch([k], site));
  const isBlocked = (blocks, site) => entryOf(blocks, 'block', site);
  const setState = patch => { try { Promise.resolve(cizState.set(patch)).catch(() => {}); } catch (e) { /* the state is gone with the page */ } };
  const changed = () => { if (typeof gate.onChange === 'function') { try { gate.onChange(list()); } catch (e) { /* the wiring's problem */ } } };
  const startTimer = (fn, ms) => setTimeout(fn, ms);
  const stopTimer = t => { if (t != null && typeof clearTimeout === 'function') clearTimeout(t); };

  // The checks never wait: 'ok' lets the call through, 'ask' needs a card, a refusal throws.
  function checkUse(site, opts) {
    const o = opts || {};
    if (isBlocked(o.blocks, site)) throw new Error(`${site} is blocked in your site list.`);
    if (sched) {   // a scheduled macro: its own sites only, never a card, Trusted does not widen it
      if (cizSiteMatch(sched, site)) return 'ok';
      throw new Error(`Outside this scheduled macro's sites: ${site}.`);
    }
    if (o.trusted) return 'ok';
    if (o.army) {
      const run = String(o.army.run);
      if (!runs[run]) runs[run] = list();
      if (cizSiteMatch(runs[run], site)) return 'ok';
      throw new Error(`Outside the sites the lead may use: ${site}.`);
    }
    if (cizSiteMatch(list(), site) || entryOf(o.blocks, 'allow', site)) return 'ok';
    if (denied['site:' + site]) throw new Error(refusedText(site));
    return 'ask';
  }
  function checkRisky(site, action, opts) {
    const o = opts || {};
    if (isBlocked(o.blocks, site)) throw new Error(`${site} is blocked in your site list.`);
    if (sched) return 'ok';   // the sites were checked by use()
    if (o.trusted) return 'ok';
    if (o.army) throw new Error('Workers cannot submit forms or leave the site; report back to the lead.');
    if (!pageRead) return 'ok';
    if (denied[action + ':' + site]) throw new Error(refusedText(site));
    return 'ask';
  }

  // One card at a time. An entry is one card (site + kind, plus the action for risky) and the calls waiting on it.
  function ask(site, action, kind, check) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, check };
      const same = e => e.site === site && e.kind === kind && (kind === 'site' || e.action === action);
      const hit = (open && same(open) ? open : null) || queue.filter(same)[0];
      if (hit) { hit.waiters.push(w); return; }
      queue.push({ id: 'site-' + (++seq), site, action, kind, waiters: [w], shown: false, shownTimer: null, answerTimer: null });
      pump();
    });
  }
  function pump() {
    while (!open && queue.length) {
      const e = queue.shift();
      // An earlier answer may cover a queued call: let it re-check instead of asking.
      e.waiters = e.waiters.filter(w => {
        let again = true;
        try { again = w.check() === 'ask'; } catch (err) { again = false; }
        if (!again) w.resolve('recheck');
        return again;
      });
      if (!e.waiters.length) continue;
      open = e;
      setState({ siteAsk: { id: e.id, site: e.site, action: e.action, kind: e.kind } });
      e.shownTimer = startTimer(() => finish(e, 'timeout'), SHOWN_MS);
    }
  }
  // How a card ends: 'timeout' and the answers refuse or allow; 'cancel' rejects the waiting calls.
  function finish(e, how) {
    if (open !== e) return;
    stopTimer(e.shownTimer); stopTimer(e.answerTimer);
    open = null;
    setState({ siteAsk: null });
    let grew = false;
    if (how === 'message') { grew = msg.indexOf(e.site) < 0; push(msg, e.site); }
    else if (how === 'chat') { grew = chat.indexOf(e.site) < 0 && msg.indexOf(e.site) < 0; push(chat, e.site); }
    else if (how === 'deny' || how === 'timeout') denied[(e.kind === 'site' ? 'site' : e.action) + ':' + e.site] = true;
    const ws = e.waiters; e.waiters = [];
    ws.forEach(w => (how === 'cancel' ? w.reject(new Error(refusedText(e.site))) : w.resolve(how === 'allow' ? 'allowed' : 'recheck')));
    if (grew) changed();
    pump();
  }

  async function run(site, action, kind, check) {
    for (;;) {
      if (check() === 'ok') return;
      if (await ask(site, action, kind, check) === 'allowed') return;
    }
  }

  const gate = {
    SHOWN_MS, ANSWER_MS, onChange: null,
    addNext(site) { push(pending, String(site || '').toLowerCase()); },
    begin(id, o) {
      const x = o || {};
      curId = id == null ? null : id;
      if (Array.isArray(x.scheduled)) {   // scheduled: { scheduled: [sites] } leaves the chat's own list alone
        sched = dedupe(x.scheduled.map(s => String(s).toLowerCase()));
        msg = []; denied = {}; pageRead = false; winId = null;
        return list();
      }
      sched = null;
      if (x.newChat) chat = [];
      pending.forEach(s => push(chat, s)); pending = [];
      allowed = dedupe((x.allow || []).map(s => String(s).toLowerCase()));
      msg = []; denied = {}; pageRead = false;
      winId = typeof x.windowId === 'number' ? x.windowId : null;
      push(msg, cizSiteOf(x.tabUrl));
      cizSitesInText(x.text).forEach(s => push(msg, s));
      return list();
    },
    end(id) {
      if (id != null && curId != null && id !== curId) return;
      msg = []; denied = {}; pageRead = false; curId = null; sched = null;
    },
    list, windowId: () => winId,
    use(site, action, opts) { return run(site, action, 'site', () => checkUse(site, opts)); },
    risky(site, action, opts) { return run(site, action, 'risky', () => checkRisky(site, action, opts)); },
    markRead() { pageRead = true; },
    isRead: () => pageRead,
    tabView(tab, opts) {
      const o = opts || {};
      const site = cizSiteOf(tab.url);
      const seen = isBlocked(o.blocks, site) ? false : (o.trusted || cizSiteMatch(list(), site) || entryOf(o.blocks, 'allow', site));
      if (!seen) return { id: tab.id, site, active: tab.active };
      return { id: tab.id, windowId: tab.windowId, active: tab.active, title: tab.title, url: tab.url, audible: tab.audible };
    },
    shown(id) {
      const e = open;
      if (!e || e.id !== id || e.shown) return;
      e.shown = true;
      stopTimer(e.shownTimer);
      e.answerTimer = startTimer(() => finish(e, 'timeout'), ANSWER_MS);
    },
    answer(id, choice) {
      const e = open;
      if (!e || e.id !== id) return false;
      const ok = e.kind === 'site' ? ['message', 'chat', 'deny'] : ['allow', 'deny'];
      if (ok.indexOf(choice) < 0) return false;
      finish(e, choice);
      return true;
    },
    cancel() {
      const q = queue; queue = [];
      if (open) finish(open, 'cancel');
      q.forEach(e => e.waiters.forEach(w => w.reject(new Error(refusedText(e.site)))));
    },
  };
  return gate;
})();
