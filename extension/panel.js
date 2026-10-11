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
  if (msg.type === 'state') { state = msg.state; render(msg.state, msg.log); maybeLoadMods(msg.state); }
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
  if (msg.type === 'selfResult') onSelfResult(msg);
  if (msg.type === 'outputSaved') onOutputSaved(msg);
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
$('chooseFolder').addEventListener('click', () => send('pickFolder'));
for (const b of document.querySelectorAll('#fileSeg button')) {
  b.addEventListener('click', () => send('setFiles', { value: !!state.filesEnabled, mode: b.dataset.mode, folder: $('filesFolder').value }));
}
$('devPing').addEventListener('click', () => send('devCall', { tool: 'ping' }));
$('devTabs').addEventListener('click', () => send('devCall', { tool: 'tabs_list' }));
// Dark mode: the switch at the top of Settings. theme.js applies the saved choice before the first paint; this keeps it.
function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('ciz-theme', dark ? 'dark' : 'light'); } catch {}
  applyWall(wall);   // a picture's text colour depends on the theme too
}
$('themeToggle').checked = document.documentElement.dataset.theme === 'dark';
$('themeToggle').addEventListener('change', e => setTheme(e.target.checked));
// Wallpaper: Default, a solid colour, a two-colour gradient, or a picture. It sits behind the cards, which keep their own colour. Kept in this browser; theme.js applies it before the first paint.
const WALL_KEY = 'ciz-wall';
const WALL_DEFAULTS = { mode: 'default', color: '#f6f4ef', from: '#f6f4ef', to: '#cfdcef', image: '' };
function loadWall() {
  try { return { ...WALL_DEFAULTS, ...JSON.parse(localStorage.getItem(WALL_KEY) || 'null') }; }
  catch { return { ...WALL_DEFAULTS }; }
}
function saveWall(w) {
  try { localStorage.setItem(WALL_KEY, JSON.stringify(w)); return true; }
  catch { return false; }
}
function applyWall(w) {
  const root = document.documentElement;
  root.dataset.wall = w.mode;
  root.style.setProperty('--wall-color', w.color);
  root.style.setProperty('--wall-from', w.from);
  root.style.setProperty('--wall-to', w.to);
  root.style.setProperty('--wall-img', w.image ? `url("${w.image}")` : 'none');
  for (const b of document.querySelectorAll('.wallseg button')) b.setAttribute('aria-checked', String(b.dataset.wall === w.mode));
  $('wallSolid').hidden = w.mode !== 'solid';
  $('wallGradient').hidden = w.mode !== 'gradient';
  $('wallPicture').hidden = w.mode !== 'picture';
  $('wallColor').value = w.color;
  $('wallFrom').value = w.from;
  $('wallTo').value = w.to;
  // The page text takes the ink for this wallpaper (lib/wall.js); the default wallpaper keeps the theme's own.
  const ink = window.cizWallInk ? cizWallInk.inkFor(w, root.dataset.theme) : null;
  if (ink) root.dataset.wallInk = ink; else delete root.dataset.wallInk;
}
function wallNote(text) { $('wallNote').textContent = text; $('wallNote').hidden = !text; }
let wall = loadWall();
applyWall(wall);
// A picture kept before the text colour existed has no average yet: it is measured once, when the panel opens.
if (wall.mode === 'picture' && wall.image && !wall.avg) measureWall(wall.image);
function measureWall(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const small = document.createElement('canvas');
    small.width = 16;
    small.height = 16;
    const ctx = small.getContext('2d');
    ctx.drawImage(img, 0, 0, 16, 16);
    const avg = window.cizWallInk ? cizWallInk.averageHex(ctx.getImageData(0, 0, 16, 16).data) : null;
    if (avg && wall.image === dataUrl) setWall({ avg });
  };
  img.src = dataUrl;
}
// Returns false when the choice could not be kept in this browser (a picture too big for storage). The choice still applies for this session.
function setWall(patch) {
  wall = { ...wall, ...patch };
  applyWall(wall);
  return saveWall(wall);
}
for (const b of document.querySelectorAll('.wallseg button')) {
  b.addEventListener('click', () => { wallNote(''); setWall({ mode: b.dataset.wall }); });
}
$('wallColor').addEventListener('input', e => setWall({ color: e.target.value }));
$('wallFrom').addEventListener('input', e => setWall({ from: e.target.value }));
$('wallTo').addEventListener('input', e => setWall({ to: e.target.value }));
$('wallPick').addEventListener('click', () => $('wallFile').click());
$('wallClear').addEventListener('click', () => { wallNote(''); setWall({ mode: 'default', image: '' }); });
$('wallFile').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) pictureToWall(file);
});
// The picture is scaled so its long side is 1600 px and kept as a JPEG, so it stays small enough to keep.
function pictureToWall(file) {
  if (!/^image\//.test(file.type)) { wallNote('That file is not a picture.'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const small = document.createElement('canvas');
    small.width = 16;
    small.height = 16;
    const sctx = small.getContext('2d');
    sctx.drawImage(canvas, 0, 0, 16, 16);
    const avg = window.cizWallInk ? cizWallInk.averageHex(sctx.getImageData(0, 0, 16, 16).data) : null;
    const kept = setWall({ mode: 'picture', image: canvas.toDataURL('image/jpeg', 0.82), avg: avg || '' });
    wallNote(kept ? '' : 'That picture is too big to keep in this browser, so it is used for this session only.');
  };
  img.onerror = () => { URL.revokeObjectURL(url); wallNote('Could not open that picture.'); };
  img.src = url;
}
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

// Local pages: Claude's question about a folder (answered in the helper's confirm window), and the allowed folders in
// Profile > Permissions.
const FILE_ACCESS_OFF = "Zen keeps add-ons out of files on this computer. Turn on 'Access local files on your computer' for Claude in Zen: about:addons, Claude in Zen, Permissions and data.";
const CONFIRM_WAIT = 'Answer in the Claude in Zen window that opened. If you do not see it, look behind Zen or on the taskbar.';
function renderLocal(s) {
  const ask = s.grantAsk && s.grantAsk.folder ? s.grantAsk : null;
  const box = $('grantAsk');
  if (ask && box.dataset.folder !== ask.folder) {
    box.dataset.folder = ask.folder;
    $('grantFolder').textContent = ask.folder;
    showPage('chat');   // the question waits on the chat page, where Claude's answer will show
  }
  if (!ask) delete box.dataset.folder;
  box.hidden = !ask;
  $('grantAccess').textContent = FILE_ACCESS_OFF;
  $('grantAccess').hidden = s.fileAccess !== 'no';
  const grants = Array.isArray(s.localGrants) ? s.localGrants.map(String) : [];
  $('localCount').textContent = grants.length ? `${grants.length} allowed` : 'none allowed';
  const list = $('localList');
  const sig = JSON.stringify(grants);
  if (list.dataset.sig !== sig) {   // rebuilt only when the list changes, so a focused Remove button keeps its focus
    list.dataset.sig = sig;
    list.textContent = '';
    for (const f of grants) {
      const li = el('li');
      const name = el('span', 'mono', f);
      name.title = f;
      const rm = el('button', 'link', 'Remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove ${f}`);
      rm.addEventListener('click', () => send('localGrantRemove', { folder: f }));
      li.append(name, rm);
      list.appendChild(li);
    }
  }
  $('localNote').textContent = s.fileAccess === 'no' ? FILE_ACCESS_OFF
    : 'Claude asks before it looks at a page or file on this computer, one folder at a time. Remove a folder to be asked again.';
  $('localNote').classList.toggle('warnnote', s.fileAccess === 'no');
}

// The octopus (Quality mode only) opens the army card. The switch inside the card turns the army on; the octopus itself only shows it.
const ARMY_RECOMMENDED = 5;
function openArmy(open) {
  $('armyCard').hidden = !open;
  $('armyBtn').setAttribute('aria-expanded', String(open));
  if (open) $('armyToggle').focus();
}
function closeArmy(refocus) {
  if ($('armyCard').hidden) return;
  openArmy(false);
  if (refocus) $('armyBtn').focus();
}
$('armyBtn').addEventListener('click', e => { e.stopPropagation(); if ($('armyCard').hidden) openArmy(true); else closeArmy(true); });
$('armyClose').addEventListener('click', () => closeArmy(true));
$('armyToggle').addEventListener('change', e => send('setArmy', { value: e.target.checked }));
document.addEventListener('click', e => { if (!$('armyCard').hidden && !e.target.closest('#armyCard, #armyBtn')) closeArmy(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('armyCard').hidden) { e.preventDefault(); closeArmy(true); } });
function armyRunsText(n) {
  return n > ARMY_RECOMMENDED ? `Runs today: ${n}. That's past the recommended ${ARMY_RECOMMENDED}, so usage is high.`
    : `Runs today: ${n} of ${ARMY_RECOMMENDED} recommended.`;
}

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
  // A switch the helper refused (a shell, a no in the confirm window): say why, and put the switches back as they are.
  if (m.action === 'set' && !m.ok) { $('toolsNote').textContent = m.error; $('toolsNote').hidden = false; lastToolsSig = ''; render(state, null); }
}

// Unsafe mode: turning it on asks in the helper's confirm window (a Windows window outside Zen); the switch follows
// the answer. Turning it off needs no question.
$('unsafeToggle').addEventListener('change', e => {
  if (e.target.checked) { e.target.checked = !!state.unsafe; send('setUnsafe', { value: true }); }
  else send('setUnsafe', { value: false });
});

// Watch videos (the watch_video tool). Turning the switch on asks in the helper's confirm window (a Windows window outside
// Zen), so it is set back here until the state says on. Turning it off needs no question.
$('watchToggle').addEventListener('change', e => {
  if (e.target.checked) { e.target.checked = !!state.watch; send('setWatch', { value: true }); }
  else send('setWatch', { value: false });
});
// The saved option "Start with watching on": On asks the same way, and the helper's reply sets it. Off is saved at once.
$('watchOnLoadToggle').addEventListener('change', e => {
  if (e.target.checked) { e.target.checked = state.watchOnLoad === true; send('setWatchOnLoad', { value: true }); }
  else send('setWatchOnLoad', { value: false });
});
// The card: Claude asks to watch a video. Allow and Deny answer it; Allow opens the helper's confirm window, where the
// switch is really turned on.
$('watchAllow').addEventListener('click', () => answerWatch(true));
$('watchDeny').addEventListener('click', () => answerWatch(false));
function answerWatch(allow) { if (state.watchAsk) send('watchAnswer', { id: state.watchAsk.id, allow }); }
let watchShownId = '';   // the card id last shown to the helper: watchShown goes once per id

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
  if (!c.loggedIn) return ['warn', 'not signed in', 'Double-click "Sign in Claude Code.bat" in the tools folder'];
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
    ? 'For one-click updates: close Zen, run "Link add-on to Zen.bat" (tools folder) once, start Zen. After that, update just reloads.' : '');
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
  const waiting = s.confirmPending && s.confirmPending.kind;
  $('unsafeNote').textContent = waiting === 'unsafe' ? CONFIRM_WAIT
    : s.unsafe ? 'On. Claude may act on Google sign-in pages until you press Stop or restart Zen.'
      : 'Off. Claude does not act on Google sign-in pages.';
  $('unsafeNote').classList.toggle('warnnote', waiting === 'unsafe');
  // watch videos: session only (Stop turns it off). The card is the helper's question about one video; Claude cannot answer it.
  $('watchToggle').checked = !!s.watch;
  $('watchToggle').disabled = s.agent === 'stopped';
  $('watchNote').textContent = waiting === 'watch' ? CONFIRM_WAIT
    : s.watch ? 'On. Claude may watch videos until you press Stop.'
      : 'Off. Claude asks in the chat before it watches.';
  $('watchNote').classList.toggle('warnnote', waiting === 'watch');
  $('watchOnLoadToggle').checked = s.watchOnLoad === true;
  $('watchCard').hidden = !s.watchAsk;
  if (s.watchAsk) {
    $('watchCardSource').textContent = String(s.watchAsk.source || '').slice(0, 200);
    if (watchShownId !== s.watchAsk.id) { watchShownId = s.watchAsk.id; send('watchShown', { id: s.watchAsk.id }); }
  }
  $('googleVal').textContent = s.unsafe ? 'allowed (Unsafe mode)' : 'always hands-off';
  $('googleVal').classList.toggle('warn', !!s.unsafe);
  $('filesToggle').checked = !!s.filesEnabled;
  if (document.activeElement !== $('filesFolder')) $('filesFolder').value = s.filesFolder || '';
  $('filesFolder').disabled = s.agent === 'stopped';
  $('folderNow').textContent = s.filesFolder || 'No folder chosen yet';
  $('folderNow').classList.toggle('muted', !s.filesFolder);
  $('chooseFolder').textContent = s.folderPicking ? 'Choosing…' : 'Choose folder…';
  $('chooseFolder').disabled = !!s.folderPicking || s.agent === 'stopped';
  for (const b of document.querySelectorAll('#fileSeg button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === (s.filesMode === 'write' ? 'write' : 'read')));
    b.disabled = s.agent === 'stopped';
  }
  const filesWaiting = !!(s.confirmPending && s.confirmPending.kind === 'files');
  $('filesNote').textContent = filesWaiting ? CONFIRM_WAIT
    : !s.filesEnabled
      ? 'Off. Claude has no file access. Type a full folder path, then turn it on.'
      : s.filesMode === 'write'
        ? 'On: Claude can read, create and change files in this folder only. There is no undo, so use a folder you can afford to lose. No shell.'
        : 'On: Claude can read and search files in this folder only. No changes, no shell.';
  $('filesNote').classList.toggle('warnnote', filesWaiting || (!!s.filesEnabled && s.filesMode === 'write'));
  $('filesToggle').disabled = s.agent === 'stopped';
  $('pendingVal').textContent = String(s.pending || 0);
  renderLocal(s);

  // model choice: one button shows Speed or Quality (a click flips it), and the + (Speed mode only) turns Speed Plus on
  const quality = s.chatModel === 'quality';
  const plus = !quality && !!s.chatPlus;
  $('modeSeg').dataset.mode = quality ? 'quality' : 'speed';
  $('modeLabel').textContent = quality ? 'Quality' : 'Speed';
  $('modeBtn').setAttribute('aria-label', quality ? 'Quality. Switch to Speed.' : 'Speed. Switch to Quality.');
  $('plusBtn').setAttribute('aria-pressed', String(plus));
  $('plusBtn').hidden = quality;
  // the octopus takes the +'s place in Quality; leaving Quality hides it and closes its card
  const army = quality && !!s.chatArmy;
  $('armyBtn').hidden = !quality;
  $('armyBtn').setAttribute('aria-pressed', String(army));
  if (!quality) closeArmy(false);
  $('armyToggle').checked = army;
  $('armyToggle').disabled = s.agent === 'stopped';
  const runs = Number(s.armyToday) || 0;
  $('armyRuns').textContent = armyRunsText(runs);
  $('armyRuns').classList.toggle('warnnote', runs > ARMY_RECOMMENDED);
  // the line under the outputs: what the next message runs on
  $('modelLine').textContent = (army ? 'Opus 5.5 · max effort · army of 5 Haiku' : quality ? 'Opus 5.5 · high effort' : plus ? 'Haiku 5.5 · max effort' : 'Haiku 5.5 · high effort')
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
  renderMods(s);
  renderOutput(s);
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
  const stopped = s.agent === 'stopped' || !!s.accountLogin;   // no account changes while a sign-in window is open
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
      hint: 'Install Node.js if you don\u2019t have it, then double-click "Set up Claude in Zen.bat" in the Claude in Zen folder.',
      action: s.agent === 'active' && s.native !== 'connected' ? ['Retry', () => send('retryNative')] : null },
    { done: !!c.installed, title: 'Install Claude Code',
      hint: 'Install it from code.claude.com/docs/en/setup, then press Retry.',
      action: s.native === 'connected' ? ['Retry', () => send('checkClaude')] : null },
    { done: !!c.loggedIn, title: 'Sign Claude Code in',
      hint: 'Double-click "Sign in Claude Code.bat" in the tools folder and click Authorize. The chat uses this account.',
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
  sw.type = 'checkbox'; sw.className = 'switch'; sw.checked = !!item.on; sw.disabled = s.agent === 'stopped' || !!item.blocked;
  sw.setAttribute('aria-label', `Use ${item.label} in the chat`);
  const id = kind === 'plugin' ? item.id : item.name;
  sw.addEventListener('change', () => {
    $('toolsNote').hidden = true;
    // What runs programs on this PC is asked in the helper's confirm window (outside Zen): the switch follows the answer.
    if (sw.checked && item.local) { sw.checked = !!item.on; send('toolSet', { kind, id, value: true, label: item.label }); return; }
    send('toolSet', { kind, id, value: sw.checked, label: item.label });
  });
  const info = el('div', 'tinfo');
  const name = el('div', 'tname', item.label);
  if (item.recommended) name.appendChild(el('span', 'tag star', 'essential'));
  if (item.blocked) name.appendChild(el('span', 'tag bad', 'blocked'));
  else if (item.local) name.appendChild(el('span', 'tag warn', 'runs on this PC'));
  const sub = [];
  if (kind === 'plugin') {
    if (item.version && item.version !== 'unknown') sub.push('v' + item.version);
    if (item.skills) sub.push('skills');
    if (item.servers.length) sub.push(`${item.servers.length} tool server${item.servers.length === 1 ? '' : 's'}`);
    sub.push(item.scope === 'synced' ? 'from claude.ai' : 'installed here');
  } else sub.push(item.transport === 'stdio' ? `command: ${item.target}` : String(item.target || '').replace(/^https?:\/\//, ''));
  const subline = el('div', 'tsub', sub.filter(Boolean).join(' · '));
  info.append(name, subline);
  if (item.blocked) info.appendChild(el('div', 'tblocked', item.blocked));
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
input.addEventListener('input', () => { autoGrow(); slashIndex = 0; renderSlash(); });
input.addEventListener('blur', closeSlash);

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
// The actions of the + menu. The "/" commands with an act run the same ones (see COMMANDS).
function doAct(act) {
  if (act === 'upload') $('fileInput').click();
  else if (act === 'snap') send('snapTab', { req: String(Date.now()) });
  else if (act === 'caveman') send('setCaveman', { value: !state.caveman });
  else if (act === 'tools') { showPage('settings'); setSection('toolsHead', 'toolsBody', true); setTimeout(() => { const c = $('toolsCard'); if (c.scrollIntoView) c.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60); }
  else if (act === 'improve') startImprove();
  else if (act === 'new') { leaveImprove(); chat = []; saveChat(); send('newChat'); renderChat(); input.focus(); }
}
for (const b of menu.querySelectorAll('button')) {
  b.addEventListener('click', () => { openMenu(false); doAct(b.dataset.act); });
}
input.addEventListener('keydown', e => {
  const list = slashMenu.hidden ? null : slashMatches();
  if (list && list.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      renderSlash();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); runCommand(list[slashIndex].cmd); return; }
  }
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
  if (!text && !attachments.length && !improveOn) return;
  if (busyMsg()) { $('composerHint').textContent = 'Claude is still answering. Wait, or press Cancel.'; return; }
  if (text.startsWith('/') && !attachments.length) { input.value = ''; autoGrow(); addMsg({ role: 'user', text }); return runSlash(text); }
  if (state.agent === 'stopped') { addMsg({ role: 'system', text: 'Claude is stopped. Press Start (top right) first.' }); return; }
  if (!state.signedIn) { addMsg({ role: 'system', text: 'Sign in first: Profile page → Sign in with Claude.' }); return; }
  const files = attachments;
  attachments = [];
  renderAttachments();
  input.value = ''; autoGrow();
  addMsg({ role: 'user', text: text || (improveOn ? IMPROVE_EMPTY : ''), files: files.map(a => ({ name: a.name, size: a.size })) });
  const id = `p${Date.now().toString(36)}${chatSeq++}`;
  addMsg({ role: 'assistant', id, text: '', steps: [], pending: true, startedAt: Date.now() });
  const extra = improveOn ? { improve: true } : {};
  if (!files.length) { send('chat', Object.assign({ id, text }, extra)); return; }
  let payload = [];
  try { payload = await Promise.all(files.map(readAttachment)); }
  catch (e) { return onChatDone({ id, ok: false, error: e.message }); }
  finally { for (const a of files) if (a.url && a.url.startsWith('blob:')) URL.revokeObjectURL(a.url); }
  send('chat', Object.assign({ id, text, attachments: payload }, extra));
}

// The slash commands. The "/" menu lists them all, and the starter chips show only the essentials. A command with an act
// runs the same action as the + menu; the rest are the test commands (no Claude needed).
const COMMANDS = [
  { cmd: 'help', text: 'What the commands do' },
  { cmd: 'tabs', text: 'List my open tabs' },
  { cmd: 'screenshot', act: 'snap', text: 'Screenshot of this tab' },
  { cmd: 'upload', act: 'upload', text: 'Upload files' },
  { cmd: 'caveman', act: 'caveman', text: 'Caveman mode: short replies' },
  { cmd: 'tools', act: 'tools', text: 'Tools and plugins' },
  { cmd: 'improve', act: 'improve', text: 'Improve Claude in Zen' },
  { cmd: 'clear', text: 'Clear this chat' },
  { cmd: 'ping', text: 'Check the add-on answers' },
];
function helpText() {
  return 'Type normally to talk to Claude. It can read and act on your tabs.\n\n'
    + 'Commands (type / to see them; none needs Claude):\n'
    + COMMANDS.map(c => `/${c.cmd}: ${c.text}`).join('\n');
}
async function runSlash(text) {
  const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
  const known = COMMANDS.find(c => c.cmd === cmd);
  if (!known) return addMsg({ role: 'error', text: `Unknown command /${cmd}. Try /help.` });
  if (known.act) return doAct(known.act);
  if (cmd === 'help') return addMsg({ role: 'assistant', text: helpText() });
  if (cmd === 'clear') { chat = []; saveChat(); send('newChat'); return renderChat(); }
  const tool = { tabs: 'tabs_list', ping: 'ping' }[cmd];
  const out = await call(tool);
  if (!out.ok) return addMsg({ role: 'error', text: out.error });
  if (tool === 'ping') return addMsg({ role: 'assistant', text: `Pong. Add-on v${out.result.version} is answering.` });
  addMsg({ role: 'assistant', text: `You have ${out.result.length} tab${out.result.length === 1 ? '' : 's'} open:`, tabs: out.result.slice(0, 50) });
}

// The "/" menu: it opens when the text bar holds "/" and letters, and narrows as you type.
const slashMenu = $('slashMenu');
let slashIndex = 0;
function slashMatches() {
  const v = input.value;
  if (!v.startsWith('/') || /\s/.test(v) || attachments.length) return null;
  const q = v.slice(1).toLowerCase();
  return COMMANDS.filter(c => c.cmd.startsWith(q));
}
function renderSlash() {
  const list = slashMatches();
  if (!list || !list.length) { slashMenu.hidden = true; return; }
  slashIndex = Math.min(slashIndex, list.length - 1);
  slashMenu.replaceChildren(...list.map((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === slashIndex));
    b.dataset.cmd = c.cmd;
    const k = document.createElement('span');
    k.className = 'mcmd';
    k.textContent = '/' + c.cmd;
    const t = document.createElement('span');
    t.className = 'mtext';
    t.textContent = c.text;
    b.append(k, t);
    b.addEventListener('mousedown', e => e.preventDefault());   // the text bar keeps the focus
    b.addEventListener('click', () => runCommand(c.cmd));
    return b;
  }));
  slashMenu.hidden = false;
}
function closeSlash() { slashMenu.hidden = true; }
// A command picked from the menu is sent the way a starter chip sends its text.
function runCommand(cmd) {
  closeSlash();
  input.value = '/' + cmd;
  autoGrow();
  submit();
}

// ------------------------------------------------------------ chat stream

// ------------------------------------------------------------ improve Claude in Zen (the + menu)
// Claude edits a copy of the add-on, and the reply ends with a card: Apply writes the change into the add-on,
// Discard drops it. Nothing changes in the add-on until Apply.
const IMPROVE_EMPTY = 'Improve Claude in Zen: pick one change that helps most.';
let improveOn = false;
function startImprove() {
  if (state.agent === 'stopped' || !state.signedIn) { addMsg({ role: 'system', text: 'Start Claude and sign in first, then improve.' }); return; }
  improveOn = true;
  document.body.classList.add('improving');
  $('improveBar').hidden = false;
  input.placeholder = 'Empty means Claude picks';
  input.focus();
}
function leaveImprove() {
  improveOn = false;
  document.body.classList.remove('improving');
  $('improveBar').hidden = true;
  input.placeholder = 'Message Claude…';
}
$('improveLeave').addEventListener('click', leaveImprove);

// The proposal event, kept to the fields the card shows.
function proposalFrom(ev) {
  return {
    id: String(ev.id || '').slice(0, 40),
    changed: Number(ev.changed) || 0,
    added: Number(ev.added) || 0,
    removed: Number(ev.removed) || 0,
    files: (Array.isArray(ev.files) ? ev.files : []).slice(0, 60).map(f => ({
      path: String(f.path || '').slice(0, 200), status: String(f.status || ''), added: Number(f.added) || 0, removed: Number(f.removed) || 0,
    })),
    blocked: (Array.isArray(ev.blocked) ? ev.blocked : []).slice(0, 20).map(b => String(b).slice(0, 300)),
    tests: ev.tests && typeof ev.tests === 'object'
      ? { ok: !!ev.tests.ok, summary: String(ev.tests.summary || '').slice(0, 200), tail: String(ev.tests.tail || '').slice(0, 2000) } : null,
    canApply: !!ev.canApply,
    diff: String(ev.diff || ''),
    diffFile: String(ev.diffFile || '').slice(0, 300),
  };
}

// The card under an improve reply: what changed, whether the tests passed, the diff, and Apply or Discard.
function proposalCard(m) {
  const p = m.proposal;
  const box = el('div', 'proposal');
  if (!p.changed) box.appendChild(el('p', 'pnote', 'Claude made no change to the add-on.'));
  else {
    box.appendChild(el('p', 'phead', `Proposed change: ${p.changed} file${p.changed === 1 ? '' : 's'}, +${p.added} −${p.removed}`));
    const list = el('ul', 'pfiles');
    for (const f of p.files) list.appendChild(el('li', '', `${f.path}: ${f.status === 'added' ? 'new' : f.status === 'removed' ? 'removed' : 'edited'}, +${f.added} −${f.removed}`));
    box.appendChild(list);
  }
  for (const b of p.blocked) box.appendChild(el('p', 'pwarn', b));
  if (p.tests) {
    box.appendChild(el('p', p.tests.ok ? 'ptests ok' : 'ptests bad', `${p.tests.ok ? 'Tests passed' : 'Tests failed'}: ${p.tests.summary}`));
    if (!p.tests.ok && p.tests.tail) box.appendChild(el('pre', 'pdiff', p.tests.tail));
  } else if (p.changed) box.appendChild(el('p', 'pmuted', 'Not tested: the change was blocked.'));
  if (p.diff) {
    const det = document.createElement('details');
    det.appendChild(el('summary', '', 'Show changes'));
    det.appendChild(el('pre', 'pdiff', p.diff));
    box.appendChild(det);
  }
  if (p.diffFile) box.appendChild(el('p', 'pmuted', `Whole diff: ${p.diffFile}`));
  const st = m.proposalState;
  if (st) box.appendChild(el('p', st.pending ? 'pmuted' : st.ok ? 'pdone' : 'pwarn', st.text));
  if (st && st.ok !== false) return box;   // applying, applied or discarded: nothing more to do here
  if (!p.changed) return box;
  const row = el('div', 'pbtns');
  const apply = el('button', 'pbtn primary', 'Apply');
  apply.type = 'button';
  apply.disabled = !p.canApply;
  apply.title = p.canApply ? 'Write this change into Claude in Zen' : 'This change did not pass its checks';
  const discard = el('button', 'pbtn', 'Discard');
  discard.type = 'button';
  apply.addEventListener('click', () => { setProposalState(p.id, { pending: true, text: 'Applying…' }); send('selfApply', { id: p.id }); });
  discard.addEventListener('click', () => { setProposalState(p.id, { pending: true, text: 'Discarding…' }); send('selfDiscard', { id: p.id }); });
  row.append(apply, discard);
  box.appendChild(row);
  return box;
}

function setProposalState(id, st) {
  const m = chat.find(x => x.proposal && x.proposal.id === id);
  if (!m) return;
  m.proposalState = st;
  saveChat();
  renderChat();
}

function onSelfResult(msg) {
  setProposalState(String(msg.id || ''), { ok: !!msg.ok, text: String(msg.text || '') });
}

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

// ------------------------------------------------------------ mods

// A mod is a folder in extension/mods/<id>/ (see extension/mods/README.txt): panel.js and/or style.css. The helper
// lists the folders and says which mods are on. This page loads the on mods once, after its own code, one at a time.
const MOD_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MOD_MARK = 'ciz-mods-loading';   // set while a mod's script loads: a crash or a hang shows on the next start
let modsStarted = false;
let modsSig = '';
const modByUrl = new Map();            // a mod's script address, without the query -> its id
const modStopped = new Set();          // mods already turned off in this page
const bareUrl = u => String(u || '').split('?')[0];

function modMark(id) { try { if (id) localStorage.setItem(MOD_MARK, id); else localStorage.removeItem(MOD_MARK); } catch {} }
function modMarked() { try { return localStorage.getItem(MOD_MARK) || ''; } catch { return ''; } }

// Turns a mod off. The helper keeps the reason, and the next start skips the mod. Reported once per page.
function modStop(id, why) {
  if (!MOD_ID.test(String(id || '')) || modStopped.has(id)) return;
  modStopped.add(id);
  send('modUpdate', { id, enabled: false, broken: String(why || 'It stopped with an error.').slice(0, 300) });
}

window.addEventListener('error', e => {
  const id = modByUrl.get(bareUrl(e.filename));
  if (id) modStop(id, e.message || 'It threw an error.');
});
window.addEventListener('unhandledrejection', e => {
  const text = String((e.reason && e.reason.stack) || e.reason || '');
  for (const [url, id] of modByUrl) if (text.includes(url)) modStop(id, 'A promise it made was rejected.');
});

// Loads the on mods the first time the helper has listed them. Later changes take effect after Reload panel.
function maybeLoadMods(s) {
  if (modsStarted || !s.modsKnown) return;
  modsStarted = true;
  const crashed = modMarked();
  modMark('');
  if (MOD_ID.test(crashed)) modStop(crashed, 'The panel stopped while this mod was loading, so it is turned off.');
  let chain = Promise.resolve();
  for (const m of Array.isArray(s.mods) ? s.mods : []) {
    if (!m || !MOD_ID.test(String(m.id || '')) || !m.enabled || m.broken || m.id === crashed) continue;
    chain = chain.then(() => loadMod(m));
  }
}

function loadMod(m) {
  return new Promise(done => {
    const folder = `mods/${m.id}/`;
    if (m.style) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${folder}style.css?v=${Date.now()}`;
      document.head.appendChild(css);
    }
    if (!m.panel) return done();
    const js = document.createElement('script');
    js.src = `${folder}panel.js?v=${Date.now()}`;
    modByUrl.set(bareUrl(js.src), m.id);
    modMark(m.id);
    js.onload = () => { modMark(''); done(); };
    js.onerror = () => { modMark(''); modStop(m.id, 'panel.js could not be loaded.'); done(); };
    document.head.appendChild(js);
  });
}

// Settings > Saving files: a made file is downloaded now (the default), or kept in the output folder beside the mods folder.
const OUTPUT_NOTES = {
  download: 'Downloads go to Downloads\\Claude in Zen, as before.',
  store: 'Made files are kept in the output folder, beside the mods folder. A name that is already taken gets (2), (3) and so on, so nothing is overwritten. If the helper is not running, the file is downloaded instead.',
};
function renderOutput(s) {
  const mode = s.outputMode === 'store' ? 'store' : 'download';
  for (const b of document.querySelectorAll('#outputSeg button')) b.setAttribute('aria-checked', String(b.dataset.value === mode));
  $('outputNote').textContent = OUTPUT_NOTES[mode];
}
for (const b of document.querySelectorAll('#outputSeg button')) {
  b.addEventListener('click', () => send('setOutput', { value: b.dataset.value }));
}
// The helper stored a made file: say where it went, in the chat.
function onOutputSaved(m) {
  addMsg({ role: 'system', text: `Stored ${m.name} in the output folder: ${m.path}` });
}

// The Mods card: one row per mod, with its state and a switch. Rebuilt only when the list changes.
function renderMods(s) {
  const list = Array.isArray(s.mods) ? s.mods : [];
  const sig = JSON.stringify([list, !!s.modsKnown]);
  if (sig === modsSig) return;
  modsSig = sig;
  const ul = $('modsList');
  ul.textContent = '';
  for (const m of list) {
    const li = el('li', 'mod');
    const text = el('div', 'mod-text');
    text.appendChild(el('div', 'mod-name', m.name || m.id));
    if (m.description) text.appendChild(el('div', 'mod-desc', m.description));
    text.appendChild(el('div', m.broken ? 'mod-state bad' : 'mod-state', m.broken ? `Stopped: ${m.broken}` : (m.enabled ? 'On' : 'Off')));
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.checked = !!m.enabled;
    sw.setAttribute('aria-label', `${m.name || m.id}, on`);
    sw.addEventListener('change', () => send('modUpdate', { id: m.id, enabled: sw.checked }));
    li.append(text, sw);
    ul.appendChild(li);
  }
  ul.hidden = !list.length;
  const empty = $('modsEmpty');
  empty.hidden = list.length > 0;
  empty.textContent = s.modsKnown
    ? 'No mods yet. Ask Improve Claude in Zen for one, and it is made in extension\\mods.'
    : 'The helper lists the mods when it is connected.';
}

$('modsCheck').addEventListener('click', () => send('modsRefresh'));
$('modsReload').addEventListener('click', () => location.reload());
$('modsOff').addEventListener('click', () => send('modsAllOff'));
