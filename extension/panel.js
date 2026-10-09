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
$('clearLog').addEventListener('click', () => send('clearLog'));
$('filesToggle').addEventListener('change', e => send('setFiles', { value: e.target.checked }));
$('devPing').addEventListener('click', () => send('devCall', { tool: 'ping' }));
$('devTabs').addEventListener('click', () => send('devCall', { tool: 'tabs_list' }));
$('version').textContent = 'Claude in Zen v' + browser.runtime.getManifest().version;

// ------------------------------------------------------------ render state

const NATIVE_LABEL = {
  connected: ['ok', 'connected'],
  missing:   ['', 'not installed'],
  error:     ['bad', 'error'],
  unknown:   ['', 'not connected'],
};

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
  $('nativeVal').textContent = text;
  $('nativeVal').title = s.nativeDetail || '';
  $('retryNative').hidden = s.agent === 'stopped' || s.native === 'connected';
  const on = s.debugPort === 'on';
  $('debugDot').className = 'dot ' + (on ? 'warn' : '');
  $('debugVal').textContent = on ? 'OPEN' : s.debugPort === 'off' ? 'closed' : '…';
  $('debugVal').parentElement.classList.toggle('warn', on);
  $('filesToggle').checked = !!s.filesEnabled;
  $('filesToggle').disabled = s.agent === 'stopped';
  $('pendingVal').textContent = String(s.pending || 0);

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

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; autoGrow();
  addMsg({ role: 'user', text });

  if (text.startsWith('/')) return runSlash(text);

  if (state.agent === 'stopped') return addMsg({ role: 'system', text: 'Claude is stopped. Press Start (top right) first.' });
  if (!state.signedIn) return addMsg({ role: 'system', text: 'Sign in first: Profile page → Sign in with Claude.' });
  addMsg({ role: 'assistant', text: "I'm not connected to Claude yet. The chat link comes in the next build phase.\nFor now, try /tabs, /ping or /help." });
}

async function runSlash(text) {
  const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
  if (cmd === 'help') {
    return addMsg({ role: 'assistant', text: 'Test commands:\n/tabs: list your open tabs\n/ping: check the add-on answers\n/clear: clear this chat\n\nThey run through the same path Claude will use, so they need sign-in and Start.' });
  }
  if (cmd === 'clear') { chat = []; saveChat(); return renderChat(); }
  const tool = { tabs: 'tabs_list', ping: 'ping' }[cmd];
  if (!tool) return addMsg({ role: 'error', text: `Unknown command /${cmd}. Try /help.` });
  const out = await call(tool);
  if (!out.ok) return addMsg({ role: 'error', text: out.error });
  if (tool === 'ping') return addMsg({ role: 'assistant', text: `Pong. Add-on v${out.result.version} is answering.` });
  addMsg({ role: 'assistant', text: `You have ${out.result.length} tab${out.result.length === 1 ? '' : 's'} open:`, tabs: out.result.slice(0, 50) });
}

function addMsg(m) {
  chat.push(Object.assign({ t: Date.now() }, m));
  if (chat.length > 200) chat.splice(0, chat.length - 200);
  saveChat();
  renderChat();
}

function saveChat() { try { browser.storage.session.set({ chat }); } catch {} }

const WHO = { user: 'You', assistant: 'Claude', system: 'Claude in Zen', error: 'Claude in Zen' };

function renderChat() {
  const box = $('messages');
  for (const el of box.querySelectorAll('.msg')) el.remove();
  $('emptyState').hidden = chat.length > 0;
  for (const m of chat) {
    const div = document.createElement('div');
    div.className = 'msg ' + m.role;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = WHO[m.role] || '';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.text;
    div.append(who, body);
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
  box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------ restore

(async () => {
  try {
    const got = await browser.storage.session.get(['chat', 'panelPage']);
    chat = Array.isArray(got.chat) ? got.chat : [];
    renderChat();
    showPage(PAGES.includes(got.panelPage) ? got.panelPage : 'chat');
  } catch { renderChat(); showPage('chat'); }
})();
