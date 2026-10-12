'use strict';
// Local pages in the helper (lib/localpages.js): local_page_open, local_files and local_file_read through the pipe,
// with a fake zen.exe, a fake confirm window (the user's "Allow this folder" or "Deny") and this file playing the add-on
// (it answers local_tab and records the allowed-folder list the helper sends). Real paths are what the user is asked
// about; protected places and secret files are refused before anyone is asked.
// POSIX only (symlinks, and the fake zen is a script with a shebang).   node host/test/local-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

if (process.platform === 'win32') { console.log('SKIP  local-smoke runs on Linux/macOS only'); process.exit(0); }

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-local-')));
const HOST_DIR = path.join(__dirname, '..');
const home = path.join(tmp, 'home');
const files = path.join(tmp, 'files');
const game = path.join(files, 'game');
const other = path.join(files, 'other');
const denied = path.join(files, 'denied');
for (const d of [path.join(home, '.ssh'), path.join(game, 'levels'), other, denied]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY');
fs.writeFileSync(path.join(game, 'index.html'), '<!doctype html><title>Game</title><canvas id="c"></canvas><script>/* arrows move */</script>');
fs.writeFileSync(path.join(game, 'levels', 'two.html'), '<p>Level two</p>');
fs.writeFileSync(path.join(game, '.env'), 'TOKEN=secret');
fs.writeFileSync(path.join(game, 'sprite.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
fs.writeFileSync(path.join(game, 'long.js'), 'x'.repeat(70000) + 'END');
fs.writeFileSync(path.join(game, 'with space #1.html'), '<p>odd name</p>');
fs.writeFileSync(path.join(other, 'real.html'), '<p>The real page</p>');
fs.writeFileSync(path.join(denied, 'x.html'), '<p>no</p>');
fs.writeFileSync(path.join(game, 'run.bat'), '@echo off');
fs.symlinkSync(path.join(other, 'real.html'), path.join(game, 'link.html'));
fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), path.join(game, 'key.html'));
fs.symlinkSync(path.join(home, '.ssh'), path.join(game, 'keys'));

// The fake zen.exe: it writes down how it was started.
const zenLog = path.join(tmp, 'zen.log');
const zen = path.join(tmp, 'zen');
fs.writeFileSync(zen, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(zenLog)}, JSON.stringify({ argv: process.argv.slice(2), moz: Object.keys(process.env).filter(k => /^MOZ_/.test(k)) }) + '\\n');\n`, { mode: 0o755 });
const zenRuns = () => { try { return fs.readFileSync(zenLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// The fake confirm window: it writes each question down and says no to anything about the denied folder.
const qLog = path.join(tmp, 'questions.log');
const confirmExe = path.join(tmp, 'confirm');
fs.writeFileSync(confirmExe, `#!${process.execPath}\nconst t = process.env.CIZ_Q_TEXT || '';\nrequire('fs').appendFileSync(${JSON.stringify(qLog)}, JSON.stringify({ text: t, yes: process.env.CIZ_Q_YES, no: process.env.CIZ_Q_NO }) + '\\n');\nprocess.stdout.write(t.includes(${JSON.stringify(denied)}) ? 'no' : 'yes');\n`, { mode: 0o755 });
const questions = () => { try { return fs.readFileSync(qLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const asked = folder => questions().filter(q => q.text.includes(`\n\n${folder}\n\n`)).length;

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const base = path.join(tmp, 'base');
fs.mkdirSync(base);
const env = { ...process.env, HOME: home, LOCALAPPDATA: base, APPDATA: path.join(home, 'AppData', 'Roaming'), CLAUDE_IN_ZEN_PIPE: path.join(base, 'h.sock'),
  CLAUDE_IN_ZEN_CLAUDE: path.join(tmp, 'no-claude'), CLAUDE_IN_ZEN_TEST: '1', CLAUDE_IN_ZEN_ZEN_EXE: zen, CLAUDE_IN_ZEN_CONFIRM: confirmExe, MOZ_TEST_VAR: '1' };
let proc = spawn(process.execPath, [path.join(HOST_DIR, 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });

// ---- this test plays the add-on
const asks = [];        // local_tab messages from the helper
const grantLists = [];  // every local_grants list the helper sent
const shown = [];       // local_question messages: the folder on screen, then '' when it is answered
const inbox = [];
let buf = Buffer.alloc(0);
const toHelper = msg => {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  proc.stdin.write(Buffer.concat([head, body]));
};
const lastGrants = () => grantLists[grantLists.length - 1] || [];
const nextMsg = async (pred, ms = 5000) => { const t = Date.now(); for (;;) { const m = inbox.find(pred); if (m) return m; if (Date.now() - t > ms) return null; await sleep(20); } };
const onOut = chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
    buf = buf.subarray(4 + len);
    inbox.push(msg);
    if (msg.type === 'local_grants') grantLists.push(msg.folders);
    else if (msg.type === 'local_question') shown.push(msg.folder);
    else if (msg.type === 'local_tab') {   // like the add-on, wait a moment for Zen to show the page
      asks.push(msg);
      (async () => {
        let seen = false;
        for (let i = 0; i < 60 && !seen; i++) { seen = zenRuns().some(r => r.argv[1] === msg.url); if (!seen) await sleep(50); }
        toHelper({ type: 'local_tab_result', id: msg.id, ok: seen, tab_id: seen ? 55 : null, title: seen ? 'Game' : '', error: seen ? '' : 'No Zen tab showed it.' });
      })();
    }
  }
};
proc.stdout.on('data', onOut);

// ---- a client on the pipe, like the tool server
function client() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(env.CLAUDE_IN_ZEN_PIPE);
    const waits = new Map();
    let seq = 1, lb = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('data', d => {
      lb += d; let i;
      while ((i = lb.indexOf('\n')) !== -1) {
        const m = JSON.parse(lb.slice(0, i)); lb = lb.slice(i + 1);
        if (m.type === 'hello_ok') resolve({ call: (tool, args) => new Promise(r => { const id = 'c' + seq++; waits.set(id, r); sock.write(JSON.stringify({ type: 'call', id, tool, args }) + '\n'); }), end: () => sock.end() });
        else if (m.type === 'result' && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
      }
    });
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'hello', token: fs.readFileSync(path.join(base, 'claude-in-zen', 'pipe-token'), 'utf8').trim(), client: 'test' }) + '\n'));
  });
}

(async () => {
  let c = null;
  try {
    toHelper({ type: 'hello', version: 'test' });
    for (let i = 0; i < 100 && !(fs.existsSync(path.join(base, 'claude-in-zen', 'pipe-token')) && fs.existsSync(env.CLAUDE_IN_ZEN_PIPE)); i++) await sleep(50);
    for (let i = 0; i < 20 && !c; i++) { try { c = await client(); } catch { await sleep(100); } }

    check('on connect the helper sends its allowed folders (none yet)', grantLists.length === 1 && !lastGrants().length, JSON.stringify(grantLists));
    let r = await c.call('local_page_open', { path: path.join(game, 'index.html') });
    const run = zenRuns()[0];
    const q0 = questions()[0];
    check('local_page_open asks about the folder in the confirm window, then runs zen -new-tab with the file URL', r.ok && r.result.tab_id === 55 && r.result.path === path.join(game, 'index.html')
      && r.result.allowed_folder === game && run && run.argv[0] === '-new-tab' && run.argv[1] === `file://${game}/index.html`
      && q0 && asked(game) === 1 && q0.yes === 'Allow this folder' && q0.no === 'Deny', JSON.stringify([r, run, q0]));
    check('the panel hears about the question while the window is open, and when it is over', shown[0] === game && shown[1] === '', JSON.stringify(shown));
    check('the helper sends the new list of allowed folders, and writes no file (they last one session)', JSON.stringify(lastGrants()) === JSON.stringify([game])
      && !fs.existsSync(path.join(base, 'claude-in-zen', 'local-grants.json')));
    check('zen starts without the MOZ_ variables Zen gave the helper', run && !run.moz.length, run && run.moz.join(','));
    check('the add-on is asked which tab shows the page', asks[0] && asks[0].type === 'local_tab' && asks[0].url === run.argv[1]);

    r = await c.call('local_page_open', { path: `file://${game}/with%20space%20%231.html` });
    check('a file: URL works too, odd names are encoded, and an allowed folder asks nothing', r.ok && zenRuns()[1].argv[1] === `file://${game}/with%20space%20%231.html` && questions().length === 1, JSON.stringify(r));

    r = await c.call('local_page_open', { path: path.join(game, 'link.html') });
    check('a link is followed: the user is asked about the real folder and the real file opens', r.ok && asked(other) === 1
      && r.result.allowed_folder === other && zenRuns().pop().argv[1] === `file://${other}/real.html`, JSON.stringify(r));

    let nq = questions().length;
    const zensBefore = zenRuns().length;
    r = await c.call('local_page_open', { path: path.join(game, 'key.html') });
    check('a link into a protected place is refused before anyone is asked', !r.ok && /^Not allowed: .*id_rsa: it holds browser, password or Claude sign-in data/.test(r.error) && questions().length === nq, r.error);
    r = await c.call('local_files', { path: path.join(game, 'keys') });
    check('a folder link into a protected place is refused too', !r.ok && /^Not allowed:/.test(r.error) && questions().length === nq, r.error);
    r = await c.call('local_file_read', { path: path.join(game, '.env') });
    check('a secret file is refused before anyone is asked', !r.ok && /holds keys, passwords or sign-ins/.test(r.error) && questions().length === nq, r.error);
    r = await c.call('local_page_open', { path: path.join(denied, 'x.html') });
    check('when the user denies the folder, Claude hears it, nothing opens and nothing is kept', !r.ok && r.error.startsWith(`The user did not allow Claude to look in ${denied}.`)
      && zenRuns().length === zensBefore && !lastGrants().includes(denied), r.error);
    nq = questions().length;
    r = await c.call('local_page_open', { path: path.join(game, 'run.bat') });
    check('a program or script is never handed to Zen to open, and nobody is asked', !r.ok && /^local_page_open shows web pages, text, PDFs, images, audio and video, not \.bat\./.test(r.error) && questions().length === nq, r.error);
    r = await c.call('local_file_read', { path: path.join(game, 'run.bat') });
    check('...but its text can be read', r.ok && r.result.text === '@echo off', JSON.stringify(r));
    r = await c.call('local_page_open', { path: 'game/index.html' });
    check('a relative path is refused', !r.ok && /^Give the full path/.test(r.error), r.error);
    r = await c.call('local_page_open', { path: 'file://server/share/x.html' });
    check('a network share is refused', !r.ok && r.error === 'Files on network shares are off-limits.', r.error);
    r = await c.call('local_page_open', { path: path.join(game, 'nope.html') });
    check('a missing file says so', !r.ok && r.error === `There is nothing at ${path.join(game, 'nope.html')}.`, r.error);
    check('nothing was opened for any refused path', zenRuns().length === zensBefore);

    r = await c.call('local_page_open', { path: game });
    check('a folder opens as Zen\'s listing (its URL ends in /)', r.ok && zenRuns().pop().argv[1] === `file://${game}/`, JSON.stringify(r));

    nq = questions().length;
    r = await c.call('local_files', { path: game });
    const lines = r.ok ? r.result.text.split('\n') : [];
    check('local_files: folders first, files with sizes, secret files and protected links left out, nothing asked again', r.ok && lines[0] === 'levels/' && lines.includes('index.html  (1 KB)')
      && !lines.some(l => /\.env|keys\//.test(l)) && questions().length === nq, JSON.stringify(r));
    r = await c.call('local_files', { path: path.join(game, 'index.html') });
    check('local_files on a file points to the right tool', !r.ok && /is a file\. Use local_file_read/.test(r.error), r.error);

    r = await c.call('local_file_read', { path: path.join(game, 'index.html') });
    check('local_file_read returns the source', r.ok && /<canvas id="c"><\/canvas>/.test(r.result.text) && r.result.next_start == null && r.result.title === 'index.html', JSON.stringify(r));
    r = await c.call('local_file_read', { path: path.join(game, 'long.js') });
    const r2 = r.ok ? await c.call('local_file_read', { path: path.join(game, 'long.js'), start_at: r.result.next_start }) : r;
    check('local_file_read comes in parts', r.ok && r.result.next_start === 60000 && r2.ok && r2.result.text.endsWith('END') && r2.result.next_start == null);
    r = await c.call('local_file_read', { path: path.join(game, 'sprite.bin') });
    check('local_file_read refuses a binary file', !r.ok && /is not a text file/.test(r.error), r.error);
    r = await c.call('local_file_read', { path: game });
    check('local_file_read on a folder points to local_files', !r.ok && /is a folder\. Use local_files/.test(r.error), r.error);

    // A FIFO (or, on Windows, a device name like CON) is not a regular file: refused at once, never read, so it can't
    // block the helper. (Old code: the read blocks until something writes to the pipe, which the test then does.)
    const fifoTxt = path.join(game, 'pipe.txt'), fifoHtml = path.join(game, 'pipe.html');
    let fifos = false;
    try { require('child_process').execFileSync('mkfifo', [fifoTxt, fifoHtml]); fifos = true; } catch {}
    if (fifos) {
      const t0 = Date.now();
      r = await Promise.race([c.call('local_file_read', { path: fifoTxt }), sleep(3000).then(() => null)]);
      if (!r) { fs.writeFileSync(fifoTxt, 'x'); r = { ok: false, error: 'the helper blocked on the FIFO' }; }
      check('local_file_read refuses a FIFO at once instead of blocking the helper', !r.ok && /is not a regular file/.test(r.error) && Date.now() - t0 < 3000, r.error);
      r = await Promise.race([c.call('local_page_open', { path: fifoHtml }), sleep(3000).then(() => null)]);
      check('local_page_open refuses a FIFO before anyone is asked', r && !r.ok && /is not a regular file/.test(r.error), r && r.error);
    }

    // The add-on asks for a file: tab outside the allowed folders (local_ask), and Profile's Remove.
    const levels = path.join(game, 'levels');
    toHelper({ type: 'local_ask', id: 'a1', folder: levels });
    let ans = await nextMsg(m => m.type === 'local_ask_result' && m.id === 'a1');
    check('local_ask inside an allowed folder answers yes at once with that folder', ans && ans.ok === true && ans.folder === game, JSON.stringify(ans));
    const newer = path.join(files, 'newer');
    fs.mkdirSync(newer);
    toHelper({ type: 'local_ask', id: 'a2', folder: newer });
    ans = await nextMsg(m => m.type === 'local_ask_result' && m.id === 'a2');
    check('local_ask about a new folder asks in the confirm window and adds it', ans && ans.ok === true && asked(newer) === 1 && lastGrants().includes(newer), JSON.stringify(ans));
    toHelper({ type: 'local_ask', id: 'a3', folder: denied });
    ans = await nextMsg(m => m.type === 'local_ask_result' && m.id === 'a3');
    check('local_ask answers no when the user denies', ans && ans.ok === false && /did not allow/.test(ans.error), JSON.stringify(ans));
    toHelper({ type: 'local_ask', id: 'a4', folder: path.join(home, '.ssh') });
    ans = await nextMsg(m => m.type === 'local_ask_result' && m.id === 'a4');
    check('local_ask for a protected folder is refused without a question', ans && ans.ok === false && /^Not allowed/.test(ans.error) && !asked(path.join(home, '.ssh')), JSON.stringify(ans));
    const before = grantLists.length;
    toHelper({ type: 'local_grant_remove', folder: newer });
    await nextMsg(() => grantLists.length > before);
    check('Remove forgets the folder and sends the new list', !lastGrants().includes(newer) && lastGrants().includes(game), JSON.stringify(lastGrants()));

    // The confirm window says which site Claude was reading (B3): the tool server sends it with these tools, and the window
    // shows a host name only. Every folder here is new, so each one is asked about.
    const mkSite = name => {
      const d = path.join(files, name);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'page.html'), '<p>site</p>');
      fs.writeFileSync(path.join(d, 'notes.txt'), 'notes');
      return d;
    };
    const windowsFor = folder => questions().filter(q => q.text.includes(`\n\n${folder}\n\n`)).map(q => q.text);
    const siteA = mkSite('site-a');
    r = await c.call('local_page_open', { path: path.join(siteA, 'page.html'), reading: 'example.com' });
    const winA = windowsFor(siteA);
    check('local_page_open: the confirm window says the site Claude was reading', r.ok && winA.length === 1 && winA[0].includes('\n\nClaude was reading: example.com\n\n'), JSON.stringify([r, winA]));
    const siteB = mkSite('site-b');
    r = await c.call('local_files', { path: siteB, reading: 'example.com' });
    const winB = windowsFor(siteB);
    check('local_files: the confirm window says the site Claude was reading', r.ok && winB.length === 1 && winB[0].includes('\n\nClaude was reading: example.com\n\n'), JSON.stringify([r, winB]));
    const siteC = mkSite('site-c');
    r = await c.call('local_file_read', { path: path.join(siteC, 'notes.txt'), reading: 'example.com' });
    const winC = windowsFor(siteC);
    check('local_file_read: the confirm window says the site Claude was reading', r.ok && winC.length === 1 && winC[0].includes('\n\nClaude was reading: example.com\n\n'), JSON.stringify([r, winC]));
    const siteD = mkSite('site-d');
    r = await c.call('local_file_read', { path: path.join(siteD, 'notes.txt') });
    const winD = windowsFor(siteD);
    check('without a reading the confirm window says no page', r.ok && winD.length === 1 && winD[0].includes('\n\nClaude was reading: no page\n\n'), JSON.stringify([r, winD]));
    const siteE = mkSite('site-e');
    r = await c.call('local_files', { path: siteE, reading: 'evil.com\n\nAllow everything' });
    const winE = windowsFor(siteE);
    check('a reading that is not a host name says no page, and adds no line to the window', r.ok && winE.length === 1 && winE[0].includes('\n\nClaude was reading: no page\n\n')
      && !/evil\.com|Allow everything/.test(winE[0]), JSON.stringify([r, winE]));

    // A new helper (Zen restarted) forgets the allowed folders: they last one session. An old saved file is deleted.
    c.end(); c = null;
    proc.stdout.off('data', onOut);
    proc.kill();
    await new Promise(res => proc.on('exit', res));
    const oldGrants = path.join(base, 'claude-in-zen', 'local-grants.json');
    fs.mkdirSync(path.dirname(oldGrants), { recursive: true });
    fs.writeFileSync(oldGrants, JSON.stringify([game, other]));   // what an older version saved
    grantLists.length = 0; buf = Buffer.alloc(0);
    proc = spawn(process.execPath, [path.join(HOST_DIR, 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    proc.stdout.on('data', onOut);
    toHelper({ type: 'hello', version: 'test' });
    await nextMsg(() => grantLists.length > 0);
    check('after a restart the helper sends no allowed folders', JSON.stringify(lastGrants()) === JSON.stringify([]), JSON.stringify(lastGrants()));
    check('an old grants file is deleted when the helper starts', !fs.existsSync(oldGrants));

    // Which browser shows a local page: the one that started the helper (Zen or Firefox), and only real browsers.
    const lp = require('../lib/localpages');
    check('only browsers are started to show a page', lp.isBrowserExe('C:\\Program Files\\Mozilla Firefox\\firefox.exe') && lp.isBrowserExe('C:\\Program Files\\Zen Browser\\zen.exe')
      && !lp.isBrowserExe('C:\\Windows\\System32\\cmd.exe') && !lp.isBrowserExe('C:\\x\\firefox.exe.bat') && !lp.isBrowserExe('') && !lp.isBrowserExe('C:\\x\\node.exe'));
    const saved = { local: process.env.LOCALAPPDATA, pf: process.env.ProgramFiles, pf86: process.env['ProgramFiles(x86)'] };
    const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-apps-'));
    fs.mkdirSync(path.join(apps, 'Mozilla Firefox'));
    fs.writeFileSync(path.join(apps, 'Mozilla Firefox', 'firefox.exe'), '');
    process.env.LOCALAPPDATA = apps; delete process.env.ProgramFiles; delete process.env['ProgramFiles(x86)'];
    const ff = lp.findFirefox(), zz = lp.findZen();
    process.env.LOCALAPPDATA = saved.local;
    if (saved.pf !== undefined) process.env.ProgramFiles = saved.pf;
    if (saved.pf86 !== undefined) process.env['ProgramFiles(x86)'] = saved.pf86;
    fs.rmSync(apps, { recursive: true, force: true });
    check('without Zen, Firefox is found where it is usually installed', ff === path.join(apps, 'Mozilla Firefox', 'firefox.exe') && zz === '', JSON.stringify({ ff, zz }));
    // The override browser counts only with CLAUDE_IN_ZEN_TEST=1: unset, or any other value, the real browser is found.
    const keep = process.env.CLAUDE_IN_ZEN_ZEN_EXE, keepFlag = process.env.CLAUDE_IN_ZEN_TEST;
    process.env.CLAUDE_IN_ZEN_ZEN_EXE = '/opt/test/firefox';
    delete process.env.CLAUDE_IN_ZEN_TEST;
    const unset = await lp.findBrowser();
    process.env.CLAUDE_IN_ZEN_TEST = '0';
    const zero = await lp.findBrowser();
    process.env.CLAUDE_IN_ZEN_TEST = '1';
    const fb = await lp.findBrowser();
    if (keep === undefined) delete process.env.CLAUDE_IN_ZEN_ZEN_EXE; else process.env.CLAUDE_IN_ZEN_ZEN_EXE = keep;
    if (keepFlag === undefined) delete process.env.CLAUDE_IN_ZEN_TEST; else process.env.CLAUDE_IN_ZEN_TEST = keepFlag;
    check('the test override names the browser', fb === '/opt/test/firefox', fb);
    check('without CLAUDE_IN_ZEN_TEST=1 the override is ignored', unset !== '/opt/test/firefox' && zero !== '/opt/test/firefox', JSON.stringify([unset, zero]));

    // Allowed folders last one session: kept in memory, no file written. An old file is deleted, and `note` says so.
    const grantFile = path.join(tmp, 'grants', 'local-grants.json');
    const mem = lp.createGrants(grantFile);
    mem.add(game); mem.add(other);
    check('allowed folders are kept in memory, and no grants file is written', JSON.stringify(mem.list()) === JSON.stringify([game, other]) && !fs.existsSync(grantFile), JSON.stringify(mem.list()));
    fs.mkdirSync(path.dirname(grantFile), { recursive: true });
    fs.writeFileSync(grantFile, JSON.stringify([game]));
    const old = lp.createGrants(grantFile);
    check('an old grants file is deleted, the list starts empty, and the note says so', !fs.existsSync(grantFile) && old.list().length === 0
      && old.note === 'Saved local-page folders were cleared: they now last one session.', JSON.stringify([old.list(), old.note]));
    check('there is no note when there was no old grants file', lp.createGrants(grantFile).note === '');

    // The confirm window says what Claude was reading, or 'no page'; the old call shape still works.
    const confirmed = [];
    const asker = lp.createLocalPages({ grants: lp.createGrants(path.join(tmp, 'grants', 'ask.json')),
      confirm: async o => { confirmed.push(o.text); return { ok: true }; } });
    const got1 = await asker.askFolder(game, 'example.com');
    const got2 = await asker.askFolder(other);
    check('the confirm window names the site Claude was reading, or no page, and askFolder still returns the folder',
      got1 === game && got2 === other && confirmed.length === 2 && confirmed[0].includes('\n\nClaude was reading: example.com\n\n') && confirmed[1].includes('\n\nClaude was reading: no page\n\n'),
      JSON.stringify([got1, got2, confirmed]));
    // A file: tab outside the allowed folders asks through allowFolder, and its window names the site the same way.
    const siteF = mkSite('site-f');
    const gotF = await asker.allowFolder(siteF, 'site.org');
    check('allowFolder: the confirm window says the site Claude was reading', gotF === siteF && confirmed.length === 3 && confirmed[2].includes('\n\nClaude was reading: site.org\n\n'),
      JSON.stringify([gotF, confirmed]));
  } catch (e) {
    check('no unexpected errors', false, e.stack || e.message);
  } finally {
    if (c) c.end();
    try { proc.kill(); } catch {}
    await sleep(200);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
