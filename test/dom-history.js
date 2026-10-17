'use strict';
// Chat history (E2) in the real panel under jsdom: chats kept per account in storage.local, the history drawer (search, open and
// resume, export to Markdown, delete, clear). Needs jsdom (npm i --no-save jsdom, or NODE_PATH). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(EXT);
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
const sent = []; let onMsg;
const store = {}; const downloads = []; const blobs = [];
const keysOf = k => (k == null ? Object.keys(store) : typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k));
const clone = v => JSON.parse(JSON.stringify(v));
w.browser = {
  runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => onMsg = f } }), getManifest: () => ({ version: '0.11.0' }) },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: {
      get: async k => { const o = {}; for (const x of keysOf(k)) if (x in store) o[x] = clone(store[x]); return o; },
      set: async o => { Object.assign(store, clone(o)); },
      remove: async k => { for (const x of keysOf(k)) delete store[x]; },
    },
  },
  downloads: { download: async o => { downloads.push(o); return downloads.length; } },
  tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
};
w.URL.createObjectURL = b => { blobs.push(b); return 'blob:history-' + blobs.length; };
w.URL.revokeObjectURL = () => {};
w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cfxMarkdown=cfxMarkdown;');
w.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
evalPanel(dom, EXT, panelFiles);
const $ = id => w.document.getElementById(id);
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const readBlob = b => new Promise(r => { const fr = new w.FileReader(); fr.onload = () => r(fr.result); fr.readAsText(b); });
const base = { agent: 'active', signedIn: true, native: 'connected', claude: { installed: true, loggedIn: true }, chatModel: 'speed', filesMode: 'read', pending: 0 };
const accts = active => [{ id: 'a1', email: 'one@example.com', active: active === 'a1' }, { id: 'a2', email: 'two@example.com', active: active === 'a2' }];
const useAcct = a => onMsg({ type: 'state', state: { ...base, accounts: accts(a) }, log: [] });
const chatsSent = () => sent.filter(m => m.type === 'chat');
// One finished turn: the user types, Claude answers (optionally with tool steps), the turn ends with a session id.
async function turn(text, reply, steps, session) {
  $('input').value = text; $('composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
  const id = chatsSent().pop().id;
  for (const st of steps || []) {
    onMsg({ type: 'chatEvent', id, event: { kind: 'tool', id: 't' + st.name, name: st.name, input: JSON.stringify(st.input || {}) } });
    onMsg({ type: 'chatEvent', id, event: { kind: 'tool_result', id: 't' + st.name, error: false, text: 'ok' } });
  }
  onMsg({ type: 'chatEvent', id, event: { kind: 'text', text: reply } });
  onMsg({ type: 'chatDone', id, ok: true, sessionId: session || '' });
  await wait(450);   // the chat is saved once changes have paused (300 ms)
}
const newChat = () => w.document.querySelector('[data-act="new"]').click();
const list = a => store['chats:' + a] || [];
const rows = () => [...$('histList').querySelectorAll('.hist-item')];
const rowFor = title => rows().find(r => r.querySelector('.hist-title').textContent === title);
const search = async v => { $('histSearch').value = v; $('histSearch').dispatchEvent(new w.Event('input')); await wait(350); };
const btn = (row, cls) => row.querySelector('button.' + cls);
const localDate = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
(async () => {
  await wait(50);
  useAcct('a1');
  ok('a history button sits in the chat header', !!$('histBtn') && $('histBtn').closest('header') !== null && !!$('histDrawer') && $('histDrawer').hidden);
  // ---- a finished turn is saved, per account
  await turn('Alpha question about the page', 'It uses pineapple everywhere.', [{ name: 'get_page_text', input: { url: 'https://www.example.com/a' } }, { name: 'click', input: { text: 'Buy' } }], 'sess-alpha');
  ok('a finished turn saves chats:<account> with id, title, dates and the session id', list('a1').length === 1 && list('a1')[0].title === 'Alpha question about the page' && list('a1')[0].sessionId === 'sess-alpha' && list('a1')[0].created > 0 && list('a1')[0].updated >= list('a1')[0].created, JSON.stringify(list('a1')));
  const alphaId = (list('a1')[0] || {}).id;
  const msgs = store['chat:' + alphaId] || [];
  ok('... and chat:<id> holds the messages', msgs.filter(m => m.role === 'user').length === 1 && msgs.some(m => m.role === 'assistant' && /pineapple/.test(m.text)));
  newChat();
  await turn('B'.repeat(80), 'Second.', [], 'sess-b');
  ok('... a long first message gives a title of 60 characters', list('a1').length === 2 && list('a1')[0].title === 'B'.repeat(60), list('a1').map(c => c.title.length).join(','));
  ok('... and New chat started a new entry (two chats, two ids)', list('a1')[0].id !== alphaId && list('a1')[1].id === alphaId);
  // ---- accounts keep separate lists
  useAcct('a2'); newChat();
  await turn('Gamma for the second account', 'Fine.', [], 'sess-g');
  ok('two accounts keep separate lists', list('a1').length === 2 && list('a2').length === 1 && list('a2')[0].title === 'Gamma for the second account');
  useAcct('a1'); newChat();
  // ---- the drawer
  $('histBtn').click(); await wait(100);
  ok('the history button opens the drawer with this account\'s chats, newest first', !$('histDrawer').hidden && rows().length === 2 && rows()[0].querySelector('.hist-title').textContent === 'B'.repeat(60) && !rowFor('Gamma for the second account'), rows().map(r => r.textContent.slice(0, 30)).join('|'));
  await search('ALPHA');
  ok('search finds a chat by its title, in any case', rows().length === 1 && !!rowFor('Alpha question about the page'));
  await search('PineApple');
  ok('search finds a chat by message text, in any case', rows().length === 1 && !!rowFor('Alpha question about the page'));
  await search('nothing-like-this');
  ok('search with no match shows none', rows().length === 0);
  await search('');
  ok('clearing the search shows the whole list again', rows().length === 2);
  // ---- open resumes
  btn(rowFor('Alpha question about the page'), 'hist-open').click();
  await wait(100);
  ok('open puts the chat in this window and closes the drawer', $('histDrawer').hidden && /pineapple/.test($('messages').textContent) && /Alpha question/.test($('messages').textContent) && !/Second\./.test($('messages').textContent));
  const before = chatsSent().length;
  $('input').value = 'Follow up'; $('composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
  ok('the next message resumes that chat\'s Claude session', chatsSent().length === before + 1 && chatsSent().pop().resume === 'sess-alpha', JSON.stringify(chatsSent().pop()));
  const fid = chatsSent().pop().id;
  onMsg({ type: 'chatEvent', id: fid, event: { kind: 'text', text: 'Done.' } });
  onMsg({ type: 'chatDone', id: fid, ok: true, sessionId: 'sess-alpha' });
  await wait(450);
  ok('... and the follow-up lands in the same history entry', list('a1').length === 2 && list('a1')[0].id === alphaId && (store['chat:' + alphaId] || []).filter(m => m.role === 'user').length === 2);
  newChat();
  await turn('Fresh start', 'Sure.', [], 'sess-fresh');
  ok('a new chat sends no resume of an older chat', chatsSent().pop().resume === undefined && list('a1').length === 3);
  // ---- export
  $('histBtn').click(); await search('');
  btn(rowFor('Alpha question about the page'), 'hist-export').click();
  await wait(100);
  const dl = downloads.pop();
  const md = blobs.length ? await readBlob(blobs[blobs.length - 1]) : '';
  const created = list('a1').find(c => c.id === alphaId).created;
  const want = '# Alpha question about the page\n\n' + localDate(created) + '\n\n**You:** Alpha question about the page\n\n**Claude:** It uses pineapple everywhere.\n\n- get_page_text on example.com\n- click\n\n**You:** Follow up\n\n**Claude:** Done.\n';
  ok('Export Markdown saves with browser.downloads, as a .md file', !!dl && /\.md$/.test(dl.filename) && /Alpha question about the page/.test(dl.filename) && dl.url === 'blob:history-' + blobs.length && dl.saveAs !== true, JSON.stringify(dl));
  ok('the Markdown is the title, the date, then You and Claude turns with tool steps as "- <tool> on <site>"', md === want, JSON.stringify(md));
  // ---- delete
  btn(rowFor('Alpha question about the page'), 'hist-del').click();
  await wait(100);
  ok('Delete removes the list entry and chat:<id>', list('a1').length === 2 && !list('a1').some(c => c.id === alphaId) && !(('chat:' + alphaId) in store) && !rowFor('Alpha question about the page'));
  ok('... of another chat leaves the open chat alone', /Fresh start/.test($('messages').textContent));
  const freshId = list('a1')[0].id;
  btn(rowFor('Fresh start'), 'hist-del').click();
  await wait(100);
  ok('Delete of the open chat starts a new chat', !/Fresh start/.test($('messages').textContent) && sent.filter(m => m.type === 'newChat').length > 0 && $('page-chat').classList.contains('is-empty') && !(('chat:' + freshId) in store));
  await wait(450);
  ok('... and nothing is re-saved afterwards', list('a1').length === 1 && !(('chat:' + freshId) in store));
  // ---- clear history asks first, removes only this account's chats
  const gammaKeys = ['chats:a2', 'chat:' + (list('a2')[0] || {}).id];
  btn(rows()[0], 'hist-open').click(); await wait(100);   // an open chat that belongs to the list
  $('histBtn').click();
  const a1Keys = ['chats:a1', ...list('a1').map(c => 'chat:' + c.id)];
  $('histClear').click();
  ok('Clear history asks first and removes nothing yet', !$('histConfirm').hidden && list('a1').length === 1 && !!store['chat:' + list('a1')[0].id]);
  $('histConfirmNo').click();
  ok('... No keeps every chat', $('histConfirm').hidden && list('a1').length === 1);
  $('histClear').click(); $('histConfirmYes').click();
  await wait(100);
  ok('... Yes removes all of this account\'s chats and their messages', a1Keys.length === 2 && a1Keys.every(k => !(k in store)), JSON.stringify(a1Keys));
  ok('... and none of the other account\'s', gammaKeys.every(k => k in store) && list('a2').length === 1);
  ok('... the drawer shows it is empty', rows().length === 0 && !$('histEmpty').hidden);
  // ---- the 301st chat drops the oldest, with a note in the log
  const seed = [];
  for (let i = 0; i < 300; i++) { seed.push({ id: 'old' + i, title: 'Old ' + i, created: 1000 + i, updated: 1000 + i, sessionId: '' }); store['chat:old' + i] = [{ role: 'user', text: 'Old ' + i, t: 1, rev: 1 }]; }
  store['chats:a1'] = seed.slice().reverse();   // newest first
  newChat();
  sent.length = 0;
  await turn('The 301st chat', 'Yes.', [], 's301');
  ok('the 301st chat drops the oldest: still 300, the new one first, the oldest and its messages gone', list('a1').length === 300 && list('a1')[0].title === 'The 301st chat' && !list('a1').some(c => c.id === 'old0') && !('chat:old0' in store) && 'chat:old1' in store, list('a1').length + ' ' + (list('a1')[299] || {}).id);
  ok('... and says so in the log', sent.some(m => m.type === 'histLog' && /oldest/i.test(m.text)), JSON.stringify(sent.filter(m => m.type === 'histLog')));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e.stack); process.exit(1); });
