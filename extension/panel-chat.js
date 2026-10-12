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
$('armyMax').addEventListener('change', e => { try { browser.storage.local.set({ armyMax: e.target.checked }); } catch {} });
(async () => { try { $('armyMax').checked = (await browser.storage.local.get('armyMax')).armyMax === true; } catch {} })();
document.addEventListener('click', e => { if (!$('armyCard').hidden && !e.target.closest('#armyCard, #armyBtn')) closeArmy(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('armyCard').hidden) { e.preventDefault(); closeArmy(true); } });
function armyRunsText(n, tokens) {
  const t = tokens > 0 ? ` · ${tokenCount(tokens)} tokens` : '';
  return n > ARMY_RECOMMENDED ? `Runs today: ${n}${t}. That's past the recommended ${ARMY_RECOMMENDED}, so usage is high.`
    : `Runs today: ${n} of ${ARMY_RECOMMENDED} recommended${t || '.'}`;
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
// In an empty chat the starter chips show. While the menu is open they move to its right and the menu comes down to their
// bottom line; if no chip fits beside the menu, the chips hide (visibility) and the menu still comes down. panel.css reads
// the numbers from the composer's custom properties (.composer.menu-open). Closed, or with no chips shown, nothing is set.
const menuBar = menu.parentElement;
const starters = document.querySelector('.starters');
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

