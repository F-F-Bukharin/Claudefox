'use strict';
// Sidebar panel, the Settings and Profile pages: dark mode and wallpaper, permissions, tools and plugins, accounts, mods and saving files.

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

// Sites (Profile, Permissions): the list the background keeps in storage.local sites. Allow and Block are the choices, and Remove
// takes a site off the list. A change to the stored list redraws it.
function renderSites(sites) {
  const list = $('siteList');
  list.textContent = '';
  for (const site of Object.keys(sites)) {
    const li = el('li');
    const name = el('span', 'mono', site);
    const choices = ['allow', 'block'].map(value => {
      const b = actBtn(value === 'allow' ? 'Allow' : 'Block', 'link', () => send('siteListSet', { site, value }));
      b.setAttribute('aria-pressed', String(sites[site] === value));
      return b;
    });
    const rm = actBtn('Remove', 'link', () => send('siteListSet', { site, value: null }));
    li.append(name, ...choices, rm);
    list.appendChild(li);
  }
}
$('siteAddBtn').addEventListener('click', () => {
  const site = $('siteAdd').value.trim();
  if (!site) return;
  $('siteAdd').value = '';
  send('siteListSet', { site, value: 'allow' });
});
try {
  browser.storage.local.get('sites').then(got => renderSites(got.sites || {}));
  browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.sites) renderSites(changes.sites.newValue || {}); });
} catch {}

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
// The picture card: Allow or Deny answers the card on screen, by the id the panel rendered (panel.js).
function answerDownloadCard(allow) { const id = $('downloadCard').dataset.id; if (id) send('downloadAnswer', { id, allow }); }
$('downloadAllow').addEventListener('click', () => answerDownloadCard(true));
$('downloadDeny').addEventListener('click', () => answerDownloadCard(false));
function answerWatch(allow) { if (state.watchAsk) send('watchAnswer', { id: state.watchAsk.id, allow }); }
$('siteMsg').addEventListener('click', () => answerSite('message'));
$('siteChat').addEventListener('click', () => answerSite('chat'));
$('siteDeny').addEventListener('click', () => answerSite('deny'));
$('siteAllow').addEventListener('click', () => answerSite('allow'));
function answerSite(choice) { if (state.siteAsk) send('siteAnswer', { id: state.siteAsk.id, choice }); }
// Trusted: a turn-on waits for the helper's confirm window, so the switch shows the state until that says yes
$('trustedToggle').addEventListener('change', e => {
  const on = e.target.checked;
  if (on) e.target.checked = !!state.trusted;
  send('setTrusted', { on });
});
let watchShownId = '';   // the card id last shown to the helper: watchShown goes once per id

// ------------------------------------------------------------ accounts (Profile)
// Every Claude account the chat can use: one card each. Use switches the chat to it; Add account opens a sign-in
// window; Remove asks inside that account's own card first. bg-accounts.js relays these to the helper (accounts).
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

// Settings > Saving files: a made file is downloaded now (the default), or kept in the output folder in Claude in Zen's data folder.
const OUTPUT_NOTES = {
  download: 'Downloads go to Downloads\\Claude in Zen, as before.',
  store: 'Made files are kept in Claude in Zen\'s data folder (…\\claude-in-zen\\output). A name that is already taken gets (2), (3) and so on, so nothing is overwritten. If the helper is not running, the file is downloaded instead.',
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
