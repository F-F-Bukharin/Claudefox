'use strict';
// Sidebar panel, the chat composer: Speed or Quality and the army, the current tab, the text bar, attachments, the + menu, slash commands, sending, and Improve Claude in Zen.

// One button flips Speed and Quality. The + on its left (Speed mode only) turns Speed Plus (Haiku at max effort) on and off.
function toggleMode() {
  send('setModel', { value: state.chatModel === 'quality' ? 'speed' : 'quality' });
}
function togglePlus() {
  send('setPlus', { value: !state.chatPlus });
}
$('modeBtn').addEventListener('click', toggleMode);
$('plusBtn').addEventListener('click', togglePlus);

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
// Max effort: remembered in storage.local (the background reads it when an army chat starts).
$('armyMax').addEventListener('change', e => { try { browser.storage.local.set({ armyMax: e.target.checked }); } catch {} paintModelLine(state); });
(async () => { try { $('armyMax').checked = (await browser.storage.local.get('armyMax')).armyMax === true; paintModelLine(state); } catch {} })();
document.addEventListener('click', e => { if (!$('armyCard').hidden && !e.target.closest('#armyCard, #armyBtn')) closeArmy(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('armyCard').hidden) { e.preventDefault(); closeArmy(true); } });
function armyRunsText(n, tokens) {
  const tok = tokens > 0 ? ` · ${tokenCount(tokens)} ${t('chat_tokens')}` : '';
  return n > ARMY_RECOMMENDED ? t('chat_armyRunsHigh', n, tok, ARMY_RECOMMENDED)
    : t('chat_armyRunsOf', n, ARMY_RECOMMENDED, tok || '.');
}

// ------------------------------------------------------------ current tab chip

async function refreshContext() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    $('ctxTab').textContent = tab ? (tab.title || tab.url || t('chat_untitled')) : '—';
    $('ctxTab').title = tab ? tab.url || '' : '';
    showStarters(!!tab && /^https?:\/\//i.test(tab.url || ''));
  } catch { $('ctxTab').textContent = '—'; }
}
browser.tabs.onActivated.addListener(refreshContext);
browser.tabs.onUpdated.addListener((id, info, tab) => { if (tab.active && (info.title || info.url)) refreshContext(); });
refreshContext();

// ------------------------------------------------------------ chat

const input = $('input');
input.addEventListener('input', () => { autoGrow(); slashIndex = 0; tabIndex = 0; renderSlash(); renderTabs(); });
input.addEventListener('blur', () => { closeSlash(); closeTabs(); });

// ------------------------------------------------------------ attachments (+ button, paste, drop, tab screenshot)

const ATTACH_MAX = 12, ATTACH_FILE = 32 * 1024 * 1024, ATTACH_TOTAL = 80 * 1024 * 1024;
let attachments = [];   // { id, name, size, type, file?: File, data?: base64, url?: preview }
let attachSeq = 0;

function sizeText(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }

function addFiles(list) {
  let total = attachments.reduce((n, a) => n + a.size, 0);
  const problems = [];
  for (const f of Array.from(list || [])) {
    if (attachments.length >= ATTACH_MAX) { problems.push(t('chat_attachMax', ATTACH_MAX)); break; }
    if (f.size > ATTACH_FILE) { problems.push(t('chat_fileTooBig', f.name)); continue; }
    if (total + f.size > ATTACH_TOTAL) { problems.push(t('chat_totalTooBig')); break; }
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
    else chip.appendChild(el('span', 'ext', ((/\.([a-z0-9]{1,5})$/i.exec(a.name) || [])[1] || t('chat_fileBadge')).toUpperCase()));
    chip.appendChild(el('span', 'an', a.name));
    chip.appendChild(el('span', 'as', sizeText(a.size)));
    const x = el('button', 'ax', '×');
    x.type = 'button'; x.setAttribute('aria-label', t('chat_removeFile', a.name));
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
    r.onerror = () => reject(new Error(t('chat_cantRead', a.name)));
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
// In an empty chat the starter chips show. While the menu is open they move to its right and the menu comes down to their
// bottom line; if no chip fits beside the menu, the chips hide (visibility) and the menu still comes down. panel.css reads
// the numbers from the composer's custom properties (.composer.menu-open). Closed, or with no chips shown, nothing is set.
const menuBar = menu.parentElement;
const starters = document.querySelector('.starters');
// The starter chips: five reading chips on a web page, the three commands otherwise. The chips are reused in place, so
// showStarters changes only their text and fill, and does nothing when the set shown is the one wanted already.
const WEB_STARTERS = [
  [t('chat_starterSummarize'), 'Summarize this page'],
  [t('chat_starterKeyPoints'), 'Give me the key points of this page'],
  [t('chat_starterTranslate'), 'Translate this page to Portuguese (Brazil)'],
  ['/tabs', '/tabs'],
  ['/help', '/help'],
];
const PLAIN_STARTERS = [[t('chat_starterSummarize'), 'Summarize this page'], ['/tabs', '/tabs'], ['/help', '/help']];
let shownStarters = null;
function showStarters(web) {
  const pairs = web ? WEB_STARTERS : PLAIN_STARTERS;
  if (pairs === shownStarters) return;
  shownStarters = pairs;
  const chips = [...starters.querySelectorAll('.chip')];
  pairs.forEach(([label, fill], i) => {
    let chip = chips[i];
    if (!chip) { chip = document.createElement('button'); chip.className = 'chip'; starters.appendChild(chip); }
    chip.textContent = label;
    chip.dataset.fill = fill;
  });
  chips.slice(pairs.length).forEach(chip => chip.remove());
}
function placeMenuBar() {
  menuBar.classList.remove('menu-open', 'chips-hidden');
  menuBar.style.removeProperty('--chips-ml');
  menuBar.style.removeProperty('--menu-bottom');
  if (menu.hidden || !starters.offsetHeight) return;   // closed, or no chips shown (a chat with messages)
  const chipsLeft = menu.offsetLeft + menu.offsetWidth + 12;   // 12px between the menu's right edge and the chips
  const widest = Math.max(...[...starters.querySelectorAll('.chip')].map(c => c.offsetWidth));
  if (starters.offsetLeft + starters.offsetWidth - chipsLeft < widest) menuBar.classList.add('chips-hidden');   // no room: hide them
  else menuBar.style.setProperty('--chips-ml', `${chipsLeft - starters.offsetLeft}px`);
  menuBar.classList.add('menu-open');
  menuBar.style.setProperty('--menu-bottom', `${starters.offsetTop + starters.offsetHeight}px`);
}
function openMenu(open) {
  menu.hidden = !open;
  $('moreBtn').setAttribute('aria-expanded', String(open));
  placeMenuBar();
  if (open) { const first = menu.querySelector('button'); if (first) first.focus(); }
}
window.addEventListener('resize', placeMenuBar);
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
  else if (act === 'new') { leaveImprove(); histNewChat(); chat = []; resetAcctCard(); saveChat(); send('newChat'); renderChat(); input.focus(); }
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
starters.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  input.value = chip.dataset.fill; autoGrow(); submit();
});

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

// A draft from a right-click item fills this window's text bar, unsent, and takes the focus. A draft is taken once: a state
// that carries the same draft again is skipped, and a state with no draft forgets it, so the same item can draft again.
// A draft for another window is left to that window's panel.
let takenDraft = '';
function takeDraft(draft) {
  if (!draft) { takenDraft = ''; return; }
  const key = draft.windowId + '\n' + draft.text;
  if (key === takenDraft) return;
  takenDraft = key;
  browser.windows.getCurrent().then(w => {
    if (w.id !== draft.windowId) { takenDraft = ''; return; }
    input.value = draft.text;
    autoGrow();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    send('draftTaken');
  });
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
  if (text.startsWith('/') && !attachments.length) { input.value = ''; autoGrow(); addMsg({ role: 'user', text }); return runSlash(text); }
  if (state.agent === 'stopped') { addMsg({ role: 'system', text: t('chat_stopped') }); return; }
  if (!state.signedIn) { addMsg({ role: 'system', text: t('chat_signInFirst') }); return; }
  if (chat.length === 0 && !accountChoice && acctMismatch()) return showAcctCard();
  const files = attachments;
  attachments = [];
  renderAttachments();
  input.value = ''; autoGrow();
  input.focus();
  let sendText = text, tabSites = [];
  if (!improveOn && TAB_TOKEN_TEST.test(text)) ({ text: sendText, sites: tabSites } = await tabsToText(text));   // only a text that mentions a tab waits here
  const id = `p${Date.now().toString(36)}${chatSeq++}`;
  const extra = Object.assign(improveOn ? { improve: true } : histResumeExtra(), tabSites.length ? { tabSites } : {});
  const waits = isBusy();   // an answer runs (here or in another window): this message waits its turn, in a pending bubble
  addMsg(Object.assign({ role: 'user', cid: id, text: sendText || (improveOn ? IMPROVE_EMPTY : ''), files: files.map(a => ({ name: a.name, size: a.size })) }, waits ? { queued: true } : {}));
  if (!waits) addMsg({ role: 'assistant', id, text: '', steps: [], pending: true, startedAt: Date.now() });
  if (!files.length) { send('chat', Object.assign({ id, text: sendText }, extra)); return; }
  let payload = [];
  try { payload = await Promise.all(files.map(readAttachment)); }
  catch (e) { return onChatDone({ id, ok: false, error: e.message }); }
  finally { for (const a of files) if (a.url && a.url.startsWith('blob:')) URL.revokeObjectURL(a.url); }
  send('chat', Object.assign({ id, text: sendText, attachments: payload }, extra));
}

// The account card. A chat runs on the Claude Code account, and this browser is signed in to claude.ai as state.account. When the
// two differ, the first message of a chat waits here: the card names both, and the message stays in the input until the user picks
// the Claude Code account for this chat (then it is sent) or opens Accounts (then it is not). New chat asks again.
let accountChoice = false;   // "Use <B> for this chat" was pressed in this chat
function acctMismatch() {
  const a = state.account && state.account.email, b = state.claude && state.claude.email;
  return !!(a && b && a.toLowerCase() !== b.toLowerCase());
}
function showAcctCard() {
  $('accountCardText').textContent = t('chat_acctText', state.account.email, state.claude.email);
  $('accountUse').textContent = t('chat_acctUse', state.claude.email);
  $('accountCard').hidden = false;
}
function resetAcctCard() { accountChoice = false; $('accountCard').hidden = true; }
$('accountUse').addEventListener('click', () => { accountChoice = true; $('accountCard').hidden = true; submit(); });
$('accountOpen').addEventListener('click', () => { $('accountCard').hidden = true; openAccounts(); });

// The slash commands. The "/" menu lists them all, and the starter chips show only the essentials. A command with an act
// runs the same action as the + menu; the rest are the test commands (no Claude needed).
const COMMANDS = [
  { cmd: 'help', text: t('chat_cmdHelp') },
  { cmd: 'tabs', text: t('chat_cmdTabs') },
  { cmd: 'research', text: t('chat_cmdResearch') },
  { cmd: 'screenshot', act: 'snap', text: t('chat_cmdScreenshot') },
  { cmd: 'upload', act: 'upload', text: t('chat_cmdUpload') },
  { cmd: 'caveman', act: 'caveman', text: t('chat_cmdCaveman') },
  { cmd: 'tools', act: 'tools', text: t('chat_cmdTools') },
  { cmd: 'improve', act: 'improve', text: t('chat_cmdImprove') },
  { cmd: 'clear', text: t('chat_cmdClear') },
  { cmd: 'ping', text: t('chat_cmdPing') },
];
function helpText() {
  return t('chat_helpIntro') + '\n\n'
    + t('chat_helpCommands') + '\n'
    + COMMANDS.map(c => `/${c.cmd}: ${c.text}`).join('\n');
}
async function runSlash(text) {
  const cmd = text.slice(1).split(/\s+/)[0].toLowerCase();
  const known = COMMANDS.find(c => c.cmd === cmd);
  if (!known) {   // a saved macro (Settings → Macros) sends its text; a built-in name is never shadowed (the settings refuse it)
    await loadMacros();
    const macro = macrosCache.find(m => m.name === cmd);
    if (macro) return sendMacro(macro, text.slice(1 + cmd.length).trim());
    return addMsg({ role: 'error', text: t('chat_unknownCmd', cmd) });
  }
  if (known.act) return doAct(known.act);
  if (cmd === 'research') {   // "Read these tabs and compare them." plus the mentioned tabs; the army runs when Quality has it on
    const named = await tabsToText(text.slice(1 + cmd.length).trim());
    if (!named.sites.length) return addMsg({ role: 'error', text: t('chat_mentionOne') });
    return sendMacro({ text: 'Read these tabs and compare them.' }, named.text, named.sites);
  }
  if (cmd === 'help') return addMsg({ role: 'assistant', text: helpText() });
  if (cmd === 'clear') { histNewChat(); chat = []; resetAcctCard(); saveChat(); send('newChat'); return renderChat(); }
  const tool = { tabs: 'tabs_list', ping: 'ping' }[cmd];
  const out = await call(tool);
  if (!out.ok) return addMsg({ role: 'error', text: out.error });
  if (tool === 'ping') return addMsg({ role: 'assistant', text: t('chat_pong', out.result.version) });
  addMsg({ role: 'assistant', text: out.result.length === 1 ? t('chat_tabsOne', out.result.length) : t('chat_tabsMany', out.result.length), tabs: out.result.slice(0, 50) });
}

// A macro sends its text like a typed message. With army tasks it sends in Quality with the army on and lists the tasks.
async function sendMacro(macro, more, tabSites) {
  if (state.agent === 'stopped') { addMsg({ role: 'system', text: t('chat_stopped') }); return; }
  if (!state.signedIn) { addMsg({ role: 'system', text: t('chat_signInFirst') }); return; }
  const tasks = macro.army || [];
  const text = macro.text + (more ? '\n\n' + more : '') + (tasks.length ? '\n\nTasks for the army:\n' + tasks.map((t, i) => `${i + 1}. ${t}`).join('\n') : '');
  const id = `p${Date.now().toString(36)}${chatSeq++}`;
  const extra = Object.assign(histResumeExtra(), tasks.length ? { army: true } : {}, tabSites && tabSites.length ? { tabSites } : {});
  const waits = isBusy();
  addMsg(Object.assign({ role: 'user', cid: id, text, files: [] }, waits ? { queued: true } : {}));
  if (!waits) addMsg({ role: 'assistant', id, text: '', steps: [], pending: true, startedAt: Date.now() });
  send('chat', Object.assign({ id, text }, extra));
}

// The "/" menu: it opens when the text bar holds "/" and letters, and narrows as you type.
const slashMenu = $('slashMenu');
let slashIndex = 0;
function slashMatches() {
  const v = input.value;
  if (!v.startsWith('/') || /\s/.test(v) || attachments.length) return null;
  const q = v.slice(1).toLowerCase();
  return COMMANDS.concat(macrosCache.map(m => ({ cmd: m.name, text: m.text.replace(/\s+/g, ' ').slice(0, 60) }))).filter(c => c.cmd.startsWith(q));
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

// ------------------------------------------------------------ "@" mentions a tab
// "@" at the start of a word lists this window's web tabs (title and site), narrowed as you type. A choice goes into the text as
// @[title](tab:id). On a send the tokens of this window's tabs become [tab id: title (site)], and the sites go with the message.
const tabMenu = $('tabMenu');
const TAB_AT = /(^|\s)@([^\s@]*)$/;
const TAB_TOKEN_TEST = /@\[[^\]]*\]\(tab:\d+\)/;
let tabShown = [], tabIndex = 0, tabAsk = 0;
const tabTitle = (t, max) => String(t || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
function tabSite(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '').toLowerCase() : ''; } catch { return ''; }
}
async function windowTabs() {
  await winReady;
  let all = [];
  try { all = await browser.tabs.query(winId == null ? { currentWindow: true } : { windowId: winId }); } catch {}
  return all.filter(t => tabSite(t.url)).map(t => ({ id: t.id, title: t.title || '', site: tabSite(t.url) }));
}
async function renderTabs() {
  const ask = ++tabAsk;
  const m = TAB_AT.exec(input.value.slice(0, input.selectionStart == null ? input.value.length : input.selectionStart));
  if (!m) return closeTabs();
  const q = m[2].toLowerCase();
  const list = (await windowTabs()).filter(t => (t.title + ' ' + t.site).toLowerCase().includes(q));
  if (ask !== tabAsk) return;   // typed on while the tabs were read
  if (!list.length) { tabShown = []; tabMenu.hidden = true; return; }
  tabShown = list;
  tabIndex = Math.min(tabIndex, list.length - 1);
  drawTabs();
}
function drawTabs() {
  const list = tabShown;
  tabMenu.replaceChildren(...list.map((t, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(i === tabIndex));
    b.dataset.tab = String(t.id);
    const x = document.createElement('span');
    x.className = 'mtext';
    const a = document.createElement('span');
    a.className = 'ttl';
    a.textContent = tabTitle(t.title, 80) || t.site;
    const c = document.createElement('span');
    c.className = 'site';
    c.textContent = t.site;
    x.append(a, c);
    b.append(x);
    b.addEventListener('mousedown', e => e.preventDefault());   // the text bar keeps the focus
    b.addEventListener('click', () => pickTab(t));
    return b;
  }));
  tabMenu.hidden = false;
}
function closeTabs() { tabAsk++; tabShown = []; tabMenu.hidden = true; }
function pickTab(t) {
  const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
  const m = TAB_AT.exec(input.value.slice(0, caret));
  closeTabs();
  if (!m) return;
  const start = caret - m[2].length - 1;
  const token = `@[${tabTitle(t.title, 80) || t.site}](tab:${t.id}) `;
  input.value = input.value.slice(0, start) + token + input.value.slice(caret);
  input.setSelectionRange(start + token.length, start + token.length);
  autoGrow();
  input.focus();
}
// Before the "/" menu's own handler: the picker owns the arrows, Enter and Escape while it is open.
input.addEventListener('keydown', e => {
  if (tabMenu.hidden || !tabShown.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopImmediatePropagation();
    tabIndex = (tabIndex + (e.key === 'ArrowDown' ? 1 : -1) + tabShown.length) % tabShown.length;
    drawTabs();
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation(); closeTabs();
  } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault(); e.stopImmediatePropagation(); pickTab(tabShown[tabIndex]);
  }
}, true);
// The text with this window's tab mentions as [tab id: title (site)] and the sites they name. A mention of another window's tab stays.
async function tabsToText(text) {
  if (!TAB_TOKEN_TEST.test(text)) return { text, sites: [] };
  const byId = new Map((await windowTabs()).map(t => [String(t.id), t]));
  const sites = [];
  const out = text.replace(/@\[[^\]]*\]\(tab:(\d+)\)/g, (all, id) => {
    const t = byId.get(id);
    if (!t) return all;
    if (!sites.includes(t.site)) sites.push(t.site);
    return `[tab ${t.id}: ${tabTitle(t.title, 100) || t.site} (${t.site})]`;
  });
  return { text: out, sites };
}

// ------------------------------------------------------------ improve Claude in Zen (the + menu)
// Claude edits a copy of the add-on, and the reply ends with a card: Apply writes the change into the add-on,
// Discard drops it. Nothing changes in the add-on until Apply.
const IMPROVE_EMPTY = 'Improve Claude in Zen: pick one change that helps most.';
let improveOn = false;
function startImprove() {
  if (state.agent === 'stopped' || !state.signedIn) { addMsg({ role: 'system', text: t('chat_improveNeedsStart') }); return; }
  improveOn = true;
  document.body.classList.add('improving');
  $('improveBar').hidden = false;
  input.placeholder = t('chat_emptyPicks');
  input.focus();
}
function leaveImprove() {
  improveOn = false;
  document.body.classList.remove('improving');
  $('improveBar').hidden = true;
  input.placeholder = t('chat_messagePlaceholder');
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
  if (!p.changed) box.appendChild(el('p', 'pnote', t('chat_noChange')));
  else {
    box.appendChild(el('p', 'phead', t('chat_proposed', p.changed === 1 ? t('chat_filesOne', p.changed) : t('chat_filesMany', p.changed), p.added, p.removed)));
    const list = el('ul', 'pfiles');
    for (const f of p.files) list.appendChild(el('li', '', `${f.path}: ${f.status === 'added' ? t('chat_statusNew') : f.status === 'removed' ? t('chat_statusRemoved') : t('chat_statusEdited')}, +${f.added} −${f.removed}`));
    box.appendChild(list);
  }
  for (const b of p.blocked) box.appendChild(el('p', 'pwarn', b));
  if (p.tests) {
    box.appendChild(el('p', p.tests.ok ? 'ptests ok' : 'ptests bad', p.tests.ok ? t('chat_testsPassed', p.tests.summary) : t('chat_testsFailed', p.tests.summary)));
    if (!p.tests.ok && p.tests.tail) box.appendChild(el('pre', 'pdiff', p.tests.tail));
  } else if (p.changed) box.appendChild(el('p', 'pmuted', t('chat_notTested')));
  if (p.diff) {
    const det = document.createElement('details');
    det.appendChild(el('summary', '', t('chat_showChanges')));
    det.appendChild(el('pre', 'pdiff', p.diff));
    box.appendChild(det);
  }
  if (p.diffFile) box.appendChild(el('p', 'pmuted', t('chat_wholeDiff', p.diffFile)));
  const st = m.proposalState;
  if (st) box.appendChild(el('p', st.pending ? 'pmuted' : st.ok ? 'pdone' : 'pwarn', st.text));
  if (st && st.ok !== false) return box;   // applying, applied or discarded: nothing more to do here
  if (!p.changed) return box;
  const row = el('div', 'pbtns');
  const apply = el('button', 'pbtn primary', t('chat_apply'));
  apply.type = 'button';
  apply.disabled = !p.canApply;
  apply.title = p.canApply ? t('chat_applyTitle') : t('chat_applyBlocked');
  const discard = el('button', 'pbtn', t('chat_discard'));
  discard.type = 'button';
  apply.addEventListener('click', () => { setProposalState(p.id, { pending: true, text: t('chat_applying') }); send('selfApply', { id: p.id }); });
  discard.addEventListener('click', () => { setProposalState(p.id, { pending: true, text: t('chat_discarding') }); send('selfDiscard', { id: p.id }); });
  row.append(apply, discard);
  box.appendChild(row);
  return box;
}

function setProposalState(id, st) {
  const m = chat.find(x => x.proposal && x.proposal.id === id);
  if (!m) return;
  m.proposalState = st;
  bump(m);
  saveChat();
  renderChat();
}

function onSelfResult(msg) {
  setProposalState(String(msg.id || ''), { ok: !!msg.ok, text: String(msg.text || '') });
}

