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
  const ink = window.cfxWallInk ? cfxWallInk.inkFor(w, root.dataset.theme) : null;
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
    const avg = window.cfxWallInk ? cfxWallInk.averageHex(ctx.getImageData(0, 0, 16, 16).data) : null;
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
  if (!/^image\//.test(file.type)) { wallNote(t('set_notPicture')); return; }
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
    const avg = window.cfxWallInk ? cfxWallInk.averageHex(sctx.getImageData(0, 0, 16, 16).data) : null;
    const kept = setWall({ mode: 'picture', image: canvas.toDataURL('image/jpeg', 0.82), avg: avg || '' });
    wallNote(kept ? '' : t('set_pictureTooBig'));
  };
  img.onerror = () => { URL.revokeObjectURL(url); wallNote(t('set_pictureOpenFail')); };
  img.src = url;
}
$('version').textContent = 'Claudefox v' + browser.runtime.getManifest().version;
// Local pages: Claude's question about a folder (answered in the helper's confirm window), and the allowed folders in
// Profile > Permissions.
const FILE_ACCESS_OFF = t('set_fileAccessOff');
const CONFIRM_WAIT = t('set_confirmWait');
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
  $('localCount').textContent = grants.length === 1 ? t('set_oneAllowed') : grants.length ? t('set_nAllowed', grants.length) : t('set_noneAllowed');
  const list = $('localList');
  const sig = JSON.stringify(grants);
  if (list.dataset.sig !== sig) {   // rebuilt only when the list changes, so a focused Remove button keeps its focus
    list.dataset.sig = sig;
    list.textContent = '';
    for (const f of grants) {
      const li = el('li');
      const name = el('span', 'mono', f);
      name.title = f;
      const rm = el('button', 'link', t('set_remove'));
      rm.type = 'button';
      rm.setAttribute('aria-label', t('set_removeAria', f));
      rm.addEventListener('click', () => send('localGrantRemove', { folder: f }));
      li.append(name, rm);
      list.appendChild(li);
    }
  }
  $('localNote').textContent = s.fileAccess === 'no' ? FILE_ACCESS_OFF : t('set_localNote');
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
      const b = actBtn(value === 'allow' ? t('set_allow') : t('set_block'), 'link', () => send('siteListSet', { site, value }));
      b.setAttribute('aria-pressed', String(sites[site] === value));
      return b;
    });
    const rm = actBtn(t('set_remove'), 'link', () => send('siteListSet', { site, value: null }));
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
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sites) renderSites(changes.sites.newValue || {});
    if (area === 'local' && changes.macros) loadMacros();   // Macros (below): another window saved
  });
} catch {}

// Tools and plugins (Settings). Switches, sign-in, add and remove go to the helper through the background page.
$('toolsCheck').addEventListener('click', () => send('toolsCheck'));
$('addBtn').addEventListener('click', () => {
  const name = $('addName').value.trim(), target = $('addTarget').value.trim();
  if (!name || !target) { $('addName').focus(); return; }
  const local = !/^https?:\/\//i.test(target);
  const go = () => send('toolAdd', { name, target, header: $('addHeader').value.trim(), on: true });
  if (local) askConfirm(t('set_addLocalAsk', name), go, t('set_addAndOn'));
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
  $('toolYes').textContent = yes || t('set_turnOn');
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
// The upload card: the same, by the id panel.js put on the card.
function answerUploadCard(allow) { const id = $('uploadCard').dataset.id; if (id) send('uploadAnswer', { id, allow }); }
$('uploadAllow').addEventListener('click', () => answerUploadCard(true));
$('uploadDeny').addEventListener('click', () => answerUploadCard(false));
function answerWatch(allow) { if (state.watchAsk) send('watchAnswer', { id: state.watchAsk.id, allow }); }
$('siteMsg').addEventListener('click', () => answerSite('message'));
$('siteChat').addEventListener('click', () => answerSite('chat'));
$('siteDeny').addEventListener('click', () => answerSite('deny'));
$('siteAllow').addEventListener('click', () => answerSite('allow'));
function answerSite(choice) { if (state.siteAsk) send('siteAnswer', { id: state.siteAsk.id, choice }); }
// Automatic (state key trusted): a turn-on waits for the helper's confirm window, so the switch shows the state until that says yes
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
  const who = a.email || t('set_claudeAccount');
  const card = el('section', 'card acctcard' + (a.loggedIn ? '' : ' off'));
  const txt = el('div', 'who');
  txt.append(el('div', 'name', who), el('div', 'muted', [a.plan && t('set_planName', a.plan), a.org, a.loggedIn ? '' : t('set_signedOut')].filter(Boolean).join(' · ')));
  const head = el('div', 'acct');
  head.append(el('div', 'avatar', who.trim()[0].toUpperCase()), txt);
  const stopped = s.agent === 'stopped' || !!s.accountLogin;   // no account changes while a sign-in window is open
  const acts = el('div', 'aacts');
  if (a.active) acts.appendChild(el('span', 'pill active', t('set_inUse')));
  else acts.appendChild(actBtn(a.id === s.accountBusy ? t('set_switching') : a.loggedIn ? t('set_use') : t('set_signIn'), 'primary', () => send(a.loggedIn ? 'accountUse' : 'accountSignIn', { id: a.id }), stopped || !!s.accountBusy));
  const confirm = el('div', 'confirm');
  confirm.hidden = true;
  const answers = el('div', 'confirm-btns');
  answers.append(
    actBtn(t('set_cancel'), 'ghost', () => { confirm.hidden = true; }),
    actBtn(t('set_remove'), 'primary', () => { confirm.hidden = true; send('accountRemove', { id: a.id }); }));
  confirm.append(el('p', '', t('set_removeAccountAsk', who)), answers);
  if (!a.active) acts.appendChild(actBtn(t('set_remove'), 'ghost', () => { confirm.hidden = false; }, stopped || !!s.accountBusy));
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
  line.textContent = moving ? t('set_switchingChat', moving.email || t('set_thatAccount'))
    : differs ? t('set_chatDiffers', inUse.email, addon)
    : inUse ? t('set_chatUses', inUse.email || t('set_thisAccount')) : '';
  line.hidden = !line.textContent;
  const result = s.accountNote;
  $('acctNote').textContent = result ? result.text : '';
  $('acctNote').className = 'note ' + (result && result.ok ? 'good' : 'bad');
  $('acctNote').hidden = !result;
  const list = $('acctList');
  list.textContent = '';
  for (const a of accts) list.appendChild(accountCard(a, s));
  const note = s.native !== 'connected' ? t('set_connectHelperAccts') : accts.length ? '' : t('set_noAccounts');
  $('acctEmpty').textContent = note;
  $('acctEmpty').hidden = !note;
  $('acctLogin').hidden = !busy;
  $('accountAdd').disabled = s.native !== 'connected' || s.agent === 'stopped' || busy || !!s.accountBusy;
  $('accountAdd').textContent = busy ? t('set_waitingSignIn') : t('set_addAccount');
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
  connected: ['ok', t('set_stReady')], 'needs-auth': ['warn', t('set_stNeedsSignIn')], failed: ['bad', t('set_stNotAnswering')],
  'not-configured': ['', t('set_stNotSetUp')], pending: ['', t('set_stWaiting')], unknown: ['', ''], none: ['', ''],
};
// The helper's busy words, as the line under the tools: one it does not know here is shown in English.
const BUSY_KEY = { adding: 'set_busyAdding', removing: 'set_busyRemoving', installing: 'set_busyInstalling' };

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

function renderTools(s) {
  const tools = s.tools;
  const sig = JSON.stringify([tools, s.native, s.agent, s.toolLogin]);
  if (sig === lastToolsSig) return;
  lastToolsSig = sig;
  const box = $('toolsList');
  box.textContent = '';
  $('toolsCheck').hidden = s.native !== 'connected';
  if (s.native !== 'connected') { $('toolsSummary').textContent = ''; box.appendChild(el('div', 'tempty', t('set_connectHelperTools'))); return; }
  if (!tools) {
    box.appendChild(el('div', 'tempty', t('set_lookingTools')));
    if (!toolsAsked) { toolsAsked = true; send('tools'); }
    return;
  }
  const onCount = [...tools.plugins, ...tools.connectors, ...tools.added].filter(x => x.on).length;
  $('toolsSummary').textContent = onCount ? t('set_onCount', onCount) : '';
  $('toolsCheck').textContent = tools.busy === 'checking' ? t('set_checking') : t('set_check');
  $('toolsCheck').disabled = !!tools.busy;
  const groups = [
    [t('set_groupRecommended'), tools.plugins.filter(p => p.recommended).map(item => ({ kind: 'plugin', item }))],
    [t('set_groupPlugins'), tools.plugins.filter(p => !p.recommended).map(item => ({ kind: 'plugin', item }))],
    [t('set_groupConnectors'), tools.connectors.map(item => ({ kind: 'server', item })), true],   // always listed
    [t('set_groupAdded'), tools.added.map(item => ({ kind: 'server', item }))],
  ];
  for (const [title, rows, always] of groups) {
    if (!rows.length && !always) continue;
    box.appendChild(el('div', 'tgroup', title));
    if (!rows.length) { box.appendChild(el('div', 'tempty', tools.checked ? t('set_noneOnAccount') : t('set_pressCheck'))); continue; }
    for (const r of rows) box.appendChild(toolRow(r.kind, r.item, s));
  }
  if (tools.busy && tools.busy !== 'checking') box.appendChild(el('div', 'tempty', BUSY_KEY[tools.busy] ? t(BUSY_KEY[tools.busy]) : `${tools.busy[0].toUpperCase()}${tools.busy.slice(1)}…`));
}

function toolRow(kind, item, s) {
  const row = el('div', 'trow' + (item.on ? ' on' : ''));
  const sw = el('input');
  sw.type = 'checkbox'; sw.className = 'switch'; sw.checked = !!item.on; sw.disabled = s.agent === 'stopped' || !!item.blocked;
  sw.setAttribute('aria-label', t('set_useInChat', item.label));
  const id = kind === 'plugin' ? item.id : item.name;
  sw.addEventListener('change', () => {
    $('toolsNote').hidden = true;
    // What runs programs on this PC is asked in the helper's confirm window (outside Zen): the switch follows the answer.
    if (sw.checked && item.local) { sw.checked = !!item.on; send('toolSet', { kind, id, value: true, label: item.label }); return; }
    send('toolSet', { kind, id, value: sw.checked, label: item.label });
  });
  const info = el('div', 'tinfo');
  const name = el('div', 'tname', item.label);
  if (item.recommended) name.appendChild(el('span', 'tag star', t('set_essential')));
  if (item.blocked) name.appendChild(el('span', 'tag bad', t('set_blockedTag')));
  else if (item.local) name.appendChild(el('span', 'tag warn', t('set_runsOnPc')));
  const sub = [];
  if (kind === 'plugin') {
    if (item.version && item.version !== 'unknown') sub.push('v' + item.version);
    if (item.skills) sub.push(t('set_skills'));
    if (item.servers.length) sub.push(t(item.servers.length === 1 ? 'set_toolServerOne' : 'set_toolServerMany', item.servers.length));
    sub.push(item.scope === 'synced' ? t('set_fromClaudeAi') : t('set_installedHere'));
  } else sub.push(item.transport === 'stdio' ? t('set_commandOf', item.target) : String(item.target || '').replace(/^https?:\/\//, ''));
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
    stat.appendChild(el('span', 'st warn', t('set_signingInDots')));
    const c = el('button', 'link', t('set_cancelLink')); c.addEventListener('click', () => send('toolCancel')); stat.appendChild(c);
  } else if (signName) {
    const b = el('button', 'link', t('set_signInLink'));
    b.addEventListener('click', () => send('toolSignIn', { name: signName }));
    b.disabled = !!login;
    stat.appendChild(b);
  }
  if (kind === 'server' && item.target && !item.name.startsWith('claude.ai ')) {
    const rm = el('button', 'link', t('set_removeLink'));
    rm.addEventListener('click', () => askConfirm(t('set_removeToolAsk', item.label), () => send('toolRemove', { name: item.name }), t('set_remove')));
    stat.appendChild(rm);
  }
  if (kind === 'plugin' && item.scope === 'user' && !item.recommended) {
    const rm = el('button', 'link', t('set_removeLink'));
    rm.addEventListener('click', () => askConfirm(t('set_uninstallAsk', item.label), () => send('pluginUninstall', { id: item.id }), t('set_uninstall')));
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
    li.textContent = t('set_nothingYet');
    ol.appendChild(li);
    return;
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = new Date(e.t).toLocaleTimeString(cfxI18n.lang() === 'pt_BR' ? 'pt-BR' : [], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

// Settings > Saving files: a made file is downloaded now (the default), or kept in the output folder in Claudefox's data folder.
const OUTPUT_NOTES = { download: t('set_outDownload'), store: t('set_outStore') };
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
  addMsg({ role: 'system', text: t('set_outputStored', m.name, m.path) });
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
    text.appendChild(el('div', m.broken ? 'mod-state bad' : 'mod-state', m.broken ? t('set_modStopped', m.broken) : (m.enabled ? t('set_modOn') : t('set_modOff'))));
    const sw = el('input', 'switch');
    sw.type = 'checkbox';
    sw.checked = !!m.enabled;
    sw.setAttribute('aria-label', t('set_modAria', m.name || m.id));
    sw.addEventListener('change', () => send('modUpdate', { id: m.id, enabled: sw.checked }));
    li.append(text, sw);
    ul.appendChild(li);
  }
  ul.hidden = !list.length;
  const empty = $('modsEmpty');
  empty.hidden = list.length > 0;
  empty.textContent = s.modsKnown ? t('set_noMods') : t('set_modsHelper');
}

$('modsCheck').addEventListener('click', () => send('modsRefresh'));
$('modsReload').addEventListener('click', () => location.reload());
$('modsOff').addEventListener('click', () => send('modsAllOff'));

// Macros (Settings): saved prompts, kept in storage.local `macros` (see lib/bg-macros.js for the shape and the alarms). The panel checks
// what the user types; the background cleans again when it reads the list.
let macrosCache = [];
let macroEditing = '';
const MACRO_NAME = /^[\p{L}\p{N}-]{1,30}$/u;
async function loadMacros() {
  try { const got = await browser.storage.local.get('macros'); macrosCache = Array.isArray(got.macros) ? got.macros : []; } catch { macrosCache = []; }
  renderMacros();
  return macrosCache;
}
function macroSiteOf(s) {
  const h = String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[\/?#].*$/, '').replace(/:\d*$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || h === 'localhost' ? h : '';
}
function renderMacros() {
  const list = $('macroList');
  list.textContent = '';
  for (const m of macrosCache) {
    const li = el('li');
    li.dataset.name = m.name;
    const when = !m.schedule ? '' : m.schedule.kind === 'daily' ? t('set_macroDaily', m.schedule.at) : t('set_macroEvery', m.schedule.hours);
    li.append(el('span', 'mono', '/' + m.name), el('span', 'muted small', when),
      actBtn(t('set_edit'), 'link macro-edit', () => macroEdit(m.name)), actBtn(t('set_remove'), 'link macro-del', () => macroRemove(m.name)),
      el('span', 'macro-text', m.text.replace(/\s+/g, ' ')));
    list.appendChild(li);
  }
}
function macroEdit(name) {
  const m = macrosCache.find(x => x.name === name);
  if (!m) return;
  macroEditing = name;
  $('macroName').value = m.name; $('macroText').value = m.text; $('macroArmy').value = (m.army || []).join('\n'); $('macroSites').value = (m.sites || []).join(', ');
  $('macroSched').value = m.schedule ? m.schedule.kind : 'none'; $('macroAt').value = m.schedule && m.schedule.at || ''; $('macroEvery').value = m.schedule && m.schedule.hours || '';
  $('macroCancel').hidden = false;
  $('macroErr').hidden = true;
}
function macroReset() {
  macroEditing = '';
  for (const id of ['macroName', 'macroText', 'macroArmy', 'macroSites', 'macroAt', 'macroEvery']) $(id).value = '';
  $('macroSched').value = 'none';
  $('macroCancel').hidden = true;
  $('macroErr').hidden = true;
}
async function macroPut(list) {
  macrosCache = list;
  renderMacros();
  await browser.storage.local.set({ macros: list });
}
async function macroRemove(name) {
  await loadMacros();
  if (macroEditing === name) macroReset();
  await macroPut(macrosCache.filter(m => m.name !== name));
}
async function macroSave() {
  await loadMacros();
  const name = $('macroName').value.trim().toLowerCase();
  const text = $('macroText').value.trim();
  const kind = $('macroSched').value;
  const sites = [];
  let bad = '';
  for (const s of $('macroSites').value.split(/[\s,;]+/).filter(Boolean)) { const h = macroSiteOf(s); if (!h) bad = bad || t('set_macroNotSite', s); else if (sites.indexOf(h) < 0) sites.push(h); }
  let schedule = null;
  let problem = '';
  if (!MACRO_NAME.test(name)) problem = t('set_macroNameRule');
  else if (COMMANDS.some(c => c.cmd === name)) problem = t('set_macroBuiltIn', name);
  else if (name !== macroEditing && macrosCache.some(m => m.name === name)) problem = t('set_macroExists', name);
  else if (!text) problem = t('set_macroNoText');
  else if (bad) problem = bad;
  else if (kind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test($('macroAt').value)) problem = t('set_macroTime');
    else schedule = { kind: 'daily', at: $('macroAt').value };
  } else if (kind === 'every') {
    const n = Number($('macroEvery').value);
    if (!Number.isInteger(n) || n < 1 || n > 24) problem = t('set_macroHours');
    else schedule = { kind: 'every', hours: n };
  }
  if (!problem && schedule && !sites.length) problem = t('set_macroNeedSites');
  $('macroErr').textContent = problem;
  $('macroErr').hidden = !problem;
  if (problem) return;
  const entry = { name, text, army: $('macroArmy').value.split('\n').map(t => t.trim()).filter(Boolean), sites, schedule };
  const next = macrosCache.filter(m => m.name !== macroEditing && m.name !== name);
  const at = macrosCache.findIndex(m => m.name === macroEditing);
  at >= 0 && macroEditing ? next.splice(Math.min(at, next.length), 0, entry) : next.push(entry);
  macroReset();
  await macroPut(next);
}
$('macroSave').addEventListener('click', macroSave);
$('macroCancel').addEventListener('click', macroReset);
loadMacros();
