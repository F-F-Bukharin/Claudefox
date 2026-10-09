'use strict';
// Sidebar panel: three pages (chat, profile, settings).
// Agent state lives in the background page; chat history lives in
// storage.session, so it survives closing the panel and clears when Zen quits.

const $ = id => document.getElementById(id);
const port = browser.runtime.connect({ name: 'panel' });
const send = (type, extra) => port.postMessage(Object.assign({ type }, extra || {}));

let state = {};
let chat = [];
const pendingCalls = new Map();
let callSeq = 1;

// ------------------------------------------------------------ background link

port.onMessage.addListener(msg => {
  if (msg.type === 'state') { state = msg.state; render(msg.state, msg.log); }
  if (msg.type === 'callResult') {
    const done = pendingCalls.get(msg.id);
    if (done) { pendingCalls.delete(msg.id); done(msg); }
  }
  if (msg.type === 'chatEvent') onChatEvent(msg.id, msg.event || {});
  if (msg.type === 'chatDone') onChatDone(msg);
  if (msg.type === 'chatRuns') onChatRuns(msg.ids || []);
});

function call(tool, args) {
  return new Promise(resolve => {
    const id = callSeq++;
    pendingCalls.set(id, resolve);
    send('call', { id, tool, args: args || {} });
  });
}

// ------------------------------------------------------------ page tabs

const PAGES = ['chat', 'profile', 'settings'];
function showPage(name) {
  for (const p of PAGES) $('page-' + p).hidden = p !== name;
  for (const b of document.querySelectorAll('.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.page === name));
  }
  try { browser.storage.session.set({ panelPage: name }); } catch {}
  if (name === 'chat') $('input').focus();
}
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => showPage(b.dataset.page));
}

// ------------------------------------------------------------ buttons

$('signInBtn').addEventListener('click', () => { $('signInBtn').disabled = true; send('signIn'); });
$('signOutBtn').addEventListener('click', () => send('signOut'));
$('openClaude').addEventListener('click', () => send('openClaude'));
$('stopBtn').addEventListener('click', () => send('stop'));
$('startBtn').addEventListener('click', () => send('start'));
$('retryNative').addEventListener('click', () => send('retryNative'));
$('checkClaude').addEventListener('click', () => send('checkClaude'));
$('clearLog').addEventListener('click', () => send('clearLog'));
$('filesToggle').addEventListener('change', e => send('setFiles', { value: e.target.checked }));
$('devPing').addEventListener('click', () => send('devCall', { tool: 'ping' }));
$('devTabs').addEventListener('click', () => send('devCall', { tool: 'tabs_list' }));
$('version').textContent = 'Claude in Zen v' + browser.runtime.getManifest().version;
$('modelBtn').addEventListener('click', () => send('setModel', { value: state.chatModel === 'quality' ? 'speed' : 'quality' }));

// ------------------------------------------------------------ render state

const NATIVE_LABEL = {
  connected: ['ok', 'connected'],
  missing:   ['', 'not installed'],
  error:     ['bad', 'error'],
  unknown:   ['', 'not connected'],
};

function claudeLabel(s) {
  if (s.native !== 'connected') return ['', '—', 'Needs the helper'];
  const c = s.claude;
  if (!c) return ['', 'checking…', ''];
  if (!c.installed) return ['bad', 'not installed', 'Install Claude Code on this PC'];
  if (!c.loggedIn) return ['warn', 'not signed in', 'Run "Sign in Claude Code"'];
  return ['ok', c.email ? `signed in · ${c.email}` : 'signed in', c.plan ? `Plan: ${c.plan}` : ''];
}

function render(s, log) {
  const pill = $('agentPill');
  pill.className = 'pill ' + (s.agent === 'stopped' ? 'stopped' : s.signedIn ? 'active' : '');
  pill.textContent = s.agent === 'stopped' ? 'Stopped' : s.signedIn ? 'Active' : 'Signed out';

  $('stopBtn').hidden = s.agent === 'stopped';
  $('startBtn').hidden = s.agent !== 'stopped';

  // profile
  $('signedOut').hidden = s.signedIn;
  $('signedIn').hidden = !s.signedIn;
  $('signInBtn').disabled = false;
  if (s.signedIn && s.account) {
    const a = s.account;
    const label = a.name || a.email || 'Claude account';
    $('acctName').textContent = label;
    $('acctEmail').textContent = a.email && a.email !== label ? a.email : '';
    $('avatar').textContent = (label.trim()[0] || '?').toUpperCase();
    $('acctSince').textContent = s.signedInAt ? new Date(s.signedInAt).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '—';
    $('acctVia').textContent = a.via || '—';
    $('acctId').textContent = a.uuid ? a.uuid.slice(0, 8) + '…' : '—';
    $('acctId').title = a.uuid || '';
  }

  // settings
  const [cls, text] = NATIVE_LABEL[s.native] || NATIVE_LABEL.unknown;
  $('nativeDot').className = 'dot ' + cls;
  $('nativeVal').textContent = s.native === 'connected' && s.hostVersion ? `${text} · v${s.hostVersion}` : text;
  $('nativeVal').title = s.nativeDetail || '';
  $('retryNative').hidden = s.agent === 'stopped' || s.native === 'connected';

  const [ccls, ctext, ctitle] = claudeLabel(s);
  $('claudeDot').className = 'dot ' + ccls;
  $('claudeVal').textContent = ctext;
  $('claudeVal').title = ctitle;
  $('checkClaude').hidden = s.native !== 'connected';
  const clients = Array.isArray(s.clients) ? s.clients : [];
  $('clientsVal').textContent = clients.length ? clients.join(', ') : 'nobody';
  const on = s.debugPort === 'on';
  $('debugDot').className = 'dot ' + (on ? 'warn' : '');
  $('debugVal').textContent = on ? 'OPEN' : s.debugPort === 'off' ? 'closed' : '…';
  $('debugVal').parentElement.classList.toggle('warn', on);
  $('filesToggle').checked = !!s.filesEnabled;
  $('filesToggle').disabled = s.agent === 'stopped';
  $('pendingVal').textContent = String(s.pending || 0);

  // model choice
  const quality = s.chatModel === 'quality';
  $('modelBtn').textContent = quality ? 'Quality' : 'Speed';
  $('modelBtn').classList.toggle('quality', quality);
  $('modelBtn').title = (quality ? 'Quality: Opus 5.5, high effort. Slower, best answers, uses more.'
    : 'Speed: Haiku 5.5, high effort. Fast and light on usage.') + ' Click to switch.';

  // composer hint
  $('composerHint').textContent =
    s.agent === 'stopped' ? 'Stopped. Press Start to let Claude act again.' :
    !s.signedIn ? 'Not signed in. Open the Profile page to sign in.' :
    'Enter to send · Shift+Enter for a new line';

  renderLog(log || []);
}

function renderLog(log) {
  const ol = $('log');
  ol.textContent = '';
  if (!log.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet.';
    ol.appendChild(li);
    return;
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const span = document.createElement('span');
    span.className = e.kind;
    span.textContent = e.text;
    li.append(t, span);
    ol.appendChild(li);
  }
}

// ------------------------------------------------------------ current tab chip

async function refreshContext() {
  try {
    const [t] = await browser.tabs.query({ active: true, currentWindow: true });
    $('ctxTab').textContent = t ? (t.title || t.url || 'Untitled') : '—';
    $('ctxTab').title = t ? t.url || '' : '';
  } catch { $('ctxTab').textContent = '—'; }
}
browser.tabs.onActivated.addListener(refreshContext);
browser.tabs.onUpdated.addListener((id, info, tab) => { if (tab.active && (info.title || info.url)) refreshContext(); });
refreshContext();

// ------------------------------------------------------------ chat

const input = $('input');
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
$('composer').addEventListener('submit', e => { e.preventDefault(); submit(); });
for (const c of document.querySelectorAll('.chip')) {
  c.addEventListener('click', () => { input.value = c.dataset.fill; autoGrow(); submit(); });
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

let chatSeq = 0;
let liveRuns = null;   // chat ids the background still runs (null until it tells us)

function busyMsg() { return chat.find(m => m.role === 'assistant' && m.pending); }

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  if (busyMsg()) { $('composerHint').textContent = 'Claude is still answering. Wait, or press Cancel.'; return; }
  input.value = ''; autoGrow();
  addMsg({ role: 'user', text });

  if (text.startsWith('/')) return runSlash(text);

  if (state.agent === 'stopped') return addMsg({ role: 'system', text: 'Claude is stopped. Press Start (top right) first.' });
  if (!state.signedIn) return addMsg({ role: 'system', text: 'Sign in first: Profile page → Sign in with Claude.' });
  const id = `p${Date.now().toString(36)}${chatSeq++}`;
  addMsg({ role: 'assistant', id, text: '', steps: [], pending: true });
  send('chat', { id, text });
}

async function runSlash(text) {
  const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
  if (cmd === 'help') {
    return addMsg({ role: 'assistant', text: 'Type normally to talk to Claude. It can read and act on your tabs.\n\nTest commands (no Claude needed):\n/tabs: list your open tabs\n/ping: check the add-on answers\n/clear: clear this chat and start a new conversation' });
  }
  if (cmd === 'clear') { chat = []; saveChat(); send('newChat'); return renderChat(); }
  const tool = { tabs: 'tabs_list', ping: 'ping' }[cmd];
  if (!tool) return addMsg({ role: 'error', text: `Unknown command /${cmd}. Try /help.` });
  const out = await call(tool);
  if (!out.ok) return addMsg({ role: 'error', text: out.error });
  if (tool === 'ping') return addMsg({ role: 'assistant', text: `Pong. Add-on v${out.result.version} is answering.` });
  addMsg({ role: 'assistant', text: `You have ${out.result.length} tab${out.result.length === 1 ? '' : 's'} open:`, tabs: out.result.slice(0, 50) });
}

// ------------------------------------------------------------ chat stream

function onChatEvent(id, ev) {
  const m = chat.find(x => x.id === id);
  if (!m || !m.pending) return;
  if (ev.kind === 'text') m.text += String(ev.text || '');
  else if (ev.kind === 'tool') {
    m.steps.push({ name: String(ev.name || 'tool'), input: String(ev.input || ''), state: 'run' });
    if (m.steps.length > 30) m.steps.splice(0, m.steps.length - 30);
  } else if (ev.kind === 'tool_result') {
    const step = m.steps.find(st => st.state === 'run');
    if (step) { step.state = ev.error ? 'bad' : 'ok'; step.result = String(ev.text || ''); }
  }
  scheduleRender();
}

function onChatDone(msg) {
  const m = chat.find(x => x.id === msg.id);
  if (!m) return;
  m.pending = false;
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

function renderChat() {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  for (const el of box.querySelectorAll('.msg')) el.remove();
  $('emptyState').hidden = chat.length > 0;
  for (const m of chat) {
    const div = document.createElement('div');
    div.className = 'msg ' + m.role + (m.pending ? ' pending' : '');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = WHO[m.role] || '';
    div.appendChild(who);

    if (Array.isArray(m.steps) && m.steps.length) {
      const ul = document.createElement('ul');
      ul.className = 'steps';
      for (const st of m.steps) {
        const li = document.createElement('li');
        li.className = 'step ' + st.state;
        const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = STEP_MARK[st.state] || '';
        const name = document.createElement('span'); name.className = 'name'; name.textContent = st.name;
        li.append(mark, name);
        li.title = [st.input && `Input: ${st.input}`, st.result && `Result: ${st.result}`].filter(Boolean).join('\n');
        ul.appendChild(li);
      }
      div.appendChild(ul);
    }

    if (m.text || !m.pending) {
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = m.text;
      if (m.text) div.appendChild(body);
    }
    if (m.pending) {
      const row = document.createElement('div');
      row.className = 'working';
      const dots = document.createElement('span'); dots.className = 'dots'; dots.textContent = m.text ? '' : 'Thinking';
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
        div.appendChild(hint);
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
    box.appendChild(div);
  }
  if (atBottom || busyMsg()) box.scrollTop = box.scrollHeight;
  $('sendBtn').disabled = !!busyMsg();
}

// ------------------------------------------------------------ restore

(async () => {
  try {
    const got = await browser.storage.session.get(['chat', 'panelPage']);
    chat = Array.isArray(got.chat) ? got.chat : [];
    if (liveRuns) onChatRuns([...liveRuns]);
    renderChat();
    showPage(PAGES.includes(got.panelPage) ? got.panelPage : 'chat');
  } catch { renderChat(); showPage('chat'); }
})();
