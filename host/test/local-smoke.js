'use strict';
// Local pages in the helper (lib/localpages.js): local_page_open, local_files and local_file_read through the pipe,
// with a fake zen.exe and this file playing the add-on (it answers local_grant and local_tab like extension/lib/local.js).
// Real paths are what the user is asked about; protected places and secret files are refused before anyone is asked.
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
fs.symlinkSync(path.join(other, 'real.html'), path.join(game, 'link.html'));
fs.symlinkSync(path.join(home, '.ssh', 'id_rsa'), path.join(game, 'key.html'));
fs.symlinkSync(path.join(home, '.ssh'), path.join(game, 'keys'));

// The fake zen.exe: it writes down how it was started.
const zenLog = path.join(tmp, 'zen.log');
const zen = path.join(tmp, 'zen');
fs.writeFileSync(zen, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(zenLog)}, JSON.stringify({ argv: process.argv.slice(2), moz: Object.keys(process.env).filter(k => /^MOZ_/.test(k)) }) + '\\n');\n`, { mode: 0o755 });
const zenRuns = () => { try { return fs.readFileSync(zenLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const base = path.join(tmp, 'base');
fs.mkdirSync(base);
const env = { ...process.env, HOME: home, LOCALAPPDATA: base, APPDATA: path.join(home, 'AppData', 'Roaming'), CLAUDE_IN_ZEN_PIPE: path.join(base, 'h.sock'),
  CLAUDE_IN_ZEN_CLAUDE: path.join(tmp, 'no-claude'), CLAUDE_IN_ZEN_ZEN_EXE: zen, MOZ_TEST_VAR: '1' };
const proc = spawn(process.execPath, [path.join(HOST_DIR, 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });

// ---- this test plays the add-on
const asks = [];   // local_grant and local_tab messages from the helper
let buf = Buffer.alloc(0);
const toHelper = msg => {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  proc.stdin.write(Buffer.concat([head, body]));
};
proc.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
    buf = buf.subarray(4 + len);
    if (msg.type === 'local_grant') {
      asks.push(msg);
      const folder = msg.kind === 'dir' ? msg.path : path.dirname(msg.path);
      const no = folder.startsWith(denied);
      toHelper({ type: 'local_grant_result', id: msg.id, ok: !no, folder, error: no ? `You did not allow Claude to look in ${folder}.` : '' });
    } else if (msg.type === 'local_tab') {   // like the add-on, wait a moment for Zen to show the page
      asks.push(msg);
      (async () => {
        let seen = false;
        for (let i = 0; i < 60 && !seen; i++) { seen = zenRuns().some(r => r.argv[1] === msg.url); if (!seen) await sleep(50); }
        toHelper({ type: 'local_tab_result', id: msg.id, ok: seen, tab_id: seen ? 55 : null, title: seen ? 'Game' : '', error: seen ? '' : 'No Zen tab showed it.' });
      })();
    }
  }
});

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

    let r = await c.call('local_page_open', { path: path.join(game, 'index.html') });
    const run = zenRuns()[0];
    check('local_page_open asks about the folder, then runs zen -new-tab with the file URL', r.ok && r.result.tab_id === 55 && r.result.path === path.join(game, 'index.html')
      && r.result.allowed_folder === game && run && run.argv[0] === '-new-tab' && run.argv[1] === `file://${game}/index.html`
      && asks[0].type === 'local_grant' && asks[0].path === path.join(game, 'index.html') && asks[0].kind === 'file', JSON.stringify([r, run, asks[0]]));
    check('zen starts without the MOZ_ variables Zen gave the helper', run && !run.moz.length, run && run.moz.join(','));
    check('the add-on is asked which tab shows the page', asks[1] && asks[1].type === 'local_tab' && asks[1].url === run.argv[1]);

    r = await c.call('local_page_open', { path: `file://${game}/with%20space%20%231.html` });
    check('a file: URL works too, and odd names are encoded', r.ok && zenRuns()[1].argv[1] === `file://${game}/with%20space%20%231.html`, JSON.stringify(r));

    asks.length = 0;
    r = await c.call('local_page_open', { path: path.join(game, 'link.html') });
    check('a link is followed: the user is asked about the real folder and the real file opens', r.ok && asks[0] && asks[0].path === path.join(other, 'real.html')
      && r.result.allowed_folder === other && zenRuns().pop().argv[1] === `file://${other}/real.html`, JSON.stringify([r, asks[0]]));

    asks.length = 0;
    const zensBefore = zenRuns().length;
    r = await c.call('local_page_open', { path: path.join(game, 'key.html') });
    check('a link into a protected place is refused before anyone is asked', !r.ok && /^Not allowed: .*id_rsa: it holds browser, password or Claude sign-in data/.test(r.error) && !asks.length, r.error);
    r = await c.call('local_files', { path: path.join(game, 'keys') });
    check('a folder link into a protected place is refused too', !r.ok && /^Not allowed:/.test(r.error) && !asks.length, r.error);
    r = await c.call('local_file_read', { path: path.join(game, '.env') });
    check('a secret file is refused before anyone is asked', !r.ok && /holds keys, passwords or sign-ins/.test(r.error) && !asks.length, r.error);
    r = await c.call('local_page_open', { path: path.join(denied, 'x.html') });
    check('when the user denies the folder, Claude hears it and nothing opens', !r.ok && r.error === `You did not allow Claude to look in ${denied}.` && zenRuns().length === zensBefore, r.error);
    r = await c.call('local_page_open', { path: 'game/index.html' });
    check('a relative path is refused', !r.ok && /^Give the full path/.test(r.error), r.error);
    r = await c.call('local_page_open', { path: 'file://server/share/x.html' });
    check('a network share is refused', !r.ok && r.error === 'Files on network shares are off-limits.', r.error);
    r = await c.call('local_page_open', { path: path.join(game, 'nope.html') });
    check('a missing file says so', !r.ok && r.error === `There is nothing at ${path.join(game, 'nope.html')}.`, r.error);
    check('nothing was opened for any refused path', zenRuns().length === zensBefore);

    r = await c.call('local_page_open', { path: game });
    check('a folder opens as Zen\'s listing (its URL ends in /)', r.ok && zenRuns().pop().argv[1] === `file://${game}/`, JSON.stringify(r));

    asks.length = 0;
    r = await c.call('local_files', { path: game });
    const lines = r.ok ? r.result.text.split('\n') : [];
    check('local_files: folders first, files with sizes, secret files and protected links left out', r.ok && lines[0] === 'levels/' && lines.includes('index.html  (1 KB)')
      && !lines.some(l => /\.env|keys\//.test(l)) && asks[0] && asks[0].kind === 'dir' && asks[0].path === game, JSON.stringify(r));
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
