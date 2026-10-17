'use strict';
// C12 streaming render, in the real panel under jsdom with a fake clock: a message is redrawn only when its rev changed, a streaming reply's Markdown
// renders at most every 150 ms (the final text always), the chat is saved once the stream pauses for 1 s or ends, and the army model line follows the Max effort switch.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const dir = require('path').join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(dir);
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window; const sent = []; const local = {}; const saved = []; let onMsg;
w.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => onMsg = f } }), getManifest: () => ({ version: '0.4.0' }) },
  storage: { session: { get: async () => ({}), set: async o => { saved.push(o); } },
    local: { get: async k => (k in local ? { [k]: local[k] } : {}), set: async o => { Object.assign(local, o); } } },
  tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } } };
let mdCalls = 0;
w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;');
const realMd = w.cfxMarkdown; w.cfxMarkdown = (...a) => { mdCalls++; return realMd(...a); };
w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8')); evalPanel(dom, dir, panelFiles);
const $ = id => w.document.getElementById(id);
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };

// A fake clock for what the panel schedules after start-up: Date.now, setTimeout and requestAnimationFrame.
let now = 1e12; const timers = new Map(); let tid = 1; const frames = [];
function advance(ms) {
  const end = now + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
    if (!next) break;
    now = Math.max(now, next.t.at); timers.delete(next.id); next.t.fn();
  }
  now = end;
}
function frame() { const fs2 = frames.splice(0); for (const f of fs2) f(now); }
const fake = () => {
  w.Date.now = () => now;
  w.setTimeout = (fn, ms) => { const id = tid++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  w.clearTimeout = id => { timers.delete(id); };
  w.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
};
const base = { agent: 'active', signedIn: true, account: { email: 'f@example.com', name: 'F', uuid: 'u' }, native: 'connected', hostVersion: '0.4.0',
  claude: { installed: true, loggedIn: true, email: 'f@example.com', plan: 'pro' }, debugPort: 'off', pending: 0, chatModel: 'speed', filesMode: 'read', filesFolder: '' };
const msgEls = () => [...$('messages').querySelectorAll('.msg')];
const text = (id, t) => onMsg({ type: 'chatEvent', id, event: { kind: 'text', text: t } });

(async () => {
  await new Promise(r => setTimeout(r, 50));
  onMsg({ type: 'state', state: base, log: [] });
  fake();

  // ---- rev: a message is rebuilt only when its rev changed
  w.eval(`chat = [{ role: 'user', text: 'one', rev: 1 }, { role: 'assistant', text: 'two', rev: 1, steps: [] }, { role: 'assistant', text: 'three', rev: 1, steps: [] }]; renderChat();`);
  const first = msgEls();
  ok('three messages drawn', first.length === 3);
  let md0 = mdCalls;
  w.eval('renderChat()');
  ok('same revs: no message rebuilt and no Markdown render', msgEls().every((el, i) => el === first[i]) && mdCalls === md0, 'md ' + (mdCalls - md0));
  w.eval(`chat[1].text = 'changed behind its back'`);
  w.eval('renderChat()');
  ok('a changed text with an unchanged rev is not looked at (rev is the signal)', msgEls().every((el, i) => el === first[i]));
  w.eval(`chat[1].rev++`);
  md0 = mdCalls;
  w.eval('renderChat()');
  const second = msgEls();
  ok('a bumped rev rebuilds that message only', second[0] === first[0] && second[1] !== first[1] && second[2] === first[2] && /changed behind/.test(second[1].textContent), 'md ' + (mdCalls - md0));
  ok('and renders the Markdown of that one message once', mdCalls - md0 === 1);

  // ---- a streamed reply: 20 deltas inside 150 ms
  w.eval(`chat = []; renderChat();`);
  advance(5000);
  $('input').value = 'hi'; $('composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
  const id = sent.find(m => m.type === 'chat').id;
  advance(1000); frame();
  const reply = () => msgEls().filter(e => e.classList.contains('assistant')).pop();
  saved.length = 0; md0 = mdCalls;
  for (let i = 0; i < 20; i++) { text(id, `word${i} `); advance(5); frame(); }   // 100 ms in all
  ok('20 text deltas within 150 ms: at most 2 Markdown renders of the reply', mdCalls - md0 <= 2 && mdCalls - md0 >= 1, 'md ' + (mdCalls - md0));
  ok('no save during the burst', saved.length === 0, 'saves ' + saved.length);
  advance(150); frame();
  ok('the reply catches up once the throttle has passed', /word19/.test(reply().textContent));
  md0 = mdCalls;
  for (let i = 20; i < 40; i++) { text(id, `word${i} `); advance(5); frame(); }
  const lastWord = () => /word39/.test(reply().textContent);
  ok('the next burst is throttled too', mdCalls - md0 <= 2, 'md ' + (mdCalls - md0));
  ok('no save during the second burst either', saved.length === 0);

  // ---- saves wait for the stream to pause 1 s
  advance(900);
  ok('no save 900 ms after the last delta', saved.length === 0);
  advance(150);
  ok('one save 1 s after the stream pauses', saved.length === 1, 'saves ' + saved.length);
  ok('the pause also drew the last words', lastWord());
  text(id, 'tail'); advance(5); frame();
  advance(20);
  onMsg({ type: 'chatDone', id, ok: true });
  advance(400);
  ok('a save when the turn ends', saved.length === 2, 'saves ' + saved.length);
  ok('the final text renders when the turn ends', /tail/.test(reply().textContent) && !reply().classList.contains('pending'));
  ok('the saved chat carries the final text and a rev', /tail$/.test(saved[1].chat[saved[1].chat.length - 1].text.trim()) && saved[1].chat.every(m => m.rev >= 1));

  // ---- the final text is never held back by the throttle
  $('input').value = 'again'; $('composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
  const id2 = sent.filter(m => m.type === 'chat').pop().id;
  advance(1000); frame();
  text(id2, 'first '); advance(10); frame();
  text(id2, 'second'); advance(10); frame();
  onMsg({ type: 'chatDone', id: id2, ok: true });
  ok('a turn that ends inside the throttle window shows its whole text at once', /first second/.test(reply().textContent) && !reply().classList.contains('pending'), reply().textContent.slice(0, 60));

  // ---- the army model line follows the Max effort switch
  onMsg({ type: 'state', state: { ...base, chatModel: 'quality', chatArmy: true }, log: [] });
  ok('army line, switch off: high effort', $('modelLine').textContent === 'Opus 5.5 · high effort · army of 5 Haiku', $('modelLine').textContent);
  $('armyMax').checked = true; $('armyMax').dispatchEvent(new w.Event('change'));
  ok('army line, switch on: max effort (at once, without a new state)', $('modelLine').textContent === 'Opus 5.5 · max effort · army of 5 Haiku', $('modelLine').textContent);
  ok('and the switch is remembered', local.armyMax === true);
  onMsg({ type: 'state', state: { ...base, chatModel: 'quality', chatArmy: true, armyToday: 1 }, log: [] });
  ok('army line stays max after a new state', $('modelLine').textContent === 'Opus 5.5 · max effort · army of 5 Haiku');
  $('armyMax').checked = false; $('armyMax').dispatchEvent(new w.Event('change'));
  ok('army line back to high effort', $('modelLine').textContent === 'Opus 5.5 · high effort · army of 5 Haiku');
  ok('no panel text claims the army always runs at max effort', !/Opus 5\.5 at max effort leads/.test(html));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
