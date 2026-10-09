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
  $('updateBtn').hidden = !(s.native === 'connected' && s.canUpdate);
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
  else if (ev.kind === 'meta') m.meta = { model: String(ev.model || ''), effort: String(ev.effort || '') };
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
      if (m.role === 'assistant') fillRich(body, m.text); else body.textContent = m.text;
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
