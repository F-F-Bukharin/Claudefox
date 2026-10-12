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
  else if (ev.kind === 'stats') m.stats = { ms: Number(ev.ms) || 0, turns: Number(ev.turns) || 0 };
  else if (ev.kind === 'progress') {
    const steps = Array.isArray(ev.steps) && ev.steps.length ? ev.steps : (m.plan && m.plan.steps) || [];
    m.plan = { steps, done: Number(ev.done) || 0, note: String(ev.note || ''), at: m.steps.length };
  }
  else if (ev.kind === 'army') onArmyEvent(m, ev);
  else if (ev.kind === 'notice') {
    m.notices = (m.notices || []).concat([{ text: String(ev.text || '').slice(0, 300), action: ev.action && typeof ev.action === 'object' ? ev.action : null }]).slice(-5);
  }
  else if (ev.kind === 'tool') {
    m.steps.push(Object.assign({ name: String(ev.name || 'tool'), input: String(ev.input || ''), state: 'run' }, ev.server ? { server: String(ev.server).slice(0, 60) } : {}));
    if (m.steps.length > 30) m.steps.splice(0, m.steps.length - 30);
  } else if (ev.kind === 'tool_result') {
    const step = m.steps.find(st => st.state === 'run');
    if (step) { step.state = ev.error ? 'bad' : 'ok'; step.result = String(ev.text || ''); }
  }
  scheduleRender();
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
    m.notices = (m.notices || []).concat([{ text: `Army run ${today} today: past the recommended ${ARMY_RECOMMENDED}, so this uses a lot of your plan.`, action: null }]).slice(-5);
  }
}

function onChatDone(msg) {
  const m = chat.find(x => x.id === msg.id);
  if (!m) return;
  m.pending = false;
  m.endedAt = Date.now();
  for (const st of m.steps) if (st.state === 'run') st.state = msg.ok ? 'ok' : 'bad';
  if (!msg.ok) {
    m.error = msg.error || 'Something went wrong.';
    m.limit = !!msg.limit;
  } else if (!m.text.trim()) {
    m.text = '(No reply text.)';
  }
  saveChat();
  renderChat();
}

// Answers that were running when the panel was closed and have since ended elsewhere.
function onChatRuns(ids) {
  liveRuns = new Set(ids);
  let changed = false;
  for (const m of chat) {
    if (m.pending && !liveRuns.has(m.id)) { m.pending = false; m.error = m.error || 'This answer was interrupted.'; changed = true; }
  }
  if (changed) { saveChat(); renderChat(); }
}

function addMsg(m) {
  chat.push(Object.assign({ t: Date.now() }, m));
  if (chat.length > 200) chat.splice(0, chat.length - 200);
  saveChat();
  renderChat();
}

let saveTimer = null;
function saveChat() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { browser.storage.session.set({ chat }); } catch {} }, 300);
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderChat(); saveChat(); });
}

const WHO = { user: 'You', assistant: 'Claude', system: 'Claude in Zen', error: 'Claude in Zen' };
const STEP_MARK = { run: '…', ok: '✓', bad: '✕' };
const VERB = {
  get_page_text: 'Reading the page', analyze_page: 'Analyzing the page', get_selection: 'Reading your selection',
  read_page: 'Looking over the page', find: 'Finding', click: 'Clicking', hover: 'Pointing at', fill: 'Filling in',
  type_text: 'Typing', press_key: 'Pressing a key', scroll: 'Scrolling', wait_for: 'Waiting for the page',
  media: 'Controlling the player', screenshot: 'Looking at the page', navigate: 'Opening a page', tab_open: 'Opening a tab',
  tab_activate: 'Switching tabs', tab_close: 'Closing a tab', tabs_list: 'Checking your tabs', create_file: 'Writing a file',
  WebSearch: 'Searching the web', WebFetch: 'Reading a web page', Read: 'Reading a file', Glob: 'Looking for files',
  Grep: 'Searching files', Edit: 'Editing a file', Write: 'Saving a file', read_document: 'Reading a document',
  network_log: 'Reading the network log', console_log: 'Reading the console', Skill: 'Using a skill',
  army_start: 'Sending the army', army_wait: 'Waiting for the army',
};

// What the current step is doing, in words: "Searching the web: niche tamagotchi repair".
function stepLabel(st) {
  const verb = (!st.server && VERB[st.name])
    || (st.server ? `${st.server}: ${String(st.name).replace(/^[a-z0-9]+_(?=[a-z])/i, m => (st.server.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(m.slice(0, -1).toLowerCase()) ? '' : m)).replace(/_/g, ' ')}`
      : `Using ${st.name}`);
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
    return `Step ${at} of ${total} · ${m.plan.note || m.plan.steps[at - 1] || (last ? stepLabel(last) : 'Working')}`;
  }
  if (run) return stepLabel(run);
  if (m.text && !run) return 'Writing';
  if (last) return stepLabel(last);
  return m.status === 'thinking' ? 'Thinking' : 'Starting';
}

const expandedSteps = new Set();   // finished answers whose action list is open

function progressBlock(m) {
  const box = document.createElement('div');
  if (m.pending) {
    box.className = 'progress';
    box.dataset.id = m.id;
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
  text.textContent = `${m.error ? 'Stopped' : 'Done'}${secs ? ` in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s` : ''}`;
  box.append(mark, text);
  if (n) {
    const t = document.createElement('button'); t.className = 'link dsteps';
    const open = expandedSteps.has(m.id);
    t.textContent = `${n} action${n === 1 ? '' : 's'} ${open ? '▴' : '▾'}`;
    t.addEventListener('click', () => { if (open) expandedSteps.delete(m.id); else expandedSteps.add(m.id); renderChat(); });
    box.appendChild(t);
    if (open) {
      const ul = document.createElement('ol'); ul.className = 'actlist';
      for (const st of m.steps) {
        const li = document.createElement('li'); li.className = st.state;
        li.textContent = `${STEP_MARK[st.state] || ''} ${stepLabel(st)}`;
        li.title = [st.input && `Input: ${st.input}`, st.result && `Result: ${st.result}`].filter(Boolean).join('\n');
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
  const what = w.state === 'working' ? w.action : w.state === 'starting' ? 'Starting' : w.state === 'failed' ? w.error || 'Failed'
    : w.state === 'stopped' ? 'Stopped' : `${w.steps} step${w.steps === 1 ? '' : 's'}`;
  if (what) li.appendChild(el('span', 'awhat', what));
  if (w.state === 'working' && w.tab_id != null) {
    const show = el('button', 'link ashow', 'Show');
    show.type = 'button';
    show.title = 'Switch to this worker\'s tab';
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
  head.appendChild(el('span', '', `Army · ${done} of ${r.workers.length} done`));
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
  const parts = [`${all.length} worker${all.length === 1 ? '' : 's'}`];
  for (const [st, word] of [['done', 'done'], ['failed', 'failed'], ['stopped', 'stopped']]) if (count(st)) parts.push(`${count(st)} ${word}`);
  const line = el('div', 'asum');
  line.appendChild(el('span', '', `Army: ${parts.join(' · ')}`));
  const open = expandedArmy.has(m.id);
  const t = el('button', 'link dsteps', open ? 'Hide ▴' : 'Show ▾');
  t.type = 'button';
  t.setAttribute('aria-expanded', String(open));
  t.addEventListener('click', () => { if (open) expandedArmy.delete(m.id); else expandedArmy.add(m.id); renderChat(); });
  line.appendChild(t);
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
  const open = document.createElement('button'); open.className = 'ghost fbtn'; open.textContent = 'Open';
  open.addEventListener('click', () => send('openFile', { id: f.id }));
  const dl = document.createElement('button'); dl.className = 'primary fbtn'; dl.textContent = 'Download';
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
  for (const t of document.querySelectorAll('.atime[data-since]')) t.textContent = secsText(Date.now() - Number(t.dataset.since));
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
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}

// Each message keeps its own node and is rebuilt only when its own content changes. A streamed token changes the reply
// being written and nothing else, so the rest of the chat is not redrawn: it keeps its text selection and focus, and it
// does not replay its entrance.
const msgNodes = new WeakMap();   // message -> { sig, el }
let chatPainted = false;          // the chat as first drawn (on open) does not animate

function msgSig(m) {
  return JSON.stringify(m) + '|' + (m.limit && state.switching ? 1 : 0) + '|' + (expandedSteps.has(m.id) ? 1 : 0) + (expandedArmy.has(m.id) ? 1 : 0);
}

function buildMsg(m) {
  const div = document.createElement('div');
  div.className = 'msg ' + m.role + (m.pending ? ' pending' : '');
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
      const b = el('button', 'primary', n.action.label || 'Sign in');
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
    if (m.role === 'assistant') { body.classList.add('md'); cizMarkdown(body, m.text, onLink); } else body.textContent = m.text;
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
        tag.textContent = `${modelName(m.meta.model)} · ${m.meta.effort} effort`;
        tag.title = `Ran on ${m.meta.model}, ${m.meta.effort} effort`;
        foot.appendChild(tag);
      }
      div.appendChild(foot);
      const cp = document.createElement('button');
      cp.className = 'link copy';
      cp.textContent = 'Copy';
      cp.title = 'Copy this reply';
      cp.addEventListener('click', () => copyText(m.text, cp));
      foot.appendChild(cp);
    }
  }
  if (m.role !== 'user' && Array.isArray(m.files) && m.files.length) {
    const files = document.createElement('div'); files.className = 'files-out';
    for (const f of m.files) files.appendChild(fileCard(f));
    div.appendChild(files);
  }
  if (m.pending) {
    const row = document.createElement('div');
    row.className = 'working';
    const dots = document.createElement('span'); dots.className = 'dots'; dots.textContent = '';
    const cancel = document.createElement('button'); cancel.className = 'link'; cancel.textContent = 'Cancel';
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
      hint.textContent = 'This Claude account hit its usage limit.';
      const sw = document.createElement('button');
      sw.className = 'primary limitbtn';
      sw.textContent = 'Log out and add another account';
      sw.disabled = !!state.switching;
      sw.addEventListener('click', () => send('switchAccount'));
      div.append(hint, sw);
    }
  }

  if (Array.isArray(m.tabs)) {
    const ul = document.createElement('ul');
    ul.className = 'tablist';
    for (const t of m.tabs) {
      const li = document.createElement('li');
      if (t.active) li.className = 'active';
      const id = document.createElement('span'); id.className = 'tid'; id.textContent = '#' + t.id;
      const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = t.title || 'Untitled';
      const tu = document.createElement('span'); tu.className = 'tu'; tu.textContent = t.url || '';
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
  for (const m of chat) {
    const sig = msgSig(m);
    let hit = msgNodes.get(m);
    if (!hit || hit.sig !== sig) {
      if (hit) hit.el.remove();
      const node = buildMsg(m);
      // Only a message's first appearance animates. Rebuilding it on a streamed token must not replay that.
      if (!hit && chatPainted) {
        node.classList.add('enter');
        node.addEventListener('animationend', e => { if (e.target === node) node.classList.remove('enter'); });
      }
      hit = { sig, el: node };
      msgNodes.set(m, hit);
    }
    if (prev.nextElementSibling !== hit.el) prev.after(hit.el);
    prev = hit.el;
  }
  chatPainted = true;
  $('emptyState').hidden = chat.length > 0;
  $('page-chat').classList.toggle('is-empty', chat.length === 0);
  if (atBottom || busyMsg()) box.scrollTop = box.scrollHeight;
  $('sendBtn').disabled = !!busyMsg();
}

