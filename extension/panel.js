'use strict';
// Sidebar panel: three pages (chat, profile, settings).
// Agent state lives in the background page; chat history lives in
// storage.session, so it survives closing the panel and clears when Zen quits.

const $ = id => document.getElementById(id);

let state = {};
let chat = [];
// This window's id (the sidebar belongs to one window). Each window keeps its own chat in storage.session under win:<id>.
let winId = null;
const winKey = () => (winId == null ? '' : 'win:' + winId);
const winReady = (async () => { try { const w = await browser.windows.getCurrent(); if (w && typeof w.id === 'number') winId = w.id; } catch {} })();
const pendingCalls = new Map();
let callSeq = 1;

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
// Opens the Accounts group on the Profile page: the switch button, and the account card's "Open Accounts".
function openAccounts() {
  showPage('profile');
  const group = $('accountsGroup');
  if (group.scrollIntoView) group.scrollIntoView({ block: 'start' });
}
$('switchClaude').addEventListener('click', openAccounts);
$('updateBtn').addEventListener('click', () => send('updateAddon'));
$('clearLog').addEventListener('click', () => send('clearLog'));
// The log button in the chat header opens the Action log (Settings > Advanced).
$('logBtn').addEventListener('click', () => {
  showPage('settings');
  setSection('advancedHead', 'advancedBody', true);
  const card = document.querySelector('.logcard');
  if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start' });
});
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

// The site card: the line under "Claude wants to use <site>" for each thing Claude asks to do on the page.
const SITE_ACTIONS = { read: 'Read the page', act: 'Act on the page', open: 'Open the page', post: 'Submit a form', leave: 'Leave for this site' };
let siteShownId = '';   // the site card id last shown to the helper: siteShown goes once per id
let fillShownId = '', fillCardId = '';   // the fill card id last shown to the helper: fillShown goes once per id
function render(s, log) {
  if (typeof takeDraft === 'function') takeDraft(s.draft);
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
  // The picture card (download_image): the helper's question about one picture. Its id rides on the card (dataset.id).
  const dc = $('downloadCard');
  const prevId = dc.dataset.id || '';
  const dlId = s.downloadAsk ? String(s.downloadAsk.id) : '';
  dc.dataset.id = dlId;
  dc.hidden = !dlId;
  if (dlId) {
    $('downloadCardHost').textContent = String(s.downloadAsk.host || '').slice(0, 253);
    $('downloadCardName').textContent = String(s.downloadAsk.name || '').slice(0, 200);
    $('downloadCardFolder').textContent = String(s.downloadAsk.folder || '').slice(0, 500);
    if (prevId !== dlId) send('downloadShown', { id: dlId });   // once per card
  }
  $('watchCard').hidden = !s.watchAsk;
  if (s.watchAsk) {
    $('watchCardSource').textContent = String(s.watchAsk.source || '').slice(0, 200);
    if (watchShownId !== s.watchAsk.id) { watchShownId = s.watchAsk.id; send('watchShown', { id: s.watchAsk.id }); }
  }
  // Trusted: the switch mirrors the state (a turn-on waits for the confirm window, see panel-settings.js)
  $('trustedToggle').checked = !!s.trusted;
  $('trustedToggle').disabled = s.agent === 'stopped';
  // the site card: Claude asks before it uses a page on a site; a risky step offers only Allow and Deny
  $('siteCard').hidden = !s.siteAsk;
  if (s.siteAsk) {
    const risky = s.siteAsk.kind === 'risky';
    $('siteCardSite').textContent = String(s.siteAsk.site || '').slice(0, 200);
    $('siteCardAction').textContent = SITE_ACTIONS[s.siteAsk.action] || 'Use the page';
    $('siteMsg').hidden = risky;
    $('siteChat').hidden = risky;
    $('siteAllow').hidden = !risky;
    if (siteShownId !== s.siteAsk.id) { siteShownId = s.siteAsk.id; send('siteShown', { id: s.siteAsk.id }); }
  }
  $('fillCard').hidden = !s.fillAsk;
  if (s.fillAsk) {
    fillCardId = s.fillAsk.id;
    $('fillCardSite').textContent = String(s.fillAsk.site || '').slice(0, 200);
    $('fillRows').replaceChildren(...(s.fillAsk.rows || []).map(r => {
      const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
      th.textContent = String(r.label || '').slice(0, 200);
      td.className = 'mono'; td.textContent = String(r.value || '').slice(0, 200);
      tr.append(th, td);
      return tr;
    }));
    $('fillApprove').onclick = () => send('fillAnswer', { id: fillCardId, allow: true });
    $('fillDeny').onclick = () => send('fillAnswer', { id: fillCardId, allow: false });
    if (fillShownId !== s.fillAsk.id) { fillShownId = s.fillAsk.id; send('fillShown', { id: s.fillAsk.id }); }
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
  $('armyRuns').textContent = armyRunsText(runs, Number(s.armyTokensToday) || 0);
  $('armyRuns').classList.toggle('warnnote', runs > ARMY_RECOMMENDED);
  // the line under the outputs: what the next message runs on
  paintModelLine(s);

  // notice under the composer: why nothing will run right now
  $('composerHint').textContent =
    s.agent === 'stopped' ? 'Stopped. Press Start to let Claude act again.' :
    !s.signedIn ? 'Not signed in. Open the Profile page to sign in.' : isBusy() ? BUSY_HINT : '';

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

// First-run guide: the real setup state, in order, with the next action for each open step.
// The line under the outputs: what the next message runs on. The army lead runs at high effort, and at max when the Max effort switch is on.
function paintModelLine(s) {
  const quality = s.chatModel === 'quality';
  const plus = !quality && !!s.chatPlus;
  const armyEffort = $('armyMax').checked ? 'max' : 'high';
  $('modelLine').textContent = (quality && s.chatArmy ? `Opus 5.5 · ${armyEffort} effort · army of 5 Haiku` : quality ? 'Opus 5.5 · high effort' : plus ? 'Haiku 5.5 · max effort' : 'Haiku 5.5 · high effort')
    + (s.caveman && s.agent !== 'stopped' && s.signedIn ? ' · caveman' : '');
}

const INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';
const SETUP_STEPS = 'Close Zen? No: just double-click Set up Claudefox.bat (or Set up Claude in Zen.bat), then press retry in Settings.';

function renderSetup(s) {
  const c = s.claude || {};
  const steps = [
    { done: s.native === 'connected', title: 'Install the helper',
      hint: 'Install Node.js if you don\u2019t have it, then double-click "Set up Claude in Zen.bat" in the Claude in Zen folder.',
      action: ['Re-run setup', () => addMsg({ role: 'system', text: SETUP_STEPS })],
      alt: s.agent === 'active' && s.native !== 'connected' ? ['Retry', () => send('retryNative')] : null },
    { done: !!c.installed, title: 'Install Claude Code',
      hint: 'Open the install page, install Claude Code, then press Retry.',
      action: ['Open install page', () => send('openLink', { url: INSTALL_URL })],
      alt: s.native === 'connected' ? ['Retry', () => send('checkClaude')] : null },
    { done: !!c.loggedIn, title: 'Sign Claude Code in',
      hint: 'Double-click "Sign in Claude Code.bat" in the tools folder and click Authorize. The chat uses this account.',
      action: ['Sign in', () => send('runSignIn')] },
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
    if (!st.done) {
      const h = document.createElement('div'); h.className = 'step-hint'; h.textContent = st.hint;
      box.appendChild(h);
      for (const a of [st.action, st.alt]) {
        if (!a) continue;
        const b = document.createElement('button'); b.className = 'ghost step-btn'; b.textContent = a[0];
        b.addEventListener('click', a[1]);
        box.appendChild(b);
      }
    }
    li.append(mark, box);
    ol.appendChild(li);
  });
}

