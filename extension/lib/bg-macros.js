'use strict';
// Claude in Zen: saved macros and scheduled macros (E7, E8). The panel (Settings → Macros) writes storage.local `macros`:
//   [{ name, text, army: [task, ...], sites: [site, ...], schedule: null | { kind: 'daily', at: 'HH:MM' } | { kind: 'every', hours: 1..24 } }]
// This file keeps one alarm per scheduled macro (named "macro:<name>", rebuilt whenever `macros` changes and at start) and runs a
// macro when its alarm fires: a chat turn the add-on starts itself (startChat in lib/bg-chat.js, msg.scheduled), through the same queue.
// A scheduled turn only reads: see CIZ_SCHEDULED_TOOLS (lib/bg-router.js) and the scheduled mode of lib/siteGate.js.
// Skipped and logged: while stopped, after a usage limit hit in the last 2 hours, and when another answer is still running after
// 30 minutes of waiting. The result goes to History under "Scheduled" (chats:<account>, group 'Scheduled'), with a notification.

const cizMacros = (() => {
  const NAME = /^[\p{L}\p{N}-]{1,30}$/u;
  const LIMIT_PAUSE_MS = 2 * 3600 * 1000, WAIT_MS = 30 * 60 * 1000, HIST_MAX = 300;
  let seq = 0;

  const siteOf = s => { const t = String(s || '').trim(); return cizSiteOf(/^https?:\/\//i.test(t) ? t : 'http://' + t); };
  // Only well-formed macros come out; a schedule without sites is dropped (a scheduled macro must list its sites).
  function clean(list) {
    const out = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || typeof m.name !== 'string' || !NAME.test(m.name) || typeof m.text !== 'string' || !m.text.trim() || out.some(x => x.name === m.name)) continue;
      const sites = [];
      for (const s of Array.isArray(m.sites) ? m.sites : []) { const h = siteOf(s); if (h && sites.indexOf(h) < 0) sites.push(h); }
      let schedule = null;
      const sc = m.schedule;
      if (sc && sc.kind === 'daily' && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(sc.at))) schedule = { kind: 'daily', at: sc.at };
      else if (sc && sc.kind === 'every' && Number.isInteger(sc.hours) && sc.hours >= 1 && sc.hours <= 24) schedule = { kind: 'every', hours: sc.hours };
      if (!sites.length) schedule = null;
      out.push({ name: m.name, text: m.text, army: (Array.isArray(m.army) ? m.army : []).map(t => String(t).trim()).filter(Boolean), sites, schedule });
    }
    return out;
  }
  async function load() {
    try { return clean((await browser.storage.local.get('macros')).macros); } catch { return []; }
  }

  // One alarm per scheduled macro. A daily alarm starts at the next HH:MM and repeats every 24 hours.
  async function sync() {
    if (!browser.alarms) return;
    const list = await load();
    try { for (const a of await browser.alarms.getAll()) if (a.name.startsWith('macro:')) await browser.alarms.clear(a.name); } catch {}
    for (const m of list) {
      if (!m.schedule) continue;
      if (m.schedule.kind === 'every') browser.alarms.create('macro:' + m.name, { delayInMinutes: m.schedule.hours * 60, periodInMinutes: m.schedule.hours * 60 });
      else {
        const [h, min] = m.schedule.at.split(':').map(Number);
        const t = new Date(); t.setHours(h, min, 0, 0);
        if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
        browser.alarms.create('macro:' + m.name, { when: t.getTime(), periodInMinutes: 1440 });
      }
    }
  }

  function note(message) {
    try { if (browser.notifications) Promise.resolve(browser.notifications.create('macro-' + Date.now() + '-' + (++seq), { type: 'basic', title: 'Claudefox', message, iconUrl: 'icons/icon.svg' })).catch(() => {}); } catch {}
  }
  async function skipped(name, why) {
    const reason = String(why || '').split('\n')[0].slice(0, 160);
    await cizState.addLog('warn', `Scheduled macro ${name} skipped: ${reason}`);
    note(t('bg_macroSkipped', name, reason));
  }

  // The alarm: run the macro, or skip it.
  async function run(name) {
    if (typeof booted !== 'undefined') await booted;
    const m = (await load()).find(x => x.name === name);
    if (!m || !m.schedule) { try { browser.alarms.clear('macro:' + name); } catch {} return; }
    if (cizState.get().agent !== 'active') return skipped(name, t('bg_macroStopped'));
    let hit = 0;
    try { hit = Number((await browser.storage.local.get('limitHitAt')).limitHitAt) || 0; } catch {}
    if (Date.now() - hit < LIMIT_PAUSE_MS) return skipped(name, t('bg_macroLimit'));
    return startChat({ id: 's' + Date.now().toString(36) + (++seq), text: m.text, scheduled: { macro: m.name, sites: m.sites } });
  }

  // A scheduled run that has to wait behind an answer: still waiting after 30 minutes means skipped.
  function waitOrSkip(id, name) {
    setTimeout(() => {
      const i = chatQueue.findIndex(q => q.id === id);
      if (i < 0) return;
      chatQueue.splice(i, 1);
      chatBusyPush();
      skipped(name, t('bg_macroWaited'));
    }, WAIT_MS);
  }

  // The turn ended: its answer goes to History under "Scheduled" and a notification says so.
  async function finished(runInfo, done) {
    const name = runInfo.scheduled.macro;
    if (!done.ok) {
      const why = String(done.error || t('bg_macroItFailed')).split('\n')[0].slice(0, 160);
      await cizState.addLog('warn', `Scheduled macro ${name} failed: ${why}`);
      return note(t('bg_macroFailed', name, why));
    }
    try {
      const st = cizState.get();
      const acct = String(((st.accounts || []).find(a => a && a.active) || {}).id || (st.account && st.account.uuid) || 'default');
      const id = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const now = Date.now();
      const m = (await load()).find(x => x.name === name);
      const lk = 'chats:' + acct;
      let list = (await browser.storage.local.get(lk))[lk];
      list = Array.isArray(list) ? list : [];
      list.unshift({ id, title: `${name}, ${new Date(now).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`, created: now, updated: now, sessionId: '', group: 'Scheduled' });
      const gone = [];
      while (list.length > HIST_MAX) { let o = 0; for (let i = 1; i < list.length; i++) if (list[i].updated < list[o].updated) o = i; gone.push(list.splice(o, 1)[0]); }
      await browser.storage.local.set({ [lk]: list, ['chat:' + id]: [
        { role: 'user', text: m ? m.text : name }, { role: 'assistant', text: runInfo.text || t('bg_noAnswer'), steps: [] } ] });
      if (gone.length) await browser.storage.local.remove(gone.map(c => 'chat:' + c.id));
    } catch (e) { await cizState.addLog('error', `Scheduled macro ${name}: could not save the result: ${e.message || e}`); }
    note(t('bg_macroFinished', name));
  }

  try {
    if (browser.alarms) browser.alarms.onAlarm.addListener(a => { if (a && String(a.name).startsWith('macro:')) run(a.name.slice(6)).catch(e => cizState.addLog('error', `Scheduled macro: ${e.message || e}`)); });
    if (browser.storage.onChanged) browser.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.macros) sync().catch(() => {}); });
    sync().catch(() => {});
  } catch {}
  return { clean, sync, run, waitOrSkip, skipped, finished };
})();
