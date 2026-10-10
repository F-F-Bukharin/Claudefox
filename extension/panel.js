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
  if (msg.type === 'snap') onSnap(msg);
  if (msg.type === 'toolResult') onToolResult(msg);
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
$('switchClaude').addEventListener('click', () => {
  showPage('profile');
  const group = $('accountsGroup');
  if (group.scrollIntoView) group.scrollIntoView({ block: 'start' });
});
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
// Dark mode: the switch at the top of Settings. theme.js applies the saved choice before the first paint; this keeps it.
function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('ciz-theme', dark ? 'dark' : 'light'); } catch {}
}
$('themeToggle').checked = document.documentElement.dataset.theme === 'dark';
$('themeToggle').addEventListener('change', e => setTheme(e.target.checked));
$('version').textContent = 'Claude in Zen v' + browser.runtime.getManifest().version;
// One button flips Speed and Quality. The + on its left (Speed mode only) turns Speed Plus (Haiku at max effort) on and off.
function toggleMode() {
  send('setModel', { value: state.chatModel === 'quality' ? 'speed' : 'quality' });
}
function togglePlus() {
  send('setPlus', { value: !state.chatPlus });
}
$('modeBtn').addEventListener('click', toggleMode);
$('plusBtn').addEventListener('click', togglePlus);

// Tools and plugins (Settings). Switches, sign-in, add and remove go to the helper through the background page.
$('toolsCheck').addEventListener('click', () => send('toolsCheck'));
$('addBtn').addEventListener('click', () => {
  const name = $('addName').value.trim(), target = $('addTarget').value.trim();
  if (!name || !target) { $('addName').focus(); return; }
  const local = !/^https?:\/\//i.test(target);
  const go = () => send('toolAdd', { name, target, header: $('addHeader').value.trim(), on: true });
  if (local) askConfirm(`${name} runs a program on this PC with your permissions. A web page could try to trick Claude into using it. Add it and turn it on?`, go, 'Add and turn on');
  else go();
});
$('pluginBtn').addEventListener('click', () => {
  const spec = $('pluginSpec').value.trim();
  if (!spec) { $('pluginSpec').focus(); return; }
  send('pluginInstall', { spec, source: $('pluginSource').value.trim() });
});
let confirmAction = null;
function askConfirm(text, action, yes) {
  confirmAction = action;
  $('toolConfirmText').textContent = text;
  $('toolYes').textContent = yes || 'Turn on';
  $('toolConfirm').hidden = false;
  if ($('toolConfirm').scrollIntoView) $('toolConfirm').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
$('toolYes').addEventListener('click', () => { $('toolConfirm').hidden = true; const a = confirmAction; confirmAction = null; if (a) a(); });
$('toolNo').addEventListener('click', () => { $('toolConfirm').hidden = true; confirmAction = null; lastToolsSig = ''; render(state, null); });

function onToolResult(m) {
  if (m.action === 'add' && m.ok) { $('addName').value = ''; $('addTarget').value = ''; $('addHeader').value = ''; }
  if (m.action === 'install' && m.ok) { $('pluginSpec').value = ''; $('pluginSource').value = ''; }
}

// Unsafe mode: turning it on asks first (the confirm box). Turning it off needs no question.
$('unsafeToggle').addEventListener('change', e => {
  if (e.target.checked) { e.target.checked = false; $('unsafeConfirm').hidden = false; }
  else send('setUnsafe', { value: false });
});
$('unsafeYes').addEventListener('click', () => { $('unsafeConfirm').hidden = true; send('setUnsafe', { value: true }); });
$('unsafeNo').addEventListener('click', () => { $('unsafeConfirm').hidden = true; $('unsafeToggle').checked = !!state.unsafe; });

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
  $('nativeDetail').textContent = s.native === 'connected' ? '' : (s.nativeDetail || '');
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
  $('updateBtn').textContent = s.updating ? 'Building…' : s.linked ? 'Update' : newer ? `Update to v${src}` : 'Reinstall';
  $('updateBtn').title = s.linked ? 'Reload the add-on and helper from your project folder (no install, no restart)'
    : 'Rebuild the add-on from your project folder and install it in Zen';
  $('retryNative').hidden = s.agent === 'stopped' || s.native === 'connected';

  const [ccls, ctext, ctitle] = claudeLabel(s);
  $('claudeDot').className = 'dot ' + ccls;
  $('claudeVal').textContent = ctext;
  $('claudeDetail').textContent = ctitle;
  $('checkClaude').hidden = s.native !== 'connected';
  $('switchClaude').hidden = s.native !== 'connected';
  const clients = Array.isArray(s.clients) ? s.clients : [];
  $('clientsVal').textContent = clients.length ? clients.join(', ') : 'nobody';
  const on = s.debugPort === 'on';
  $('debugDot').className = 'dot ' + (on ? 'warn' : '');
  $('debugVal').textContent = on ? 'OPEN' : s.debugPort === 'off' ? 'closed' : '…';
  $('debugVal').parentElement.classList.toggle('warn', on);
  // unsafe mode (session only; Stop and a restart turn it off)
  $('unsafeBadge').hidden = !s.unsafe;
  $('unsafeToggle').checked = !!s.unsafe;
  $('unsafeToggle').disabled = s.agent === 'stopped';
  if (s.unsafe) $('unsafeConfirm').hidden = true;
  $('unsafeNote').textContent = s.unsafe
    ? 'On. Claude may act on Google sign-in pages until you press Stop or restart Zen.'
    : 'Off. Claude does not act on Google sign-in pages.';
  $('googleVal').textContent = s.unsafe ? 'allowed (Unsafe mode)' : 'always hands-off';
  $('googleVal').classList.toggle('warn', !!s.unsafe);
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

  // model choice: one button shows Speed or Quality (a click flips it), and the + (Speed mode only) turns Speed Plus on
  const quality = s.chatModel === 'quality';
  const plus = !quality && !!s.chatPlus;
  $('modeSeg').dataset.mode = quality ? 'quality' : 'speed';
  $('modeLabel').textContent = quality ? 'Quality' : 'Speed';
  $('modeBtn').setAttribute('aria-label', quality ? 'Quality. Switch to Speed.' : 'Speed. Switch to Quality.');
  $('plusBtn').setAttribute('aria-pressed', String(plus));
  $('plusBtn').hidden = quality;
  // the line under the outputs: what the next message runs on
  $('modelLine').textContent = (quality ? 'Opus 5.5 · high effort' : plus ? 'Haiku 5.5 · max effort' : 'Haiku 5.5 · high effort')
    + (s.caveman && s.agent !== 'stopped' && s.signedIn ? ' · caveman' : '');

  // notice under the composer: why nothing will run right now
  $('composerHint').textContent =
    s.agent === 'stopped' ? 'Stopped. Press Start to let Claude act again.' :
    !s.signedIn ? 'Not signed in. Open the Profile page to sign in.' : '';

  // caveman mode (the + menu)
  const cave = document.querySelector('#moreMenu [data-act="caveman"]');
  cave.setAttribute('aria-checked', String(!!s.caveman));
  $('moreBtn').classList.toggle('on', !!s.caveman);

  renderTools(s);
  if (log) renderLog(log);
  renderSetup(s);
  renderAccounts(s);
  if (chat.some(m => m.limit)) renderChat();   // the switch button follows state.switching
}

// ------------------------------------------------------------ accounts (Profile)
// Every Claude account the chat can use: one card each. Use switches the chat to it; Add account opens a sign-in
// window; Remove asks inside that account's own card first. background.js relays these to the helper (accounts).
$('accountAdd').addEventListener('click', () => send('accountAdd'));
$('acctLoginCancel').addEventListener('click', () => send('accountCancel'));
function actBtn(text, cls, fn, disabled) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.disabled = !!disabled;
  b.addEventListener('click', fn);
  return b;
}
function accountCard(a, s) {
  const who = a.email || 'Claude account';
  const card = el('section', 'card acctcard' + (a.loggedIn ? '' : ' off'));
  const txt = el('div', 'who');
  txt.append(el('div', 'name', who), el('div', 'muted', [a.plan && `${a.plan} plan`, a.org, a.loggedIn ? '' : 'signed out'].filter(Boolean).join(' · ')));
  const head = el('div', 'acct');
  head.append(el('div', 'avatar', who.trim()[0].toUpperCase()), txt);
  const stopped = s.agent === 'stopped';
  const acts = el('div', 'aacts');
  if (a.active) acts.appendChild(el('span', 'pill active', 'In use'));
  else acts.appendChild(actBtn(a.id === s.accountBusy ? 'Switching…' : a.loggedIn ? 'Use' : 'Sign in', 'primary', () => send(a.loggedIn ? 'accountUse' : 'accountSignIn', { id: a.id }), stopped || !!s.accountBusy));
  const confirm = el('div', 'confirm');
  confirm.hidden = true;
  const answers = el('div', 'confirm-btns');
  answers.append(
    actBtn('Cancel', 'ghost', () => { confirm.hidden = true; }),
    actBtn('Remove', 'primary', () => { confirm.hidden = true; send('accountRemove', { id: a.id }); }));
  confirm.append(el('p', '', `Remove ${who} from Claude in Zen? You can add it again later.`), answers);
  if (!a.active) acts.appendChild(actBtn('Remove', 'ghost', () => { confirm.hidden = false; }, stopped || !!s.accountBusy));
  card.append(head, acts, confirm);
  return card;
}
function renderAccounts(s) {
  const accts = Array.isArray(s.accounts) ? s.accounts : [];
  const busy = !!s.accountLogin;
  const moving = accts.find(a => a.id === s.accountBusy);
  const inUse = accts.find(a => a.active);
  const line = $('acctChat');
  const addon = s.account && s.account.email;
  const differs = !!(inUse && inUse.email && addon && addon.toLowerCase() !== inUse.email.toLowerCase());
  line.textContent = moving ? `Switching the chat to ${moving.email || 'that account'}…`
    : differs ? `The chat uses ${inUse.email}. The add-on is still signed in to claude.ai as ${addon}; sign out of claude.ai and back in as ${inUse.email}, and the add-on follows.`
    : inUse ? `The chat uses ${inUse.email || 'this account'}.` : '';
  line.hidden = !line.textContent;
  const result = s.accountNote;
  $('acctNote').textContent = result ? result.text : '';
  $('acctNote').className = 'note ' + (result && result.ok ? 'good' : 'bad');
  $('acctNote').hidden = !result;
  const list = $('acctList');
  list.textContent = '';
  for (const a of accts) list.appendChild(accountCard(a, s));
  const note = s.native !== 'connected' ? 'Connect the helper to see your accounts.' : accts.length ? '' : 'No accounts yet. Add one to start.';
  $('acctEmpty').textContent = note;
  $('acctEmpty').hidden = !note;
  $('acctLogin').hidden = !busy;
  $('accountAdd').disabled = s.native !== 'connected' || s.agent === 'stopped' || busy || !!s.accountBusy;
  $('accountAdd').textContent = busy ? 'Waiting for the sign-in window…' : 'Add account';
}

// Settings sections that start closed: Tools and plugins, and Advanced (Panel, Developer, Action log).
function setSection(headId, bodyId, open) {
  $(bodyId).hidden = !open;
  $(headId).setAttribute('aria-expanded', String(!!open));
}
$('toolsHead').addEventListener('click', () => setSection('toolsHead', 'toolsBody', $('toolsBody').hidden));
$('advancedHead').addEventListener('click', () => setSection('advancedHead', 'advancedBody', $('advancedBody').hidden));

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

// ------------------------------------------------------------ tools and plugins (Settings)

let lastToolsSig = '';
let toolsAsked = false;
const STATUS_TEXT = {
  connected: ['ok', 'ready'], 'needs-auth': ['warn', 'needs sign-in'], failed: ['bad', 'not answering'],
  'not-configured': ['', 'not set up'], pending: ['', 'waiting'], unknown: ['', ''], none: ['', ''],
};

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function renderTools(s) {
  const t = s.tools;
  const sig = JSON.stringify([t, s.native, s.agent, s.toolLogin]);
  if (sig === lastToolsSig) return;
  lastToolsSig = sig;
  const box = $('toolsList');
  box.textContent = '';
  $('toolsCheck').hidden = s.native !== 'connected';
  if (s.native !== 'connected') { $('toolsSummary').textContent = ''; box.appendChild(el('div', 'tempty', 'Connect the helper to see your tools and plugins.')); return; }
  if (!t) {
    box.appendChild(el('div', 'tempty', 'Looking for your tools…'));
    if (!toolsAsked) { toolsAsked = true; send('tools'); }
    return;
  }
  const onCount = [...t.plugins, ...t.connectors, ...t.added].filter(x => x.on).length;
  $('toolsSummary').textContent = onCount ? `${onCount} on` : '';
  $('toolsCheck').textContent = t.busy === 'checking' ? 'checking…' : 'check';
  $('toolsCheck').disabled = !!t.busy;
  const groups = [
    ['Recommended', t.plugins.filter(p => p.recommended).map(item => ({ kind: 'plugin', item }))],
    ['Plugins', t.plugins.filter(p => !p.recommended).map(item => ({ kind: 'plugin', item }))],
    ['claude.ai connectors', t.connectors.map(item => ({ kind: 'server', item }))],
    ['Added by you', t.added.map(item => ({ kind: 'server', item }))],
  ];
  for (const [title, rows] of groups) {
    if (!rows.length && title !== 'claude.ai connectors') continue;
    box.appendChild(el('div', 'tgroup', title));
    if (!rows.length) { box.appendChild(el('div', 'tempty', t.checked ? 'None on this account.' : 'Press check to list them.')); continue; }
    for (const r of rows) box.appendChild(toolRow(r.kind, r.item, s));
  }
  if (t.busy && t.busy !== 'checking') box.appendChild(el('div', 'tempty', `${t.busy[0].toUpperCase()}${t.busy.slice(1)}…`));
}

function toolRow(kind, item, s) {
  const row = el('div', 'trow' + (item.on ? ' on' : ''));
  const sw = el('input');
  sw.type = 'checkbox'; sw.className = 'switch'; sw.checked = !!item.on; sw.disabled = s.agent === 'stopped';
  sw.setAttribute('aria-label', `Use ${item.label} in the chat`);
  const id = kind === 'plugin' ? item.id : item.name;
  sw.addEventListener('change', () => {
    if (sw.checked && item.local) {
      sw.checked = false;
      askConfirm(`${item.label} runs programs on this PC with your permissions. A web page could try to trick Claude into using it. Turn it on only if you need it.`,
        () => send('toolSet', { kind, id, value: true, label: item.label }));
      return;
    }
    send('toolSet', { kind, id, value: sw.checked, label: item.label });
  });
  const info = el('div', 'tinfo');
  const name = el('div', 'tname', item.label);
  if (item.recommended) name.appendChild(el('span', 'tag star', 'essential'));
  if (item.local) name.appendChild(el('span', 'tag warn', 'runs on this PC'));
  const sub = [];
  if (kind === 'plugin') {
    if (item.version && item.version !== 'unknown') sub.push('v' + item.version);
    if (item.skills) sub.push('skills');
    if (item.servers.length) sub.push(`${item.servers.length} tool server${item.servers.length === 1 ? '' : 's'}`);
    sub.push(item.scope === 'synced' ? 'from claude.ai' : 'installed here');
  } else sub.push(item.transport === 'stdio' ? `command: ${item.target}` : String(item.target || '').replace(/^https?:\/\//, ''));
  const subline = el('div', 'tsub', sub.filter(Boolean).join(' · '));
  info.append(name, subline);
  info.title = item.description || item.detail || '';
  const stat = el('div', 'tstat');
  const [cls, text] = STATUS_TEXT[item.status] || ['', ''];
  if (text) {
    const st = el('span', 'st ' + cls);
    if (cls) st.appendChild(el('span', 'dot ' + cls));
    st.appendChild(document.createTextNode(text));
    if (item.detail) st.title = item.detail;
    stat.appendChild(st);
  }
  // Sign in: the server of this row (or the plugin's first server that needs it).
  const signName = kind === 'plugin' ? ((item.servers.find(x => x.status === 'needs-auth') || {}).name || '') : item.status === 'needs-auth' ? item.name : '';
  const login = s.toolLogin;
  if (login && signName && login.name === signName) {
    stat.appendChild(el('span', 'st warn', 'signing in…'));
    const c = el('button', 'link', 'cancel'); c.addEventListener('click', () => send('toolCancel')); stat.appendChild(c);
  } else if (signName) {
    const b = el('button', 'link', 'sign in');
    b.addEventListener('click', () => send('toolSignIn', { name: signName }));
    b.disabled = !!login;
    stat.appendChild(b);
  }
  if (kind === 'server' && item.target && !item.name.startsWith('claude.ai ')) {
    const rm = el('button', 'link', 'remove');
    rm.addEventListener('click', () => askConfirm(`Remove ${item.label} from Claude Code on this PC?`, () => send('toolRemove', { name: item.name }), 'Remove'));
    stat.appendChild(rm);
  }
  if (kind === 'plugin' && item.scope === 'user' && !item.recommended) {
    const rm = el('button', 'link', 'remove');
    rm.addEventListener('click', () => askConfirm(`Uninstall the ${item.label} plugin from Claude in Zen?`, () => send('pluginUninstall', { id: item.id }), 'Uninstall'));
    stat.appendChild(rm);
  }
  row.append(sw, info, stat);
  return row;
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

// ------------------------------------------------------------ attachments (+ button, paste, drop, tab screenshot)

const ATTACH_MAX = 12, ATTACH_FILE = 32 * 1024 * 1024, ATTACH_TOTAL = 80 * 1024 * 1024;
let attachments = [];   // { id, name, size, type, file?: File, data?: base64, url?: preview }
let attachSeq = 0;

function sizeText(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

function addFiles(list) {
  let total = attachments.reduce((n, a) => n + a.size, 0);
  const problems = [];
  for (const f of Array.from(list || [])) {
    if (attachments.length >= ATTACH_MAX) { problems.push(`Up to ${ATTACH_MAX} files per message.`); break; }
    if (f.size > ATTACH_FILE) { problems.push(`${f.name} is over 32 MB.`); continue; }
    if (total + f.size > ATTACH_TOTAL) { problems.push('Up to 80 MB per message.'); break; }
    total += f.size;
    const a = { id: ++attachSeq, name: f.name || 'pasted file', size: f.size, type: f.type || '', file: f };
    if (/^image\//.test(a.type) && f.size < 8 * 1024 * 1024) { try { a.url = URL.createObjectURL(f); } catch {} }
    attachments.push(a);
  }
  if (problems.length) $('composerHint').textContent = problems.join(' ');
  renderAttachments();
  input.focus();
}

function renderAttachments() {
  const box = $('attachList');
  box.textContent = '';
  box.hidden = !attachments.length;
  for (const a of attachments) {
    const chip = el('span', 'attchip');
    chip.title = `${a.name} · ${sizeText(a.size)}`;
    if (a.url) { const img = el('img'); img.src = a.url; img.alt = ''; chip.appendChild(img); }
    else chip.appendChild(el('span', 'ext', ((/\.([a-z0-9]{1,5})$/i.exec(a.name) || [])[1] || 'file').toUpperCase()));
    chip.appendChild(el('span', 'an', a.name));
    chip.appendChild(el('span', 'as', sizeText(a.size)));
    const x = el('button', 'ax', '×');
    x.type = 'button'; x.setAttribute('aria-label', `Remove ${a.name}`);
    x.addEventListener('click', () => { if (a.url) URL.revokeObjectURL(a.url); attachments = attachments.filter(b => b !== a); renderAttachments(); });
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

function readAttachment(a) {
  if (a.data) return Promise.resolve({ name: a.name, type: a.type, data: a.data });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: a.name, type: a.type, data: String(r.result).replace(/^data:[^,]*,/, '') });
    r.onerror = () => reject(new Error(`Could not read ${a.name}.`));
    r.readAsDataURL(a.file);
  });
}

function onSnap(m) {
  if (m.error) { $('composerHint').textContent = m.error; return; }
  const size = Math.round(String(m.data || '').length * 0.75);
  const a = { id: ++attachSeq, name: m.name || 'screenshot.png', size, type: m.mime || 'image/png', data: m.data, url: 'data:image/png;base64,' + m.data };
  attachments.push(a);
  renderAttachments();
  input.focus();
}

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
input.addEventListener('paste', e => {
  const files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) { addFiles(files); if (!e.clipboardData.getData('text')) e.preventDefault(); }
});
const dropZone = $('page-chat');
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
dropZone.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('composer').classList.add('dragging'); });
dropZone.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
dropZone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('composer').classList.remove('dragging'); } });
dropZone.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('composer').classList.remove('dragging');
  addFiles(e.dataTransfer.files);
});

// The small button beside +: more options.
const menu = $('moreMenu');
function openMenu(open) {
  menu.hidden = !open;
  $('moreBtn').setAttribute('aria-expanded', String(open));
  if (open) { const first = menu.querySelector('button'); if (first) first.focus(); }
}
$('moreBtn').addEventListener('click', e => { e.stopPropagation(); openMenu(menu.hidden); });
document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('#moreMenu')) openMenu(false); });
menu.addEventListener('keydown', e => {
  const items = Array.from(menu.querySelectorAll('button'));
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { openMenu(false); $('moreBtn').focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
for (const b of menu.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    const act = b.dataset.act;
    openMenu(false);
    if (act === 'upload') $('fileInput').click();
    else if (act === 'snap') send('snapTab', { req: String(Date.now()) });
    else if (act === 'caveman') send('setCaveman', { value: !state.caveman });
    else if (act === 'tools') { showPage('settings'); setSection('toolsHead', 'toolsBody', true); setTimeout(() => { const c = $('toolsCard'); if (c.scrollIntoView) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60); }
    else if (act === 'new') { chat = []; saveChat(); send('newChat'); renderChat(); input.focus(); }
  });
}
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

// The typed letters sit level with the + and send buttons: the middle of the 34 px text bar is where the lowercase
// letters' band (the x-height) is centred. Where that band falls in a line depends on the font (Segoe UI, the Windows
// font, puts the baseline lower than DejaVu does), so the padding is worked out from the font the textarea uses.
function centreTyping() {
  const cs = getComputedStyle(input);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:pre;margin:0;padding:0;'
    + `font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};line-height:20px;`;
  probe.textContent = 'x';
  const mark = document.createElement('span');   // zero-size box on the baseline: its top is the baseline
  mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
  probe.appendChild(mark);
  document.body.appendChild(probe);
  const baseline = mark.getBoundingClientRect().top - probe.getBoundingClientRect().top;
  probe.remove();
  if (!(baseline > 0)) return;   // nothing laid out (a hidden panel): keep the CSS padding
  const ctx = centreTyping.ctx || (centreTyping.ctx = document.createElement('canvas').getContext('2d'));
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const xHeight = ctx.measureText('x').actualBoundingBoxAscent;
  if (!(xHeight > 0)) return;
  const top = 17 - baseline + xHeight / 2;   // the x-height band's middle lands on 17 px, the middle of 34 px
  input.style.paddingTop = top.toFixed(2) + 'px';
  input.style.paddingBottom = (34 - 20 - top).toFixed(2) + 'px';
}
centreTyping();
if (document.fonts) document.fonts.ready.then(centreTyping);

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
  if (!text && !attachments.length) return;
  if (busyMsg()) { $('composerHint').textContent = 'Claude is still answering. Wait, or press Cancel.'; return; }
  if (text.startsWith('/') && !attachments.length) { input.value = ''; autoGrow(); addMsg({ role: 'user', text }); return runSlash(text); }
  if (state.agent === 'stopped') { addMsg({ role: 'system', text: 'Claude is stopped. Press Start (top right) first.' }); return; }
  if (!state.signedIn) { addMsg({ role: 'system', text: 'Sign in first: Profile page → Sign in with Claude.' }); return; }
  const files = attachments;
  attachments = [];
  renderAttachments();
  input.value = ''; autoGrow();
  addMsg({ role: 'user', text, files: files.map(a => ({ name: a.name, size: a.size })) });
  const id = `p${Date.now().toString(36)}${chatSeq++}`;
  addMsg({ role: 'assistant', id, text: '', steps: [], pending: true, startedAt: Date.now() });
  if (!files.length) { send('chat', { id, text }); return; }
  let payload = [];
  try { payload = await Promise.all(files.map(readAttachment)); }
  catch (e) { return onChatDone({ id, ok: false, error: e.message }); }
  finally { for (const a of files) if (a.url && a.url.startsWith('blob:')) URL.revokeObjectURL(a.url); }
  send('chat', { id, text, attachments: payload });
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
  return JSON.stringify(m) + '|' + (m.limit && state.switching ? 1 : 0) + '|' + (expandedSteps.has(m.id) ? 1 : 0);
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
