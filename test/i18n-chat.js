'use strict';
// The chat's scripted texts (panel-chat.js) in English and Portuguese (Brazil): /help, an unknown command, the account card,
// the army runs text, too-big files, and the proposal card with one and two files. Each text comes from the panel's own code
// with the language set to en or pt_BR. The Portuguese expectation is the pt_BR message with its $n filled, as t() fills it.
// Optional DOM test: needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const fs = require('fs');
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const { load } = require('./lib/locales');
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(EXT);
const MSG = load();   // { en, pt_BR }: the message files as the add-on ships them
const MB = 1024 * 1024, TOKENS = 2400000, A = 'f.work@example.com', B = 'f.code@example.com', MINUS = '−';
const EN_INTRO = 'Type normally to talk to Claude. It can read and act on your tabs.';

// The pt_BR message of a key with $1, $2 ... filled as t() fills it: one pass, and $$ is a dollar sign.
function pt(key, ...subs) {
  const m = MSG.pt_BR[key];
  if (!m) return '<no pt_BR ' + key + '>';
  return m.message.replace(/\$([1-9$])/g, (all, c) => (c === '$' ? '$' : String(subs[Number(c) - 1] ?? '')));
}

// A signed-in panel in one language, with an empty chat and the same account on both sides.
async function open(lang) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  let onMsg = () => {};
  w.browser = {
    runtime: { connect: () => ({ postMessage() {}, onMessage: { addListener: f => { onMsg = f; } } }), getManifest: () => ({ version: '0.4.0' }) },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [{ title: 'T', url: 'https://x' }], onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
  };
  w.eval(fs.readFileSync(EXT + 'lib/markdown.js', 'utf8') + '\n;window.cizMarkdown=cizMarkdown;');
  w.eval(fs.readFileSync(EXT + 'lib/wall.js', 'utf8'));
  evalPanel(dom, EXT, panelFiles, { lang });
  await new Promise(r => setTimeout(r, 50));
  const p = {
    w, $: id => w.document.getElementById(id), last: () => w.eval('chat[chat.length - 1]'),
    state: (account, claude) => onMsg({ type: 'state', log: [], state: {
      agent: 'active', signedIn: true, native: 'connected', hostVersion: '0.4.0', debugPort: 'off', pending: 0, chatModel: 'speed',
      filesMode: 'read', filesFolder: '', account: { email: account, name: 'F', uuid: 'u' }, claude: { installed: true, loggedIn: true, plan: 'pro', email: claude } } }),
  };
  p.state(A, A);
  return p;
}

// Each case runs in a fresh panel and returns [what, got, want] checks. want is the English on en and the pt_BR text on pt_BR.
const CASES = [
  ['/help', async (p, pick) => {
    await p.w.runSlash('/help');
    return [['the first line', p.last().text.split('\n')[0], pick(EN_INTRO, pt('chat_helpIntro').split('\n')[0])]];
  }],
  ['unknown command', async (p, pick) => {
    await p.w.runSlash('/nope');
    return [['role and text', p.last().role + ': ' + p.last().text,
      pick('error: Unknown command /nope. Try /help.', 'error: ' + pt('chat_unknownCmd', 'nope'))]];
  }],
  ['account card', async (p, pick) => {
    p.state(A, B);
    p.$('input').value = 'Hello';
    await p.w.submit();
    return [['the sentence and the button', p.$('accountCardText').textContent + ' | ' + p.$('accountUse').textContent,
      pick(`This browser is signed in to claude.ai as ${A}, but chats run on Claude Code as ${B}. | Use ${B} for this chat`,
        pt('chat_acctText', A, B) + ' | ' + pt('chat_acctUse', B))]];
  }],
  ['army runs text', async (p, pick) => {
    const tc = p.w.tokenCount(TOKENS), tok = pt('chat_tokens');
    return [
      ['over the recommended count, with tokens', p.w.armyRunsText(7, TOKENS),
        pick(`Runs today: 7 · ${tc} tokens. That's past the recommended 5, so usage is high.`, pt('chat_armyRunsHigh', 7, ` · ${tc} ${tok}`, 5))],
      ['under it, with tokens', p.w.armyRunsText(3, TOKENS),
        pick(`Runs today: 3 of 5 recommended · ${tc} tokens`, pt('chat_armyRunsOf', 3, 5, ` · ${tc} ${tok}`))],
      ['under it, without tokens', p.w.armyRunsText(3, 0),
        pick('Runs today: 3 of 5 recommended.', pt('chat_armyRunsOf', 3, 5, '.'))],
    ];
  }],
  ['too-big files', async (p, pick) => {
    p.w.addFiles([{ name: 'video.mp4', size: 33 * MB, type: 'video/mp4' }]);
    const big = p.$('composerHint').textContent;
    p.w.addFiles([0, 1, 2].map(i => ({ name: `part${i}.zip`, size: 30 * MB, type: 'application/zip' })));
    return [
      ['a file over 32 MB', big, pick('video.mp4 is over 32 MB.', pt('chat_fileTooBig', 'video.mp4'))],
      ['the message over 80 MB', p.$('composerHint').textContent, pick('Up to 80 MB per message.', pt('chat_totalTooBig'))],
    ];
  }],
  ['proposal card, one file', async (p, pick) => {
    const box = p.w.proposalCard({ proposal: { id: 'p1', changed: 1, added: 5, removed: 2, canApply: true, blocked: [], diff: '', tests: null,
      files: [{ path: 'extension/a.js', status: 'edited', added: 5, removed: 2 }] } });
    return [['the heading', box.querySelector('.phead').textContent,
      pick(`Proposed change: 1 file, +5 ${MINUS}2`, pt('chat_proposed', pt('chat_filesOne', 1), 5, 2))]];
  }],
  ['proposal card, two files', async (p, pick) => {
    const box = p.w.proposalCard({ proposal: { id: 'p2', changed: 2, added: 9, removed: 4, canApply: true, blocked: [], diff: '', tests: null,
      files: [{ path: 'extension/a.js', status: 'edited', added: 5, removed: 2 }, { path: 'extension/b.js', status: 'added', added: 4, removed: 2 }] } });
    const lines = [...box.querySelectorAll('li')].map(e => e.textContent).join(' | ');
    return [
      ['the heading', box.querySelector('.phead').textContent, pick(`Proposed change: 2 files, +9 ${MINUS}4`, pt('chat_proposed', pt('chat_filesMany', 2), 9, 4))],
      ['the file lines', lines, pick(`extension/a.js: edited, +5 ${MINUS}2 | extension/b.js: new, +4 ${MINUS}2`,
        `extension/a.js: ${pt('chat_statusEdited')}, +5 ${MINUS}2 | extension/b.js: ${pt('chat_statusNew')}, +4 ${MINUS}2`)],
    ];
  }],
];

(async () => {
  let pass = 0, fail = 0;
  for (const lang of ['en', 'pt_BR']) {
    const pick = (en, ptText) => (lang === 'en' ? en : ptText);
    for (const [name, run] of CASES) {
      let checks;
      try { checks = await run(await open(lang), pick); } catch (e) { checks = [['threw', String(e && e.message), 'no error']]; }
      for (const [what, got, want] of checks) {
        const same = got === want;
        same ? pass++ : fail++;
        console.log(`${same ? 'PASS' : 'FAIL'} ${lang}: ${name}: ${what}`);
        if (!same) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR', e.stack); process.exit(1); });
