'use strict';
// The panel's onboarding, limit card and accessibility (E3, E6, E14), in jsdom: the limit card's reset time, each setup
// checklist line's action, focus after sending, aria-live on the progress block. Then, in a vm: the stop-claude command
// runs Stop, and the sign-in .bat keeps its three lookups in order with CRLF.   node test/dom-a11y.js
// Needs jsdom (NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const { html, files: panelFiles } = panelPage(dir);
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window; const sent = []; let onMsg;
w.browser = { runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => onMsg = f } }), getManifest: () => ({ version: '0.4.0' }) },
  storage: { session: { get: async () => ({}), set: async () => {} } },
  tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } } };
w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;'); w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8')); evalPanel(dom, dir, panelFiles);
const $ = id => w.document.getElementById(id);
const base = { agent: 'active', signedIn: false, native: 'missing', claude: null, debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '' };
const state = s => onMsg({ type: 'state', state: s, log: [] });
const sentOf = t => sent.filter(m => m.type === t);
const INSTALL = 'https://docs.claude.com/en/docs/claude-code/setup';
const SETUP_STEPS = 'Close Zen? No: just double-click Set up Claudefox.bat (or Set up Claude in Zen.bat), then press retry in Settings.';
// Adds a failed answer with this error text and the limit flag to the chat; returns the text of its limit card.
function limitCard(error) {
  w.eval(`chat.push(${JSON.stringify({ role: 'assistant', id: 'lim' + Math.random().toString(36).slice(2), text: '', steps: [], pending: false, error, limit: true })}); renderChat();`);
  const msgs = $('messages').querySelectorAll('.msg');
  const card = msgs[msgs.length - 1].querySelector('.limit');
  return card ? card.textContent : '(no card)';
}
(async () => {
  await new Promise(r => setTimeout(r, 50));
  state(base);
  ok('limit card: "resets 3pm" says the reset time', limitCard('Claude AI usage limit reached. Your limit resets 3pm.') === 'Your limit resets at 15:00.');
  ok('limit card: "resets at 15:00" says the reset time', limitCard('Claude AI usage limit reached, resets at 15:00') === 'Your limit resets at 15:00.');
  ok('limit card: "resets 3:30 PM" says 15:30', limitCard('Usage limit reached. It resets 3:30 PM.') === 'Your limit resets at 15:30.');
  ok('limit card: no reset time shows the message itself', limitCard('Claude AI usage limit reached') === 'Claude AI usage limit reached');
  state(base);
  const rows = [...$('setup').querySelectorAll('li')];
  const btn = i => rows[i] && rows[i].querySelector('.step-btn');
  ok('checklist: four lines, each with its action button', rows.length === 4 && [0, 1, 2, 3].every(i => !!btn(i)), 'lines ' + rows.length);
  btn(1)?.click();
  ok('checklist line 2 opens the Claude Code install page', sentOf('openLink').some(m => m.url === INSTALL));
  btn(2)?.click();
  ok('checklist line 3 sign-in sends runSignIn', sentOf('runSignIn').length === 1);
  btn(3)?.click();
  ok('checklist line 4 sign-in sends signIn', sentOf('signIn').length === 1);
  btn(0)?.click();
  ok('checklist line 1 re-run setup shows the steps in the panel', $('messages').textContent.includes(SETUP_STEPS));
  state({ ...base, signedIn: true, native: 'connected', hostVersion: '0.4.0', account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, claude: { installed: true, loggedIn: true, email: 'f.work@example.com', plan: 'pro' } });
  const input = $('input'), sendBtn = $('sendBtn');
  input.value = 'hello';
  sendBtn.focus(); sendBtn.click();
  ok('the input keeps focus after sending', w.document.activeElement === input, 'focus on ' + (w.document.activeElement && w.document.activeElement.id));
  const pb = $('messages').querySelector('.progress');
  ok('the progress list is aria-live polite', !!pb && pb.getAttribute('aria-live') === 'polite', pb ? '' : 'no .progress block');
  await commandAndBat();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e.stack); process.exit(1); });

// The manifest's stop-claude command, run by the real background scripts in a vm with a stub browser; then the sign-in .bat.
async function commandAndBat() {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const cmd = (manifest.commands || {})['stop-claude'];
  ok('manifest: stop-claude is Alt+Shift+X and described as Stop Claude', !!cmd && !!cmd.suggested_key && cmd.suggested_key.default === 'Alt+Shift+X' && cmd.description === 'Stop Claude');
  const listeners = [];
  const api = name => new Proxy(() => undefined, { get: (t, p) => (p === 'then' ? undefined : (t[p] = t[p] || api(name + '.' + String(p)))), apply: () => undefined });
  const local = { get: async () => ({}), set: async () => {}, remove: async () => {} };
  const browser = new Proxy({
    commands: { onCommand: { addListener: f => listeners.push(f) } },
    storage: { local, session: local },
    runtime: { onConnect: { addListener() {} }, onMessage: { addListener() {} }, getManifest: () => manifest, getURL: u => 'moz-extension://test/' + u,
      connectNative: () => ({ postMessage() {}, disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }) },
  }, { get: (t, p) => (p in t ? t[p] : (t[p] = api('browser.' + String(p)))) });
  const ctx = vm.createContext({ browser, console, URL, URLSearchParams, TextEncoder, AbortController, Blob: require('buffer').Blob, btoa: s => Buffer.from(s, 'binary').toString('base64'), setTimeout, clearTimeout, setInterval: () => 0, fetch: async () => { throw new Error('no network in tests'); } });
  ctx.window = ctx;
  let loaded = true;
  try { for (const f of manifest.background.scripts) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }); } catch (e) { loaded = false; console.log('  ' + e.message); }
  ok('the background scripts load in a vm with a stub browser', loaded);
  if (loaded) {
    await vm.runInContext('cizState.load()', ctx);
    await vm.runInContext("cizState.set({ agent: 'active' })", ctx);
    listeners.forEach(f => f('some-other-command'));
    const kept = vm.runInContext('cizState.get().agent', ctx);
    listeners.forEach(f => f('stop-claude'));
    const after = vm.runInContext('cizState.get().agent', ctx);
    ok('the stop-claude command runs Stop: the agent stops, another command does not', listeners.length > 0 && kept === 'active' && after === 'stopped', kept + ' -> ' + after);
  }
  const bat = fs.readFileSync(path.join(root, 'tools', 'Sign in Claude Code.bat'), 'utf8');
  const a = bat.indexOf('%USERPROFILE%\\.local\\bin\\claude.exe'), b = bat.indexOf('where claude.exe'), c = bat.indexOf('%APPDATA%\\npm\\claude.cmd');
  ok('sign-in .bat looks in .local\\bin, then where claude.exe, then %APPDATA%\\npm\\claude.cmd', a >= 0 && a < b && b < c, [a, b, c].join(' '));
  ok('sign-in .bat keeps CRLF line endings', bat.includes('\r\n') && !/(^|[^\r])\n/.test(bat));
}
