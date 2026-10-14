'use strict';
// The answer stream and the panel's status texts in English or Portuguese (Brazil): the done line, the limit card, the model line,
// the step labels, the queue bubble and the setup guide, in the real panel (jsdom) once in each language. The expected texts come
// from the two message files with the same $n substitution t() does, so a translation can change without this test changing; what
// it pins is that every one of these texts goes through t() and that Portuguese differs from English.   node test/i18n-stream.js
// Needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one); skipped without it.
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch { JSDOM = null; }
const fs = require('fs');
const dir = require('path').join(__dirname, '..', 'extension') + '/';
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { load } = require('./lib/locales');
const { html, files: panelFiles } = panelPage(dir);
const LOC = load();
let pass = 0, fail = 0; const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));

// The message of a key in a language, $1.. replaced, $$ a dollar: what t() gives.
const msg = (lang, key, ...subs) => String(LOC[lang][key] ? LOC[lang][key].message : '<<' + key + '>>').replace(/\$(\$|[1-9])/g, (_, d) => (d === '$' ? '$' : String(subs[Number(d) - 1] ?? '')));

async function panel(lang) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window; const sent = []; const local = {}; let onMsg;
  w.browser = {
    runtime: { connect: () => ({ postMessage: m => sent.push(m), onMessage: { addListener: f => onMsg = f } }), getManifest: () => ({ version: '0.4.0' }) },
    storage: { session: { get: async () => ({}), set: async () => {} },
      local: { get: async k => (k in local ? { [k]: local[k] } : {}), set: async o => { Object.assign(local, o); } } },
    tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } } };
  w.eval(fs.readFileSync(dir + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;'); w.eval(fs.readFileSync(dir + 'lib/wall.js', 'utf8'));
  evalPanel(dom, dir, panelFiles, { lang });
  const $ = id => w.document.getElementById(id);
  const base = { agent: 'active', signedIn: true, account: { email: 'f.work@example.com', name: 'F', uuid: 'u' }, native: 'connected', hostVersion: '0.4.0',
    claude: { installed: true, loggedIn: true, email: 'f.work@example.com', plan: 'pro' }, pending: 0, chatModel: 'speed', chatArmy: false, filesMode: 'read', filesFolder: '' };
  const state = s => onMsg({ type: 'state', state: { ...base, ...s }, log: [] });
  const send = text => { $('input').value = text; $('composer').dispatchEvent(new w.Event('submit', { cancelable: true })); return sent.filter(m => m.type === 'chat').pop().id; };
  const lastMsg = () => [...$('messages').querySelectorAll('.msg.assistant')].pop();
  return { w, $, sent, onMsg: m => onMsg(m), state, send, lastMsg };
}

async function checks(lang) {
  const L = lang === 'pt_BR' ? 'pt' : 'en';
  const M = (k, ...a) => msg(lang, k, ...a);
  const P = await panel(lang);
  const { $, w } = P;
  await tick(50);

  // the done line, with tokens and cost
  P.state({});
  let id = P.send('hi');
  for (const event of [{ kind: 'stats', ms: 12300, turns: 3, tokensIn: 48000, tokensCached: 40000, tokensOut: 1200, costUsd: 0.18 }]) P.onMsg({ type: 'chatEvent', id, event });
  P.onMsg({ type: 'chatDone', id, ok: true });
  await tick();
  const done = P.lastMsg().querySelector('.donebar span:not(.dmark)').textContent;
  const wantDone = [M('stream_doneIn', '12.3'), M('stream_tokInCached', '48k', '40k'), M('stream_tokOut', '1.2k'), M('stream_cost', '0.18')].join(' · ');
  ok(`${L}: the done line`, done === wantDone, done);
  if (L === 'pt') ok('pt: the done line is not the English one', done !== 'Done in 12.3 s · 48k in (40k cached) · 1.2k out · ≈ $0.18 at API prices' && /Conclu/.test(done) && /US\$0\.18/.test(done), done);
  else ok('en: the done line is the pinned English one', done === 'Done in 12.3 s · 48k in (40k cached) · 1.2k out · ≈ $0.18 at API prices', done);

  // two step labels, the action list and its tooltips
  P.state({});
  id = P.send('look');
  P.onMsg({ type: 'chatEvent', id, event: { kind: 'tool', name: 'WebSearch', id: 's1', input: JSON.stringify({ query: 'tamagotchi' }) } });
  await tick(30);
  let label = P.lastMsg().querySelector('.plabel').textContent;
  ok(`${L}: a running step reads "${M('stream_verbWebSearch')}: tamagotchi"`, label === M('stream_verbWebSearch') + ': tamagotchi', label);
  P.onMsg({ type: 'chatEvent', id, event: { kind: 'tool_result', id: 's1', text: 'found' } });
  P.onMsg({ type: 'chatEvent', id, event: { kind: 'tool', name: 'odd_tool', id: 's2', input: '{}' } });
  await tick(30);
  label = P.lastMsg().querySelector('.plabel').textContent;
  ok(`${L}: an unknown tool reads "${M('stream_usingTool', 'odd_tool')}"`, label === M('stream_usingTool', 'odd_tool'), label);
  P.onMsg({ type: 'chatEvent', id, event: { kind: 'progress', steps: ['a', 'b', 'c'], done: 1, note: '' } });
  P.onMsg({ type: 'chatEvent', id, event: { kind: 'text', text: 'ok' } });
  await tick(30);
  P.onMsg({ type: 'chatEvent', id, event: { kind: 'tool', name: 'get_page_text', id: 's3', input: '{}' } });
  await tick(30);
  label = P.lastMsg().querySelector('.plabel').textContent;
  ok(`${L}: with a plan the label is "${M('stream_stepOf', 2, 3, 'b')}"`, label === M('stream_stepOf', 2, 3, 'b'), label);
  P.onMsg({ type: 'chatDone', id, ok: true });
  await tick();
  const btn = P.lastMsg().querySelector('.dsteps');
  ok(`${L}: the action count button`, btn.textContent === M('stream_actionMany', 3) + ' ▾', btn.textContent);
  btn.click();
  const li = P.lastMsg().querySelector('.actlist li');
  ok(`${L}: an action's tooltip names Input and Result`, li.title === M('stream_input', '{"query":"tamagotchi"}') + '\n' + M('stream_result', 'found'), JSON.stringify(li.title));

  // the limit card
  w.eval(`chat.push(${JSON.stringify({ role: 'assistant', id: 'lim1', text: '', steps: [], pending: false, error: 'Usage limit reached. Your limit resets 3pm.', limit: true })}); renderChat();`);
  const card = [...$('messages').querySelectorAll('.msg')].pop();
  ok(`${L}: the limit card says when the limit resets`, card.querySelector('.limit').textContent === M('stream_limitResets', '15:00'), card.querySelector('.limit').textContent);
  ok(`${L}: and its switch button`, card.querySelector('.limitbtn').textContent === M('stream_switchAccount'), card.querySelector('.limitbtn').textContent);
  // a weekly limit that resets on another day: the day comes with the time
  w.eval(`chat.push(${JSON.stringify({ role: 'assistant', id: 'lim2', text: '', steps: [], pending: false, error: "You've hit your weekly limit · resets Oct 17, 11am (America/Sao_Paulo)", limit: true })}); renderChat();`);
  const wk = [...$('messages').querySelectorAll('.msg')].pop();
  ok(`${L}: a weekly limit card gives the day and the time`, wk.querySelector('.limit').textContent === M('stream_limitResets', 'Oct 17, 11:00'), wk.querySelector('.limit').textContent);
  // an expired Claude Code sign-in: a sign-in card for the account the chat used
  const aid = P.send('hello');
  P.onMsg({ type: 'chatEvent', id: aid, event: { kind: 'notice', key: 'stream_newConversation', text: 'That conversation is not on this account, so Claude started a new one.' } });
  P.onMsg({ type: 'chatDone', id: aid, ok: false, error: 'Failed to authenticate: OAuth session expired and could not be refreshed', limit: false, auth: true, account: 'acct2' });
  await tick();
  const ac = [...$('messages').querySelectorAll('.msg.assistant')].pop();
  ok(`${L}: a notice the helper names by key is in the panel's language`, ac.textContent.includes(M('stream_newConversation')), ac.textContent);
  ok(`${L}: the expired sign-in card says what happened`, ac.querySelector('.limit') && ac.querySelector('.limit').textContent === M('stream_signInExpired'), ac.querySelector('.limit') && ac.querySelector('.limit').textContent);
  const sb = ac.querySelector('.limitbtn');
  ok(`${L}: and its button signs that account in again`, sb && sb.textContent === M('stream_signInAgain'));
  if (sb) sb.click();
  const last = P.sent[P.sent.length - 1];
  ok(`${L}: the button asks for the sign-in of the account the chat used`, last && last.type === 'accountSignIn' && last.id === 'acct2', JSON.stringify(last));

  // the model line: Speed, Speed Plus, Quality, army off and on, max effort
  const eh = M('main_effortHigh'), em = M('main_effortMax');
  P.state({ chatModel: 'speed' });
  ok(`${L}: model line, Speed`, $('modelLine').textContent === M('main_modelHaiku', eh), $('modelLine').textContent);
  ok(`${L}: the mode button label and aria-label, Speed`, $('modeLabel').textContent === M('main_modeSpeed') && $('modeBtn').getAttribute('aria-label') === M('main_modeSpeedAria'));
  P.state({ chatModel: 'quality', chatArmy: false });
  ok(`${L}: model line, Quality`, $('modelLine').textContent === M('main_modelOpus', eh), $('modelLine').textContent);
  ok(`${L}: the mode button label and aria-label, Quality`, $('modeLabel').textContent === M('main_modeQuality') && $('modeBtn').getAttribute('aria-label') === M('main_modeQualityAria'));
  P.state({ chatModel: 'quality', chatArmy: true });
  ok(`${L}: model line, army on`, $('modelLine').textContent === M('main_modelArmy', eh), $('modelLine').textContent);
  $('armyMax').checked = true; $('armyMax').dispatchEvent(new w.Event('change'));
  ok(`${L}: model line, army on and Max effort`, $('modelLine').textContent === M('main_modelArmy', em), $('modelLine').textContent);
  $('armyMax').checked = false; $('armyMax').dispatchEvent(new w.Event('change'));

  // the status words
  P.state({ agent: 'stopped' });
  ok(`${L}: the agent pill and the composer hint when stopped`, $('agentPill').textContent === M('main_pillStopped') && $('composerHint').textContent === M('stream_hintStopped'), $('agentPill').textContent + ' / ' + $('composerHint').textContent);
  P.state({ signedIn: false, account: null });
  ok(`${L}: the pill and the hint when signed out`, $('agentPill').textContent === M('main_pillOut') && $('composerHint').textContent === M('stream_hintSignedOut'), $('agentPill').textContent);
  P.state({});
  ok(`${L}: the Claude Code status line and its detail`, $('claudeVal').textContent === M('main_signedInEmail', 'f.work@example.com')
    && $('claudeDetail').textContent === M('main_plan', 'pro') + ' ' + M('main_spendsThis'), $('claudeVal').textContent + ' / ' + $('claudeDetail').textContent);

  // the queue bubble
  P.state({});
  const first = P.send('first');
  P.onMsg({ type: 'chatBusy', ids: [first], queued: [] });
  P.send('second');
  await tick(30);
  const q = $('messages').querySelector('.msg.user.queued');
  ok(`${L}: the queue bubble says it waits, and the x says how to remove it`, !!q && q.querySelector('.qrow').firstChild.textContent === M('stream_queueWait')
    && q.querySelector('.qx').title === M('stream_queueRemove') && q.querySelector('.qx').getAttribute('aria-label') === M('stream_queueRemove'), q && q.querySelector('.qrow').textContent);
  ok(`${L}: the user's name on a bubble`, $('messages').querySelector('.msg.user .who').textContent === M('stream_you'));
  ok(`${L}: the busy hint under the input`, $('composerHint').textContent === M('stream_busyHint'), $('composerHint').textContent);

  // the setup guide title (the helper is not connected)
  P.state({ native: 'missing', claude: null, signedIn: false, account: null });
  ok(`${L}: the setup guide title and its progress line`, $('emptyTitle').textContent === M('main_almostReady')
    && $('emptyText').textContent === M('main_setupProgress', 0, 4), $('emptyTitle').textContent + ' / ' + $('emptyText').textContent);
  const rows = [...$('setup').querySelectorAll('.step-row')];
  ok(`${L}: the first setup step, its hint and its button`, rows[0].querySelector('.step-title').textContent === M('main_stepHelper')
    && rows[0].querySelector('.step-hint').textContent === M('main_stepHelperHint') && rows[0].querySelector('.step-btn').textContent === M('main_rerunSetup'), rows[0].textContent);
  ok(`${L}: the claude.ai sign-in step uses the sign-in hint`, rows[3].querySelector('.step-hint').textContent === M('main_signInHint') && rows[3].querySelector('.step-title').textContent === M('main_stepClaudeAi'));

  // the done bar's English must stay true for the English panel
  if (L === 'pt') ok('pt: the model line is not English', !/effort/.test($('modelLine').textContent), $('modelLine').textContent);
}

(async () => {
  if (!JSDOM) { console.log('SKIP  jsdom not installed'); return; }
  await checks('en');
  await checks('pt_BR');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
