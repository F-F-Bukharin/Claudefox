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
  if (msg.type === 'fileCreated') onFileCreated(msg.file || {});
});

// Links in replies: web pages open in a new tab, zen://tab/<id> switches tab, zen://file/<id> opens a file.
function onLink(kind, value) {
  if (kind === 'tab') send('openTab', { id: Number(value) });
  else if (kind === 'file') send('openFile', { id: value });
  else send('openLink', { url: value });
}

function onFileCreated(f) {
  const m = chat.find(x => x.id === f.msg) || [...chat].reverse().find(x => x.role === 'assistant' && x.pending);
  if (!m) return;
  m.files = (m.files || []).filter(x => x.id !== f.id).concat([{ id: f.id, name: f.name, size: f.size, title: f.title || '' }]);
  saveChat();
  renderChat();
}

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
  placeThumb();
}
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => showPage(b.dataset.page));
}

// The highlight behind the top tabs slides from one tab to the next (CSS: .tab-thumb). The first
// placement is instant, so the panel does not slide in when it opens.
let thumbReady = false;
function placeThumb() {
  const thumb = $('tabThumb');
  const on = document.querySelector('.tabs button[aria-selected="true"]');
  if (!thumb || !on || !on.offsetWidth) return;   // not laid out yet (panel hidden): the next resize places it
  thumb.classList.toggle('animate', thumbReady);
  thumb.style.width = on.offsetWidth + 'px';
  thumb.style.transform = 'translateX(' + on.offsetLeft + 'px)';
  thumbReady = true;
}
window.addEventListener('resize', placeThumb);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeThumb);

// ------------------------------------------------------------ buttons

$('signInBtn').addEventListener('click', () => { $('signInBtn').disabled = true; send('signIn'); });
$('signOutBtn').addEventListener('click', () => send('signOut'));
$('openClaude').addEventListener('click', () => send('openClaude'));
$('stopBtn').addEventListener('click', () => send('stop'));
$('startBtn').addEventListener('click', () => send('start'));
$('retryNative').addEventListener('click', () => send('retryNative'));
$('checkClaude').addEventListener('click', () => send('checkClaude'));
$('switchClaude').addEventListener('click', () => send('switchAccount'));
$('updateBtn').addEventListener('click', () => send('updateAddon'));
$('clearLog').addEventListener('click', () => send('clearLog'));
const filesMode = () => (state.filesMode === 'write' ? 'write' : 'read');
$('filesToggle').addEventListener('change', e => send('setFiles', { value: e.target.checked, mode: filesMode(), folder: $('filesFolder').value }));
$('filesFolder').addEventListener('change', e => send('setFiles', { value: !!state.filesEnabled, mode: filesMode(), folder: e.target.value }));
$('filesFolder').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
for (const b of document.querySelectorAll('.seg button')) {
  b.addEventListener('click', () => send('setFiles', { value: !!state.filesEnabled, mode: b.dataset.mode, folder: $('filesFolder').value }));
}
$('devPing').addEventListener('click', () => send('devCall', { tool: 'ping' }));
$('devTabs').addEventListener('click', () => send('devCall', { tool: 'tabs_list' }));
$('version').textContent = 'Claude in Zen v' + browser.runtime.getManifest().version;
$('modelBtn').addEventListener('click', () => send('setModel', { value: state.chatModel === 'quality' ? 'speed' : 'quality' }));
$('plusBtn').addEventListener('click', () => send('setPlus', { value: !state.chatPlus }));

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
  if (s.switching) return ['warn', 'switching… finish in the sign-in window', ''];
  const plan = c.plan ? `Plan: ${c.plan}. ` : '';
  const zen = s.account && s.account.email;
  if (zen && c.email && zen.toLowerCase() !== c.email.toLowerCase()) {
    return ['warn', `signed in · ${c.email} (not ${zen})`, `${plan}The chat spends this Claude Code account, which differs from the claude.ai account signed in to Zen.`];
  }
  return ['ok', c.email ? `signed in · ${c.email}` : 'signed in', `${plan}The chat spends this account.`];
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
  const installed = browser.runtime.getManifest().version;
  const src = s.native === 'connected' ? s.sourceVersion : '';
  const newer = src && cmpVersion(src, installed) > 0;
  $('addonVal').textContent = `v${installed}` + (s.linked && s.native === 'connected' ? ' · linked to project folder'
    : src ? (newer ? ` · v${src} ready` : ' · up to date') : '');
  $('addonVal').parentElement.classList.toggle('warn', !!newer);
  // Up to date and not linked: a reinstall would change nothing, so there is no button, just the way to
  // get one-click updates. Linked: "update" reloads from the folder. Newer source: install it.
  $('updateBtn').hidden = !(s.native === 'connected' && s.canUpdate && (s.linked || newer));
  const note = s.updateNote || (s.native === 'connected' && s.canUpdate && !s.linked
    ? 'For one-click updates: close Zen, run "Link add-on to Zen.bat" once, start Zen. After that, update just reloads.' : '');
  $('updateNote').textContent = note;
  $('updateNote').hidden = !note;
  $('updateBtn').disabled = !!s.updating;
  $('updateBtn').textContent = s.updating ? 'building…' : s.linked ? 'update' : newer ? `update to v${src}` : 'reinstall';
  $('updateBtn').title = s.linked ? 'Reload the add-on and helper from your project folder (no install, no restart)'
    : 'Rebuild the add-on from your project folder and install it in Zen';
  $('retryNative').hidden = s.agent === 'stopped' || s.native === 'connected';

  const [ccls, ctext, ctitle] = claudeLabel(s);
  $('claudeDot').className = 'dot ' + ccls;
  $('claudeVal').textContent = ctext;
  $('claudeVal').title = ctitle;
  $('checkClaude').hidden = s.native !== 'connected';
  $('switchClaude').hidden = s.native !== 'connected' || s.agent === 'stopped' || !!s.switching || !(s.claude && s.claude.installed);
  const clients = Array.isArray(s.clients) ? s.clients : [];
  $('clientsVal').textContent = clients.length ? clients.join(', ') : 'nobody';
  const on = s.debugPort === 'on';
  $('debugDot').className = 'dot ' + (on ? 'warn' : '');
  $('debugVal').textContent = on ? 'OPEN' : s.debugPort === 'off' ? 'closed' : '…';
  $('debugVal').parentElement.classList.toggle('warn', on);
  $('filesToggle').checked = !!s.filesEnabled;
  if (document.activeElement !== $('filesFolder')) $('filesFolder').value = s.filesFolder || '';
  $('filesFolder').disabled = s.agent === 'stopped';
  for (const b of document.querySelectorAll('.seg button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === (s.filesMode === 'write' ? 'write' : 'read')));
    b.disabled = s.agent === 'stopped';
  }
  $('filesNote').textContent = !s.filesEnabled
    ? 'Off. Claude has no file access. Type a full folder path, then turn it on.'
    : s.filesMode === 'write'
      ? 'On: Claude can read, create and change files in this folder only. There is no undo, so use a folder you can afford to lose. No shell.'
      : 'On: Claude can read and search files in this folder only. No changes, no shell.';
  $('filesNote').classList.toggle('warnnote', !!s.filesEnabled && s.filesMode === 'write');
  $('filesToggle').disabled = s.agent === 'stopped';
  $('pendingVal').textContent = String(s.pending || 0);

  // model choice
  const quality = s.chatModel === 'quality';
  const plus = !quality && !!s.chatPlus;
  $('modelBtn').textContent = quality ? 'Quality' : 'Speed';
  $('modelBtn').classList.toggle('quality', quality);
  $('modelBtn').classList.toggle('plus', plus);
  $('modelBtn').title = (quality ? 'Quality: Opus 5.5, high effort. Slower, best answers, uses more.'
    : plus ? 'Speed Plus: Haiku 5.5, max effort.' : 'Speed: Haiku 5.5, high effort. Fast and light on usage.') + ' Click to switch to ' + (quality ? 'Speed.' : 'Quality.');
  $('plusBtn').hidden = quality;
  $('plusBtn').classList.toggle('on', plus);
  $('plusBtn').setAttribute('aria-pressed', String(plus));

  // composer hint: what the next message runs on
  $('composerHint').textContent =
    s.agent === 'stopped' ? 'Stopped. Press Start to let Claude act again.' :
    !s.signedIn ? 'Not signed in. Open the Profile page to sign in.' :
    quality ? 'Opus 5.5 · high effort' : plus ? 'Haiku 5.5 · max effort' : 'Haiku 5.5 · high effort';
  $('composerHint').title = 'Enter to send · Shift+Enter for a new line';

  renderLog(log || []);
  renderSetup(s);
  if (chat.some(m => m.limit)) renderChat();   // the switch button follows state.switching
}

// First-run guide: the real setup state, in order, with the next action for each open step.
function renderSetup(s) {
  const c = s.claude || {};
  const steps = [
    { done: s.native === 'connected', title: 'Install the helper',
      hint: 'Install Node.js if you don\u2019t have it, then double-click "Install helper.bat" in the Claude in Zen folder.',
      action: s.agent === 'active' && s.native !== 'connected' ? ['Retry', () => send('retryNative')] : null },
    { done: !!c.installed, title: 'Install Claude Code',
      hint: 'Install it from code.claude.com/docs/en/setup, then press Retry.',
      action: s.native === 'connected' ? ['Retry', () => send('checkClaude')] : null },
    { done: !!c.loggedIn, title: 'Sign Claude Code in',
      hint: 'Double-click "Sign in Claude Code.bat" and click Authorize. The chat uses this account.',
      action: c.installed ? ['Open sign-in', () => send('switchAccount')] : null },
    { done: !!s.signedIn, title: 'Sign in to claude.ai in the panel',
      hint: 'Sign in to claude.ai in a normal tab, then press Sign in. Zen remembers it after that.',
      action: ['Sign in', () => send('signIn')] },
  ];
  const ready = steps.every(st => st.done);
  const ol = $('setup');
  ol.hidden = ready;
  $('emptyTitle').textContent = ready ? 'What should I do in Zen?' : 'Almost ready';
  $('emptyText').textContent = ready ? 'Ask me to read, summarize or do things in your tabs.'
    : `${steps.filter(st => st.done).length} of ${steps.length} setup steps done. /tabs and /ping work without Claude.`;
  if (s.agent === 'stopped') $('emptyText').textContent = 'Stopped. Press Start (top right) to let Claude act again.';
  ol.textContent = '';
  if (ready) return;
  const current = steps.findIndex(st => !st.done);
  steps.forEach((st, i) => {
    const li = document.createElement('li');
    li.className = 'step-row' + (st.done ? ' done' : i === current ? ' current' : '');
    const mark = document.createElement('span'); mark.className = 'tick'; mark.textContent = st.done ? '✓' : String(i + 1);
    const box = document.createElement('div'); box.className = 'step-text';
    const t = document.createElement('div'); t.className = 'step-title'; t.textContent = st.title;
    box.appendChild(t);
    if (!st.done && i === current) {
      const h = document.createElement('div'); h.className = 'step-hint'; h.textContent = st.hint;
      box.appendChild(h);
      if (st.action) {
        const b = document.createElement('button'); b.className = 'ghost step-btn'; b.textContent = st.action[0];
        b.addEventListener('click', st.action[1]);
        box.appendChild(b);
      }
    }
    li.append(mark, box);
    ol.appendChild(li);
  });
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

function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// "claude-haiku-5-5" -> "Haiku 5.5"
function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(String(id || ''));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : String(id || '');
}

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
  addMsg({ role: 'assistant', id, text: '', steps: [], pending: true, startedAt: Date.now() });
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
  else if (ev.kind === 'meta') m.meta = { model: String(ev.model || ''), effort: String(ev.effort || '') };
  else if (ev.kind === 'status') m.status = String(ev.status || '');
  else if (ev.kind === 'stats') m.stats = { ms: Number(ev.ms) || 0, turns: Number(ev.turns) || 0 };
  else if (ev.kind === 'progress') {
    const steps = Array.isArray(ev.steps) && ev.steps.length ? ev.steps : (m.plan && m.plan.steps) || [];
    m.plan = { steps, done: Number(ev.done) || 0, note: String(ev.note || ''), at: m.steps.length };
  }
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
  Grep: 'Searching files', Edit: 'Editing a file', Write: 'Saving a file',
};

// What the current step is doing, in words: "Searching the web: niche tamagotchi repair".
function stepLabel(st) {
  const verb = VERB[st.name] || `Using ${st.name}`;
  let inp = {};
  try { inp = JSON.parse(st.input || '{}'); } catch {}
  let what = inp.query || inp.name || inp.text || inp.key || '';
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
    t.addEventListener('click', () => { if (open) expandedSteps.delete(m.id); else expandedSteps.add(m.id); lastChatSig = ''; renderChat(); });
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

const FILE_ICON = { md: 'MD', html: 'HTML', htm: 'HTML', csv: 'CSV', json: 'JSON', svg: 'SVG', txt: 'TXT', doc: 'DOC' };
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

let lastChatSig = '';

function renderChat() {
  // Rebuilding the list clears any text the user has selected, so only rebuild when something changed.
  const sig = JSON.stringify(chat) + '|' + (state.switching ? 1 : 0);
  if (sig === lastChatSig) return;
  lastChatSig = sig;
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

    if (m.role === 'assistant' && Array.isArray(m.steps)) {
      const pb = progressBlock(m);
      if (pb) div.appendChild(pb);
    }

    if (m.text || !m.pending) {
      const body = document.createElement('div');
      body.className = 'body';
      if (m.role === 'assistant') { body.classList.add('md'); cizMarkdown(body, m.text, onLink); } else body.textContent = m.text;
      if (m.text) div.appendChild(body);
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
    if (Array.isArray(m.files) && m.files.length) {
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
