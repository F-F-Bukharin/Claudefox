'use strict';
// Sidebar panel, the chat stream: answers as they arrive, their progress and army trail, file cards, and how each message is drawn.

// ------------------------------------------------------------ chat stream

function onChatEvent(id, ev) {
  const m = chat.find(x => x.id === id);
  if (!m || !m.pending) return;
  if (ev.kind === 'text') m.text += String(ev.text || '');
  else if (ev.kind === 'meta') m.meta = { model: String(ev.model || ''), effort: String(ev.effort || '') };
  else if (ev.kind === 'status') m.status = String(ev.status || '');
  else if (ev.kind === 'proposal') m.proposal = proposalFrom(ev);
  else if (ev.kind === 'stats') m.stats = { ms: Number(ev.ms) || 0, turns: Number(ev.turns) || 0, tokensIn: Number(ev.tokensIn) || 0, tokensOut: Number(ev.tokensOut) || 0, tokensCached: Number(ev.tokensCached) || 0, costUsd: Number(ev.costUsd) || 0 };
  else if (ev.kind === 'progress') {
    const steps = Array.isArray(ev.steps) && ev.steps.length ? ev.steps : (m.plan && m.plan.steps) || [];
    m.plan = { steps, done: Number(ev.done) || 0, note: String(ev.note || ''), at: m.steps.length };
  }
  else if (ev.kind === 'army') onArmyEvent(m, ev);
  else if (ev.kind === 'notice') {
    const said = ev.key && /^stream_\w+$/.test(ev.key) && cfxI18n.has(ev.key) ? t(ev.key) : String(ev.text || '');   // a notice the helper names by key is in the panel's language
    m.notices = (m.notices || []).concat([{ text: said.slice(0, 300), action: ev.action && typeof ev.action === 'object' ? ev.action : null }]).slice(-5);
  }
  else if (ev.kind === 'tool') {
    m.steps.push(Object.assign({ name: String(ev.name || 'tool'), input: String(ev.input || ''), state: 'run' }, ev.id ? { id: String(ev.id) } : {}, ev.server ? { server: String(ev.server).slice(0, 60) } : {}));
    if (m.steps.length > 30) m.steps.splice(0, m.steps.length - 30);
  } else if (ev.kind === 'tool_result') {
    const step = (ev.id && m.steps.find(st => st.id === String(ev.id))) || m.steps.find(st => st.state === 'run');
    if (step) { step.state = ev.error ? 'bad' : 'ok'; step.result = String(ev.text || ''); }
  }
  bump(m);
  scheduleRender();
}

// Token counts as the panel shows them: 999, 1.2k, 48k, 1.2M.
function tokenCount(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 999500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// The done line: the time, the tokens in (cached part in brackets) and out, and the API cost. A part with no data is left out.
function doneLine(m, secs) {
  const st = m.stats || {};
  const took = secs ? (secs < 100 ? secs.toFixed(1) : String(Math.round(secs))) : '';
  const parts = [took ? t(m.error ? 'stream_stoppedIn' : 'stream_doneIn', took) : t(m.error ? 'stream_stopped' : 'stream_done')];
  if (st.tokensIn > 0) parts.push(st.tokensCached > 0 ? t('stream_tokInCached', tokenCount(st.tokensIn), tokenCount(st.tokensCached)) : t('stream_tokIn', tokenCount(st.tokensIn)));
  if (st.tokensOut > 0) parts.push(t('stream_tokOut', tokenCount(st.tokensOut)));
  if (st.costUsd > 0) parts.push(t('stream_cost', st.costUsd.toFixed(2)));
  return parts.join(' · ');
}

// The army trail: the latest snapshot of the run in m.army, and the last two runs before it in m.armyPrev.
const ARMY_STATES = ['starting', 'working', 'done', 'failed', 'stopped'];
function armyWorker(w) {
  const sources = (Array.isArray(w.sources) ? w.sources : []).map(String).filter(u => /^https?:\/\//i.test(u)).slice(0, 5).map(u => u.slice(0, 500));
  return {
    id: String(w.id || '').slice(0, 8), goal: String(w.goal || '').slice(0, 120),
    state: ARMY_STATES.includes(w.state) ? w.state : 'starting',
    tab_id: Number.isInteger(w.tab_id) ? w.tab_id : null, host: String(w.host || '').slice(0, 80),
    action: String(w.action || '').slice(0, 120), steps: Number(w.steps) || 0, ms: Number(w.ms) || 0,
    error: String(w.error || '').slice(0, 200), sources,
  };
}
function onArmyEvent(m, ev) {
  const run = String(ev.run || '').slice(0, 20);
  if (m.army && m.army.run !== run) m.armyPrev = (m.armyPrev || []).concat([m.army]).slice(-2);
  const since = m.army && m.army.run === run ? m.army.since : Date.now();
  m.army = { run, round: Number(ev.round) || 1, finished: !!ev.finished, since, until: ev.finished ? Date.now() : 0,
    workers: (Array.isArray(ev.workers) ? ev.workers : []).slice(0, 5).map(armyWorker) };
  const today = Number(ev.today) || 0;
  if (ev.started && today > ARMY_RECOMMENDED) {
    m.notices = (m.notices || []).concat([{ text: t('stream_armyPast', today, ARMY_RECOMMENDED), action: null }]).slice(-5);
  }
}

function onChatDone(msg) {
  const own = chat.find(x => x.id === msg.id || x.cid === msg.id);
  if (!own) return;   // another window's answer
  histNoteDone(msg);
  const m = chat.find(x => x.id === msg.id);
  if (!m) {   // a waiting message that never started (Stop, a full queue): it stays, with the reason
    own.queued = false; own.error = t('stream_notSent', msg.error || t('stream_wentWrong')); bump(own);
    saveChat(); renderChat(); return;
  }
  m.pending = false;
  m.endedAt = Date.now();
  bump(m);
  for (const st of m.steps) if (st.state === 'run') st.state = msg.ok ? 'ok' : 'bad';
  if (!msg.ok) {
    m.error = msg.error || t('stream_wentWrong');
    m.limit = !!msg.limit;
    m.auth = !!msg.auth;
    m.account = typeof msg.account === 'string' ? msg.account : '';
  } else if (!m.text.trim()) {
    m.text = t('stream_noReplyText');
  }
  saveChat();
  renderChat();
}

// Answers that were running when the panel was closed and have since ended elsewhere.
function onChatRuns(ids, queued) {
  liveRuns = new Set(ids);
  liveQueued = queued || [];
  let changed = false;
  for (const m of chat) {   // waiting messages the background no longer has: started while the panel was closed, or gone
    if (!m.queued || liveQueued.includes(m.cid)) continue;
    m.queued = false; bump(m); changed = true;
    if (liveRuns.has(m.cid)) startedAnswer(m); else m.error = t('stream_notAnswered');
  }
  for (const m of chat) {
    if (m.pending && !liveRuns.has(m.id)) { m.pending = false; m.error = m.error || t('stream_interrupted'); bump(m); changed = true; }
  }
  if (changed) { saveChat(); renderChat(); }
}

// The background's word on what runs and what waits (any window): the hint under the input follows it.
let liveQueued = [];
function onChatBusy(ids, queued) { liveRuns = new Set(ids); liveQueued = queued || []; syncBusy(); }
// A message that waits in the queue: the user's bubble, pending, with a x. When it starts, Claude's answer opens under it.
function onChatQueued(id) {
  const u = chat.find(x => x.cid === id);
  if (!u) return;
  const a = chat.findIndex(x => x.id === id);
  if (a >= 0) chat.splice(a, 1);   // the placeholder a free panel showed too early
  u.queued = true; bump(u); saveChat(); renderChat();
}
function startedAnswer(u) {
  chat.splice(chat.indexOf(u) + 1, 0, { t: Date.now(), rev: 1, role: 'assistant', id: u.cid, text: '', steps: [], pending: true, startedAt: Date.now() });
}
function onChatStarted(id) {
  const u = chat.find(x => x.cid === id && x.queued);
  if (!u) return;
  u.queued = false; bump(u);
  if (!chat.some(x => x.id === id)) startedAnswer(u);
  saveChat(); renderChat();
}
function unqueue(id) {
  const i = chat.findIndex(x => x.cid === id && x.queued);
  if (i < 0) return;
  chat.splice(i, 1);
  send('chatUnqueue', { id });
  saveChat(); renderChat();
}
// Claude answers now (this window's answer, or any other window's): sending only queues.
const BUSY_HINT = t('stream_busyHint');
let lastBusy = false;
function isBusy() { return !!busyMsg() || !!(liveRuns && liveRuns.size); }
function syncBusy() {
  const b = isBusy();
  if (b === lastBusy) return;
  lastBusy = b;
  $('composerHint').textContent = state.agent === 'stopped' ? t('stream_hintStopped') : !state.signedIn ? t('stream_hintSignedOut') : b ? BUSY_HINT : '';
}

function addMsg(m) {
  chat.push(Object.assign({ t: Date.now(), rev: 1 }, m));
  if (chat.length > 200) chat.splice(0, chat.length - 200);
  saveChat();
  renderChat();
}

// Every change to a message bumps its rev; renderChat redraws a message only when its rev (or what the panel adds around it) changed.
function bump(m) { m.rev = (m.rev || 0) + 1; }

// The chat is saved once changes have stopped for a moment: 300 ms normally, 1 s while an answer is streaming (so a burst of
// tokens never writes), and when the turn ends the normal wait applies again.
let saveTimer = null;
function saveChat() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { const hist = histSave(); try { browser.storage.session.set(sessionDoc(hist)); } catch {} }, busyMsg() ? 1000 : 300);
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderChat(); saveChat(); });
}

const WHO = { user: t('stream_you'), assistant: 'Claude', system: 'Claudefox', error: 'Claudefox' };
const STEP_MARK = { run: '…', ok: '✓', bad: '✕' };
const VERB = {
  get_page_text: t('stream_verbGetPageText'),
  analyze_page: t('stream_verbAnalyzePage'),
  get_selection: t('stream_verbGetSelection'),
  read_page: t('stream_verbReadPage'),
  find: t('stream_verbFind'),
  click: t('stream_verbClick'),
  hover: t('stream_verbHover'),
  fill: t('stream_verbFill'),
  type_text: t('stream_verbTypeText'),
  press_key: t('stream_verbPressKey'),
  scroll: t('stream_verbScroll'),
  wait_for: t('stream_verbWaitFor'),
  media: t('stream_verbMedia'),
  screenshot: t('stream_verbScreenshot'),
  navigate: t('stream_verbNavigate'),
  tab_open: t('stream_verbTabOpen'),
  tab_activate: t('stream_verbTabActivate'),
  tab_close: t('stream_verbTabClose'),
  tabs_list: t('stream_verbTabsList'),
  create_file: t('stream_verbCreateFile'),
  WebSearch: t('stream_verbWebSearch'),
  WebFetch: t('stream_verbWebFetch'),
  Read: t('stream_verbRead'),
  Glob: t('stream_verbGlob'),
  Grep: t('stream_verbGrep'),
  Edit: t('stream_verbEdit'),
  Write: t('stream_verbWrite'),
  read_document: t('stream_verbReadDocument'),
  network_log: t('stream_verbNetworkLog'),
  console_log: t('stream_verbConsoleLog'),
  Skill: t('stream_verbSkill'),
  army_start: t('stream_verbArmyStart'),
  army_wait: t('stream_verbArmyWait'),
};

// What the current step is doing, in words: "Searching the web: niche tamagotchi repair".
function stepLabel(st) {
  const verb = (!st.server && VERB[st.name])
    || (st.server ? `${st.server}: ${String(st.name).replace(/^[a-z0-9]+_(?=[a-z])/i, m => (st.server.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(m.slice(0, -1).toLowerCase()) ? '' : m)).replace(/_/g, ' ')}`
      : t('stream_usingTool', st.name));
  let inp = {};
  try { inp = JSON.parse(st.input || '{}'); } catch {}
  let what = inp.query || inp.name || inp.text || inp.key || inp.skill || inp.video_id || inp.videoId || '';
  if (!what && inp.url) { try { what = new URL(inp.url).hostname.replace(/^www\./, ''); } catch { what = inp.url; } }
  if (!what && inp.file_path) what = String(inp.file_path).split(/[\\/]/).pop();
  if (!what && st.result) { const r = /"(?:clicked|hovered)":\s*"[^"]*?\\?"([^"\\]{1,60})/.exec(st.result); if (r) what = r[1]; }
  return what ? `${verb}: ${String(what).slice(0, 60)}` : verb;
}

// How far along a running answer is. With a plan from the progress tool: finished steps plus a share of the
// current one. Without: an estimate that grows with each action and slows down, never reaching the end.
function progressOf(m) {
  const acts = m.steps.length;
  const secs = (Date.now() - (m.startedAt || m.t || Date.now())) / 1000;
  if (m.plan && m.plan.steps.length) {
    const total = m.plan.steps.length, done = Math.min(m.plan.done, total);
    const inStep = done >= total ? 0.6 : 0.85 * (1 - Math.exp(-((acts - m.plan.at) + secs / 25) / 3));
    return Math.min(0.97, (done + inStep) / total);
  }
  return Math.min(0.92, 0.04 + 0.88 * (1 - Math.exp(-(acts + secs / 15) / 6)));
}

function progressLabel(m) {
  const run = [...m.steps].reverse().find(st => st.state === 'run');
  const last = run || m.steps[m.steps.length - 1];
  if (m.plan && m.plan.steps.length) {
    const total = m.plan.steps.length, at = Math.min(m.plan.done + 1, total);
    return t('stream_stepOf', at, total, m.plan.note || m.plan.steps[at - 1] || (last ? stepLabel(last) : t('stream_working')));
  }
  if (run) return stepLabel(run);
  if (m.text && !run) return t('stream_writing');
  if (last) return stepLabel(last);
  return m.status === 'thinking' ? t('stream_thinking') : t('stream_starting');
}

const expandedSteps = new Set();   // finished answers whose action list is open

// The reset time in a usage-limit message ("resets 3pm", "resets at 15:00", "resets 3:30 PM"), as 24-hour HH:MM; '' when there is none.
function limitResetAt(text) {
  const m = /\bresets?(?:\s+(?:at|on))?\s+(?:([A-Z][a-z]{2,8}\.?\s+\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(text || ''));
  if (!m || (!m[3] && !m[4])) return '';
  let h = Number(m[2]);
  const day = m[1] ? m[1].replace(/\s+/, ' ') + ', ' : '';
  const min = Number(m[3] || 0), ap = (m[4] || '').toLowerCase();
  if (min > 59 || (ap ? h < 1 || h > 12 : h > 23)) return '';
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return day + String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function progressBlock(m) {
  const box = document.createElement('div');
  if (m.pending) {
    box.className = 'progress';
    box.dataset.id = m.id;
    box.setAttribute('aria-live', 'polite');
    const track = document.createElement('div'); track.className = 'ptrack';
    const fill = document.createElement('div'); fill.className = 'pfill';
    fill.style.width = Math.round(progressOf(m) * 100) + '%';
    track.appendChild(fill);
    const label = document.createElement('div'); label.className = 'plabel'; label.textContent = progressLabel(m);
    box.append(track, label);
    return box;
  }
  if (!m.steps.length && !m.stats) return null;
  box.className = 'donebar';
  const secs = m.stats && m.stats.ms ? m.stats.ms / 1000 : m.endedAt && m.startedAt ? (m.endedAt - m.startedAt) / 1000 : 0;
  const n = m.steps.length;
  const mark = document.createElement('span'); mark.className = 'dmark' + (m.error ? ' bad' : ''); mark.textContent = m.error ? '✕' : '✓';
  const text = document.createElement('span');
  text.textContent = doneLine(m, secs);
  box.append(mark, text);
  if (n) {
    const tog = document.createElement('button'); tog.className = 'link dsteps';
    const open = expandedSteps.has(m.id);
    tog.textContent = `${t(n === 1 ? 'stream_actionOne' : 'stream_actionMany', n)} ${open ? '▴' : '▾'}`;
    tog.addEventListener('click', () => { if (open) expandedSteps.delete(m.id); else expandedSteps.add(m.id); renderChat(); });
    box.appendChild(tog);
    if (open) {
      const ul = document.createElement('ol'); ul.className = 'actlist';
      for (const st of m.steps) {
        const li = document.createElement('li'); li.className = st.state;
        li.textContent = `${STEP_MARK[st.state] || ''} ${stepLabel(st)}`;
        li.title = [st.input && t('stream_input', st.input), st.result && t('stream_result', st.result)].filter(Boolean).join('\n');
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
  }
  return box;
}

// The army block above the reply: one row per worker while the message runs, one summary line once it has finished.
const expandedArmy = new Set();   // finished answers whose army rows are open
const ARMY_MARK = { starting: '…', working: '…', done: '✓', failed: '✕', stopped: '■' };
const secsText = ms => { const s = ms / 1000; return s < 10 ? `${s.toFixed(1)} s` : s < 90 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`; };
function armyRuns(m) { return (m.armyPrev || []).concat(m.army ? [m.army] : []); }
function armyRow(w) {
  const li = el('li', 'arow ' + w.state);
  li.title = w.goal;
  li.appendChild(el('span', 'amark', ARMY_MARK[w.state]));
  li.appendChild(el('span', 'aid', w.id.toUpperCase()));
  if (w.host) li.appendChild(el('span', 'ahost', w.host));
  const running = w.state === 'working' || w.state === 'starting';
  const what = w.state === 'working' ? w.action : w.state === 'starting' ? t('stream_starting') : w.state === 'failed' ? w.error || t('stream_failed')
    : w.state === 'stopped' ? t('stream_workerStopped') : t(w.steps === 1 ? 'stream_stepOne' : 'stream_stepMany', w.steps);
  if (what) li.appendChild(el('span', 'awhat', what));
  if (w.state === 'working' && w.tab_id != null) {
    const show = el('button', 'link ashow', t('stream_show'));
    show.type = 'button';
    show.title = t('stream_workerTab');
    show.addEventListener('click', () => send('openTab', { id: w.tab_id }));
    li.appendChild(show);
  }
  if (!running && w.sources.length) {
    const src = el('span', 'asrc');
    for (const u of w.sources.slice(0, 3)) {
      const a = el('a', '', u.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 40));
      a.href = u;
      a.title = u;
      a.addEventListener('click', e => { e.preventDefault(); onLink('url', u); });
      src.appendChild(a);
    }
    li.appendChild(src);
  }
  return li;
}
function armyRunBlock(r) {
  const box = el('div', 'arun');
  const done = r.workers.filter(w => w.state === 'done').length;
  const head = el('div', 'ahead');
  head.appendChild(el('span', '', t('stream_armyHead', done, r.workers.length)));
  const time = el('span', 'atime', secsText((r.until || Date.now()) - r.since));
  if (!r.finished) time.dataset.since = String(r.since);
  head.appendChild(time);
  const ul = el('ol', 'arows');
  for (const w of r.workers) ul.appendChild(armyRow(w));
  box.append(head, ul);
  return box;
}
function armyBlock(m) {
  const runs = armyRuns(m);
  if (!runs.length) return null;
  const box = el('div', 'army-trail');
  if (m.pending) { for (const r of runs) box.appendChild(armyRunBlock(r)); return box; }
  const all = runs.flatMap(r => r.workers);
  const count = st => all.filter(w => w.state === st).length;
  const parts = [t(all.length === 1 ? 'stream_workerOne' : 'stream_workerMany', all.length)];
  for (const [st, key] of [['done', 'stream_countDone'], ['failed', 'stream_countFailed'], ['stopped', 'stream_countStopped']]) if (count(st)) parts.push(t(key, count(st)));
  const line = el('div', 'asum');
  line.appendChild(el('span', '', t('stream_armySummary', parts.join(' · '))));
  const open = expandedArmy.has(m.id);
  const tog = el('button', 'link dsteps', open ? t('stream_hide') + ' ▴' : t('stream_show') + ' ▾');
  tog.type = 'button';
  tog.setAttribute('aria-expanded', String(open));
  tog.addEventListener('click', () => { if (open) expandedArmy.delete(m.id); else expandedArmy.add(m.id); renderChat(); });
  line.appendChild(tog);
  box.appendChild(line);
  if (open) for (const r of runs) box.appendChild(armyRunBlock(r));
  return box;
}

const FILE_ICON = { md: 'MD', html: 'HTML', htm: 'HTML', csv: 'CSV', json: 'JSON', svg: 'SVG', txt: 'TXT', doc: 'DOC', docx: 'DOCX', pdf: 'PDF', xlsx: 'XLSX' };
function fileCard(f) {
  const card = document.createElement('div'); card.className = 'filecard';
  const ext = ((/\.([a-z0-9]+)$/i.exec(f.name) || [])[1] || 'file').toLowerCase();
  const ic = document.createElement('div'); ic.className = 'ficon'; ic.textContent = FILE_ICON[ext] || ext.slice(0, 4).toUpperCase();
  const info = document.createElement('div'); info.className = 'finfo';
  const nm = document.createElement('div'); nm.className = 'fname'; nm.textContent = f.name;
  const meta = document.createElement('div'); meta.className = 'fmeta';
  meta.textContent = [f.title, f.size >= 1024 ? `${Math.round(f.size / 1024)} KB` : `${f.size} bytes`].filter(Boolean).join(' · ');
  info.append(nm, meta);
  const open = document.createElement('button'); open.className = 'ghost fbtn'; open.textContent = t('stream_open');
  open.addEventListener('click', () => send('openFile', { id: f.id }));
  const dl = document.createElement('button'); dl.className = 'primary fbtn'; dl.textContent = t('stream_download');
  dl.addEventListener('click', () => send('downloadFile', { id: f.id }));
  card.append(ic, info, open, dl);
  return card;
}

// Pending answers: move the bar along (time counts too) without rebuilding the chat.
setInterval(() => {
  for (const el of document.querySelectorAll('.progress[data-id]')) {
    const m = chat.find(x => x.id === el.dataset.id);
    if (!m || !m.pending) continue;
    el.querySelector('.pfill').style.width = Math.round(progressOf(m) * 100) + '%';
    el.querySelector('.plabel').textContent = progressLabel(m);
  }
  for (const at of document.querySelectorAll('.atime[data-since]')) at.textContent = secsText(Date.now() - Number(at.dataset.since));
}, 1000);

// Light formatting for replies: **bold**, `code`, "- " bullets. Built as DOM nodes, never HTML.
function fillRich(el, text) {
  el.textContent = '';
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    const bullet = /^\s*[-*]\s+/.exec(line);
    if (bullet) { el.appendChild(document.createTextNode('• ')); line = line.slice(bullet[0].length); }
    for (const part of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      if (/^\*\*[^*]+\*\*$/.test(part)) { const b = document.createElement('strong'); b.textContent = part.slice(2, -2); el.appendChild(b); }
      else if (/^`[^`]+`$/.test(part)) { const c = document.createElement('code'); c.textContent = part.slice(1, -1); el.appendChild(c); }
      else el.appendChild(document.createTextNode(part));
    }
    if (i < lines.length - 1) el.appendChild(document.createTextNode('\n'));
  });
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = t('stream_copied'); }
  catch { btn.textContent = t('stream_copyFailed'); }
  setTimeout(() => { btn.textContent = t('stream_copy'); }, 1500);
}

// Each message keeps its own node and is rebuilt only when its own content changes. A streamed token changes the reply
// being written and nothing else, so the rest of the chat is not redrawn: it keeps its text selection and focus, and it
// does not replay its entrance.
const msgNodes = new WeakMap();   // message -> { rev, view, at, el }
let chatPainted = false;          // the chat as first drawn (on open) does not animate

// What the panel adds around a message's own rev: the switch button state and the two open/closed trails.
function msgView(m) {
  return (m.limit && state.switching ? 1 : 0) + '|' + (expandedSteps.has(m.id) ? 1 : 0) + (expandedArmy.has(m.id) ? 1 : 0);
}

// A streaming reply is redrawn (its Markdown parsed) at most this often; the final text always renders at once.
const STREAM_DRAW_MS = 150;
let drawTimer = null;

function buildMsg(m) {
  const div = document.createElement('div');
  div.className = 'msg ' + m.role + (m.pending ? ' pending' : '') + (m.queued ? ' queued' : '');
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = WHO[m.role] || '';
  div.appendChild(who);

  if (m.role === 'assistant' && Array.isArray(m.steps)) {
    const pb = progressBlock(m);
    if (pb) div.appendChild(pb);
  }
  for (const n of m.notices || []) {
    const box = el('div', 'notice');
    box.appendChild(el('span', '', n.text));
    if (n.action && n.action.type === 'tool_signin' && n.action.name) {
      const b = el('button', 'primary', n.action.label || t('stream_signIn'));
      b.addEventListener('click', () => send('toolSignIn', { name: String(n.action.name) }));
      box.appendChild(b);
    }
    div.appendChild(box);
  }
  if (m.role === 'assistant') {
    const ab = armyBlock(m);
    if (ab) div.appendChild(ab);
  }

  if (m.text || !m.pending) {
    const body = document.createElement('div');
    body.className = 'body';
    if (m.role === 'assistant') { body.classList.add('md'); cfxMarkdown(body, m.text, onLink); } else body.textContent = m.text;
    if (m.text) div.appendChild(body);
    if (m.role === 'user' && Array.isArray(m.files) && m.files.length) {
      const sf = el('div', 'sentfiles');
      for (const f of m.files) { const c = el('span', '', `📎 ${f.name}`); c.title = `${f.name} · ${sizeText(f.size || 0)}`; sf.appendChild(c); }
      div.appendChild(sf);
    }
    if (m.proposal && m.role === 'assistant' && !m.pending) div.appendChild(proposalCard(m));
    if (m.text && m.role === 'assistant' && !m.pending) {
      const foot = document.createElement('div');
      foot.className = 'msgfoot';
      if (m.meta && m.meta.model) {
        const tag = document.createElement('span');
        tag.className = 'ran' + (m.meta.effort === 'max' && /haiku/.test(m.meta.model) ? ' plus' : '');
        tag.textContent = t('stream_ranTag', modelName(m.meta.model), effortWord(m.meta.effort));
        tag.title = t('stream_ranTitle', m.meta.model, effortWord(m.meta.effort));
        foot.appendChild(tag);
      }
      div.appendChild(foot);
      const cp = document.createElement('button');
      cp.className = 'link copy';
      cp.textContent = t('stream_copy');
      cp.title = t('stream_copyReply');
      cp.addEventListener('click', () => copyText(m.text, cp));
      foot.appendChild(cp);
    }
  }
  if (m.role !== 'user' && Array.isArray(m.files) && m.files.length) {
    const files = document.createElement('div'); files.className = 'files-out';
    for (const f of m.files) files.appendChild(fileCard(f));
    div.appendChild(files);
  }
  if (m.queued) {
    const row = el('div', 'qrow', t('stream_queueWait'));
    const x = el('button', 'link qx', '×');
    x.type = 'button'; x.title = t('stream_queueRemove'); x.setAttribute('aria-label', t('stream_queueRemove'));
    x.addEventListener('click', () => unqueue(m.cid));
    row.appendChild(x);
    div.appendChild(row);
  }
  if (m.pending) {
    const row = document.createElement('div');
    row.className = 'working';
    const dots = document.createElement('span'); dots.className = 'dots'; dots.textContent = '';
    const cancel = document.createElement('button'); cancel.className = 'link'; cancel.textContent = t('stream_cancel');
    cancel.addEventListener('click', () => send('chatCancel', { id: m.id }));
    row.append(dots, cancel);
    div.appendChild(row);
  }
  if (m.error) {
    const err = document.createElement('div');
    err.className = 'body errline';
    err.textContent = m.error;
    div.appendChild(err);
    if (m.limit) {
      const hint = document.createElement('div');
      hint.className = 'limit';
      const at = limitResetAt(m.error);
      hint.textContent = at ? t('stream_limitResets', at) : m.error;
      const sw = document.createElement('button');
      sw.className = 'primary limitbtn';
      sw.textContent = t('stream_switchAccount');
      sw.disabled = !!state.switching;
      sw.addEventListener('click', () => send('switchAccount'));
      div.append(hint, sw);
    }
    else if (m.auth) {   // Claude Code's sign-in for this account expired: sign it in again, then send again
      const hint = document.createElement('div');
      hint.className = 'limit';
      hint.textContent = t('stream_signInExpired');
      const btn = document.createElement('button');
      btn.className = 'primary limitbtn';
      btn.textContent = t('stream_signInAgain');
      btn.addEventListener('click', () => send('accountSignIn', { id: m.account || 'main' }));
      div.append(hint, btn);
    }
  }

  if (Array.isArray(m.tabs)) {
    const ul = document.createElement('ul');
    ul.className = 'tablist';
    for (const tab of m.tabs) {
      const li = document.createElement('li');
      if (tab.active) li.className = 'active';
      const id = document.createElement('span'); id.className = 'tid'; id.textContent = '#' + tab.id;
      const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = tab.title || t('stream_untitled');
      const tu = document.createElement('span'); tu.className = 'tu'; tu.textContent = tab.url || '';
      li.append(id, tt, tu);
      ul.appendChild(li);
    }
    div.appendChild(ul);
  }
  return div;
}

function renderChat() {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  // Nodes of messages that are gone (cleared, or trimmed to the last 200) go; the rest stay where they are.
  const live = new Set();
  for (const m of chat) { const h = msgNodes.get(m); if (h) live.add(h.el); }
  for (const node of box.querySelectorAll('.msg')) if (!live.has(node)) node.remove();
  let prev = $('emptyState');
  const now = Date.now();
  let wait = 0;
  for (const m of chat) {
    const view = msgView(m);
    let hit = msgNodes.get(m);
    if (hit && hit.at && hit.rev !== m.rev && hit.view === view && m.pending && now - hit.at < STREAM_DRAW_MS) wait = Math.max(wait, STREAM_DRAW_MS - (now - hit.at));   // too soon: keep what is drawn, draw again later
    else if (!hit || hit.rev !== m.rev || hit.view !== view) {
      if (hit) hit.el.remove();
      const node = buildMsg(m);
      // Only a message's first appearance animates. Rebuilding it on a streamed token must not replay that.
      if (!hit && chatPainted) {
        node.classList.add('enter');
        node.addEventListener('animationend', e => { if (e.target === node) node.classList.remove('enter'); });
      }
      hit = { rev: m.rev, view, at: m.text ? now : 0, el: node };   // at: when the reply's Markdown was last parsed; the first words draw at once
      msgNodes.set(m, hit);
    }
    if (prev.nextElementSibling !== hit.el) prev.after(hit.el);
    prev = hit.el;
  }
  chatPainted = true;
  clearTimeout(drawTimer);
  if (wait) drawTimer = setTimeout(renderChat, wait);
  $('emptyState').hidden = chat.length > 0;
  $('page-chat').classList.toggle('is-empty', chat.length === 0);
  if (atBottom || busyMsg()) box.scrollTop = box.scrollHeight;
  syncBusy();
}

