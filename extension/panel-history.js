'use strict';
// Sidebar panel, chat history: every chat is kept in storage.local, per account, and the history drawer (the clock button in the
// header) searches, reopens, exports and deletes them. chats:<account> holds the list [{ id, title, created, updated, sessionId }],
// newest first; chat:<id> holds that chat's messages. Up to HIST_MAX chats per account; past that the one updated longest ago goes.
// The account is the one marked active in state.accounts (else state.account.uuid): a chat belongs to the account that was active
// when it started. saveChat (panel-stream.js) calls histSave once the chat has paused, so a streaming answer never writes.

const HIST_MAX = 300;
let histCur = null;       // { id, acct, created } of the chat open in this window; null until its first real message is saved
let histSession = '';     // the Claude session id of the open chat
let histResume = null;    // set when a chat is opened: the session the next message resumes ('' = a new one); null = the background's own
let histQueue = Promise.resolve();   // storage writes run one after another, so a read-modify-write never overlaps another
let histSeq = 0;

function histAcct() {
  const a = (state.accounts || []).find(x => x && x.active);
  return String((a && a.id) || (state.account && state.account.uuid) || 'default');
}
const histEnqueue = fn => { histQueue = histQueue.then(fn).catch(() => {}); return histQueue; };
const histReal = m => m.role === 'user' && !String(m.text || '').startsWith('/');   // a typed "/command" is not a conversation

(async () => {   // the chat that was open when the panel closed is still the open one
  try {
    await winReady;
    const g = await browser.storage.session.get(winKey() || 'histMeta');
    const hm = (winKey() ? (g[winKey()] || {}) : g).histMeta;   // this window's open chat
    if (hm && hm.id && !histCur) { histCur = { id: hm.id, acct: hm.acct, created: hm.created }; histSession = hm.session || ''; }
  } catch {}
})();

// What would be saved now, taken at once (the write itself waits its turn in the queue).
function histSnapshot() {
  const first = chat.find(histReal);
  if (!first) return null;
  if (!histCur) histCur = { id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), acct: histAcct(), created: Date.now() };
  const title = String(first.text || (first.files && first.files[0] && first.files[0].name) || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
  return { acct: histCur.acct, id: histCur.id, created: histCur.created, title, sessionId: histSession, at: Date.now(), msgs: JSON.parse(JSON.stringify(chat)) };
}

async function histWrite(s) {
  const lk = 'chats:' + s.acct;
  const got = await browser.storage.local.get(lk);
  let list = Array.isArray(got[lk]) ? got[lk] : [];
  const old = list.find(c => c.id === s.id);
  list = list.filter(c => c.id !== s.id);
  list.unshift({ id: s.id, title: old ? old.title : s.title, created: s.created, updated: s.at, sessionId: s.sessionId });
  const gone = [];
  while (list.length > HIST_MAX) {
    let oldest = 0;
    for (let i = 1; i < list.length; i++) if (list[i].updated < list[oldest].updated) oldest = i;
    gone.push(list.splice(oldest, 1)[0]);
  }
  await browser.storage.local.set({ [lk]: list, ['chat:' + s.id]: s.msgs });
  if (gone.length) {
    await browser.storage.local.remove(gone.map(c => 'chat:' + c.id));
    send('histLog', { text: `History: the oldest ${gone.length === 1 ? 'chat' : gone.length + ' chats'} went, because an account keeps up to ${HIST_MAX}` });
  }
}

// Called by saveChat once the chat has paused (300 ms, 1 s while an answer streams). Returns what saveChat adds to its
// storage.session write: which history entry is open, so a reopened panel carries on with it.
function histSave() {
  const snap = histSnapshot();
  if (!snap) return { histMeta: null };
  histEnqueue(() => histWrite(snap));
  return { histMeta: { id: snap.id, acct: snap.acct, created: snap.created, session: snap.sessionId } };
}

// The end of a turn brings the Claude session id; an opened chat sends its own until a turn has been answered.
function histNoteDone(msg) {
  const err = String(msg.error || '');
  if (msg.sessionId) histSession = String(msg.sessionId);
  if (!msg.ok && /No conversation found/i.test(err)) histSession = '';
  if (msg.ok || msg.sessionId || /No conversation found/i.test(err)) histResume = null;
}
// A window sends its chat's session itself, unless an earlier message of this chat is still answering or waiting (the background then
// continues from that message's session).
function histResumeExtra() {
  if (winId != null && (busyMsg() || chat.some(m => m.queued))) return {};
  return histResume !== null ? { resume: histResume } : winId != null ? { resume: histSession } : {};
}
// What saveChat writes to storage.session: this window's chat under win:<id> (the chat and which history entry is open).
function sessionDoc(hist) { const d = Object.assign({ chat }, hist); return winKey() ? { [winKey()]: d } : d; }

// A new chat (+ menu, /clear): the chat that is open stays in History, the next message starts a new entry.
function histReset() { histCur = null; histSession = ''; histResume = null; }
function histNewChat() {
  const snap = histSnapshot();
  if (snap) histEnqueue(() => histWrite(snap));
  histReset();
}
function histBlank() { histReset(); chat = []; send('newChat'); saveChat(); renderChat(); }

// ------------------------------------------------------------ Markdown export

const histDay = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function histSite(st) {
  try { const u = JSON.parse(st.input || '{}').url; if (u) return new URL(u).hostname.replace(/^www\./, ''); } catch {}
  return '';
}
// # <title>, the date, then **You:** and **Claude:** turns; a Claude turn ends with its tool steps as "- <tool> on <site>"
// (just "- <tool>" where the step names no page).
function histMarkdown(title, created, msgs) {
  const out = ['# ' + title, '', histDay(created)];
  for (const m of msgs) {
    if (m.role === 'user') out.push('', '**You:** ' + String(m.text || '') + (m.files && m.files.length ? `\n\n(Attached: ${m.files.map(f => f.name).join(', ')})` : ''));
    else if (m.role === 'assistant') {
      out.push('', '**Claude:** ' + String(m.text || m.error || ''));
      const steps = (m.steps || []).map(st => { const site = histSite(st); return `- ${st.name}${site ? ' on ' + site : ''}`; });
      if (steps.length) out.push('', ...steps);
    }
  }
  return out.join('\n') + '\n';
}

async function histExport(id) {
  await histQueue;
  const acct = histAcct();
  const got = await browser.storage.local.get(['chats:' + acct, 'chat:' + id]);
  const meta = (got['chats:' + acct] || []).find(c => c.id === id);
  if (!meta || !Array.isArray(got['chat:' + id])) return histRender();
  const md = histMarkdown(meta.title, meta.created, got['chat:' + id]);
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  const name = meta.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'chat';
  try { await browser.downloads.download({ url, filename: `Claude in Zen/${name}.md`, conflictAction: 'uniquify', saveAs: false }); }
  catch (e) { $('composerHint').textContent = 'Could not save the Markdown: ' + (e && e.message || e); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ------------------------------------------------------------ the drawer

function histShow(on) {
  $('histDrawer').hidden = !on;
  $('histBtn').setAttribute('aria-expanded', String(on));
  $('histConfirm').hidden = true;
  if (!on) return;
  showPage('chat');
  $('histSearch').value = '';
  histRender().then(() => $('histSearch').focus());
}

async function histRender() {
  const seq = ++histSeq;
  await histQueue;
  const acct = histAcct();
  const q = $('histSearch').value.trim().toLowerCase();
  let items = [];
  let texts = {};
  try {
    const got = await browser.storage.local.get('chats:' + acct);
    items = (Array.isArray(got['chats:' + acct]) ? got['chats:' + acct] : []).slice().sort((a, b) => b.updated - a.updated);
    if (q && items.length) texts = await browser.storage.local.get(items.map(c => 'chat:' + c.id));
  } catch {}
  if (seq !== histSeq) return;
  if (q) items = items.filter(c => c.title.toLowerCase().includes(q) || (texts['chat:' + c.id] || []).some(m => String(m.text || '').toLowerCase().includes(q)));
  const list = $('histList');
  list.textContent = '';
  const a = (state.accounts || []).find(x => x && x.active);
  const sched = items.filter(c => c.group === 'Scheduled');   // scheduled macros' results (lib/bg-macros.js) sit in their own group
  for (const c of items.filter(c => c.group !== 'Scheduled')) list.appendChild(histRow(c));
  if (sched.length) { list.appendChild(el('li', 'hist-group', 'Scheduled')); for (const c of sched) list.appendChild(histRow(c)); }
  $('histEmpty').textContent = q ? 'No chat matches.' : `No saved chats yet${a && a.email ? ' for ' + a.email : ''}.`;
  $('histEmpty').hidden = items.length > 0;
}

function histRow(c) {
  const li = el('li', 'hist-item');
  li.dataset.id = c.id;
  const open = el('button', 'hist-open');
  open.type = 'button';
  open.append(el('span', 'hist-title', c.title), el('span', 'hist-date', new Date(c.updated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })));
  open.disabled = !!busyMsg() && !(histCur && histCur.id === c.id);
  if (open.disabled) open.title = 'Claude is still answering. Open a chat after it finishes.';
  open.addEventListener('click', () => histOpen(c.id));
  const acts = el('div', 'hist-acts');
  const exp = el('button', 'hist-export link', 'Export Markdown');
  exp.type = 'button';
  exp.addEventListener('click', () => histExport(c.id));
  const del = el('button', 'hist-del link', 'Delete');
  del.type = 'button';
  del.addEventListener('click', () => histDelete(c.id));
  acts.append(exp, del);
  li.append(open, acts);
  return li;
}

// Open: the chat goes into this window and its Claude session is the one the next message resumes.
async function histOpen(id) {
  if (histCur && histCur.id === id) return histShow(false);
  if (busyMsg() || chat.some(m => m.queued)) return;
  await histQueue;
  const acct = histAcct();
  const got = await browser.storage.local.get(['chats:' + acct, 'chat:' + id]);
  const meta = (got['chats:' + acct] || []).find(c => c.id === id);
  const msgs = got['chat:' + id];
  if (!meta || !Array.isArray(msgs)) return histRender();
  leaveImprove();
  histNewChat();   // keeps the chat that was open
  for (const m of msgs) if (m.pending) { m.pending = false; m.error = m.error || 'This answer was interrupted.'; bump(m); }
  for (const m of msgs) if (m.queued) { m.queued = false; m.error = 'This message was not sent.'; bump(m); }
  chat = msgs;
  histCur = { id, acct, created: meta.created };
  histSession = meta.sessionId || '';
  histResume = histSession;
  saveChat();
  renderChat();
  histShow(false);
  $('input').focus();
}

async function histDelete(id) {
  const acct = histAcct();
  if (histCur && histCur.id === id) histBlank();   // the open chat: a new one starts, and nothing of this one is saved again
  histEnqueue(async () => {
    const got = await browser.storage.local.get('chats:' + acct);
    await browser.storage.local.set({ ['chats:' + acct]: (got['chats:' + acct] || []).filter(c => c.id !== id) });
    await browser.storage.local.remove('chat:' + id);
  });
  histRender();
}

function histClearAll() {
  const acct = histAcct();
  if (histCur && histCur.acct === acct) histBlank();
  histEnqueue(async () => {
    const got = await browser.storage.local.get('chats:' + acct);
    await browser.storage.local.remove(['chats:' + acct, ...(got['chats:' + acct] || []).map(c => 'chat:' + c.id)]);
  });
  $('histConfirm').hidden = true;
  histRender();
}

$('histBtn').addEventListener('click', () => histShow($('histDrawer').hidden));
$('histClose').addEventListener('click', () => histShow(false));
$('histDrawer').addEventListener('keydown', e => { if (e.key === 'Escape') { histShow(false); $('histBtn').focus(); } });
let histSearchTimer = null;
$('histSearch').addEventListener('input', () => { clearTimeout(histSearchTimer); histSearchTimer = setTimeout(histRender, 150); });
$('histClear').addEventListener('click', () => { $('histConfirm').hidden = false; });   // asks first, in the panel's own confirm box (as removing an account does)
$('histConfirmNo').addEventListener('click', () => { $('histConfirm').hidden = true; });
$('histConfirmYes').addEventListener('click', histClearAll);
