'use strict';
// Automatic mode (Trusted mode's internal name) and the page-safety prompt (w3-3b): the Automatic question and the helper's flag
// (confirmflow.js, the host), the chat prompt's card and Automatic lines (chatargs.js, chatturns.js), the tool server's instructions
// (claudefox-mcp.js), the 150 s limits (toolSchemas.js), page_read after a helper-side read, and what Automatic and Unsafe answer by
// themselves in the helper: the picture card and the folder questions, never past a refusal. The helper part needs Linux or macOS (the fake
// Claude and confirm window are scripts with a shebang).   node host/test/trusted-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-trusted-'));
// Everything the helper and the tool server read or write lives under tmp (the data folder and the pipes).
process.env.LOCALAPPDATA = tmp;
process.env.CLAUDEFOX_TEST = '1';
const A = require('../lib/chatargs');
const P = require('../lib/paths');
const { TOOLS } = require('../lib/toolSchemas');

const CARD = "Some actions ask the user first in a card in the chat: using a site outside this chat's sites, submitting a form or leaving a site after reading a page, and uploads. You cannot answer the card. If a tool says the user did not allow something, stop that path and say so in one line.";
const TRUSTED = '- Automatic mode is on: the questions about pictures, other sites, form sends, uploads, form filling and folders are answered Yes for you, so there is no confirmation step. Google sign-in pages, blocked sites and protected folders stay off-limits.';
const TRUSTED_Q = 'Claude then answers Yes by itself to these questions: saving a picture, using another site, sending a form or following a link to another site after reading a page, uploading a file, filling a form, and allowing a folder for file tools or local pages.\n\nGoogle sign-in and account pages, sites you blocked and protected folders stay off-limits. It still never types passwords, 2FA codes or payment details. Pages can try to steer it.\n\nIt stays on until you press Stop.';
const WAIT_TOOLS = ['read_page', 'get_page_text', 'analyze_page', 'get_selection', 'find', 'click', 'hover', 'fill', 'type_text', 'press_key', 'scroll', 'media', 'wait_for', 'screenshot', 'console_log', 'network_log', 'navigate', 'tab_open'];
// The other tools keep their limits (0 = none set).
const OTHER_TOOLS = { tabs_list: 0, tab_activate: 0, tab_close: 0, create_file: 30000, read_document: 60000, local_page_open: 180000, local_files: 180000, local_file_read: 180000, watch_video: 900000, progress: 0, army_start: 60000, army_wait: 300000 };

let passed = 0;
const failed = [];
const check = (name, ok, detail) => { if (ok) passed++; else failed.push(name + (detail ? ` (${detail})` : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = s => String(s).split('\n');
let helper = null, helperRan = false;

// 1. The chat prompt (chatargs.js): the card line in every turn, the Automatic line only when the turn is automatic.
const plain = A.chatPrompt({ mode: '' }, {});
const trusted = A.chatPrompt({ mode: '' }, { trusted: true });
check('prompt: the card line is in an ordinary turn', lines(plain).includes('- ' + CARD));
check('prompt: the old "no confirmation step" line is gone', !/no confirmation step/.test(plain));
check('prompt: no Automatic line in an ordinary turn', !lines(plain).includes(TRUSTED));
check('prompt: the Automatic line replaces the card line in an automatic turn', lines(trusted).includes(TRUSTED) && !lines(trusted).includes('- ' + CARD));

// 2. The limits (toolSchemas.js): the 18 calls that wait on a page or a run wait 150 s or more; the others keep theirs.
const byName = Object.fromEntries(TOOLS.map(t => [t.name, t]));
const short = WAIT_TOOLS.filter(n => !byName[n] || !(byName[n].timeoutMs >= 150000));
check('timeouts: the 18 page and run calls wait 150 s or more', WAIT_TOOLS.length === 18 && short.length === 0, short.join(', '));
const moved = Object.keys(OTHER_TOOLS).filter(n => !byName[n] || (byName[n].timeoutMs || 0) !== OTHER_TOOLS[n]);
check('timeouts: the other tools keep their limits', moved.length === 0, moved.join(', '));

// 3. The real helper with a fake Claude and a fake confirm window (Linux and macOS only).
async function helperTests() {
  if (process.platform === 'win32') return;
  const realPipe = path.join(tmp, 'helper.sock');
  const record = path.join(tmp, 'runs.log');
  const fakeClaude = path.join(tmp, 'claude');
  fs.writeFileSync(fakeClaude, `#!${process.execPath}
'use strict';
// Print mode: logs its argv, then answers. A prompt with "hold" stays up until the helper stops it. Other calls answer at once.
const fs = require('fs');
if (!process.argv.includes('-p')) { process.stdout.write('[]\\n'); process.exit(0); }
if (process.argv.includes('--input-format')) { process.stderr.write("error: unknown option '--input-format'\\n"); process.exit(1); }   // this fake takes one prompt per process: the helper falls back to that
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + '\\n');
let prompt = '';
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'trusted-smoke' }) + '\\n');
  if (prompt.includes('hold')) return setInterval(() => {}, 1000);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'trusted-smoke' }) + '\\n');
  process.exit(0);
});
`, { mode: 0o755 });
  const confirmLog = path.join(tmp, 'confirm.log'), confirmAnswer = path.join(tmp, 'confirm-answer.txt');
  const fakeConfirm = path.join(tmp, 'confirm');
  fs.writeFileSync(fakeConfirm, `#!${process.execPath}\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(confirmLog)}, JSON.stringify({ title: process.env.CFX_Q_TITLE, text: process.env.CFX_Q_TEXT }) + '\\n');\nlet a = 'yes'; try { a = fs.readFileSync(${JSON.stringify(confirmAnswer)}, 'utf8').trim(); } catch {}\nprocess.stdout.write(a);\n`, { mode: 0o755 });
  const questions = () => { try { return fs.readFileSync(confirmLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const records = () => { try { return fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const env = { ...process.env, LOCALAPPDATA: tmp, CLAUDEFOX_PIPE: realPipe, CLAUDEFOX_TEST: '1', CLAUDEFOX_CLAUDE: fakeClaude, CLAUDEFOX_CONFIRM: fakeConfirm };
  delete env.ANTHROPIC_API_KEY;
  helper = spawn(process.execPath, [path.join(__dirname, '..', 'claudefox-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  helper.stdin.on('error', () => {});
  const inbox = [], waiters = [];
  let hbuf = Buffer.alloc(0);
  helper.stdout.on('data', chunk => {
    hbuf = Buffer.concat([hbuf, chunk]);
    while (hbuf.length >= 4 && hbuf.length >= 4 + hbuf.readUInt32LE(0)) {
      const len = hbuf.readUInt32LE(0);
      const msg = JSON.parse(hbuf.subarray(4, 4 + len).toString());
      hbuf = hbuf.subarray(4 + len);
      inbox.push(msg);
      for (const w of waiters.splice(0)) if (!w(msg)) waiters.push(w);
    }
  });
  const toHelper = msg => {
    const body = Buffer.from(JSON.stringify(msg)), head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    helper.stdin.write(Buffer.concat([head, body]));
  };
  // The first message that matches (undefined after ms: the check then fails and the run goes on).
  const expect = (pred, ms = 6000) => new Promise(resolve => {
    const hit = inbox.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => resolve(undefined), ms);
    waiters.push(m => { if (!pred(m)) return false; clearTimeout(timer); resolve(m); return true; });
  });
  // The helper answers in order, so the pong means every message sent before the ping is in the inbox.
  const sync = async () => { const t = `s${Math.random()}`; toHelper({ type: 'ping', t }); await expect(m => m.type === 'pong' && m.t === t); };
  const lastState = () => inbox.filter(m => m.type === 'confirmed_state').pop() || {};
  const until = async (pred, ms = 8000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await sleep(50); return pred(); };
  // One chat turn: the system prompt it ran with (as lines), from the run log, once the turn is done.
  async function turn(id, msg) {
    const n = records().length;
    toHelper(Object.assign({ type: 'chat', id, text: 'hello there' }, msg));
    await expect(m => m.type === 'chat_done' && m.id === id, 15000);
    const runs = records();
    if (runs.length <= n) return [];
    const argv = runs[runs.length - 1];
    return lines(argv[argv.indexOf('--append-system-prompt') + 1]);
  }
  // A call the way claudefox-mcp makes one: a client on the helper's pipe, after hello. Resolves with the reply.
  let seq = 0;
  const call = (tool, args) => new Promise(resolve => {
    const id = `c${++seq}`, sock = net.connect(realPipe);
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); resolve({ ok: false, error: 'no reply' }); }, 15000);
    sock.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'hello', token: fs.readFileSync(P.TOKEN_FILE, 'utf8').trim(), client: 'trusted-smoke' }) + '\n'));
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.type === 'hello_ok') sock.write(JSON.stringify({ type: 'call', id, tool, args }) + '\n');
        else if (m.type === 'result' && m.id === id) { clearTimeout(timer); sock.destroy(); resolve(m); }
      }
    });
  });
  // The tool server's instructions at initialize (claudefox-mcp.js), which Claude Code reads.
  const instructions = () => new Promise(resolve => {
    const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'claudefox-mcp.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    mcp.stdin.on('error', () => {});
    let buf = '';
    const done = v => { mcp.kill(); resolve(v); };
    const timer = setTimeout(() => done(''), 8000);
    mcp.stdout.setEncoding('utf8');
    mcp.stdout.on('data', d => {
      buf += d;
      if (buf.indexOf('\n') < 0) return;
      clearTimeout(timer);
      done(String((JSON.parse(buf.slice(0, buf.indexOf('\n'))).result || {}).instructions || ''));
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trusted-smoke', version: '0' } } }) + '\n');
  });

  await sleep(800);   // the helper starts its pipe and writes its token
  toHelper({ type: 'hello', version: 'trusted-smoke' });
  await expect(m => m.type === 'confirmed_state');
  check('a fresh helper starts with Automatic mode off', lastState().trusted === false, JSON.stringify(lastState()));
  const ins = await instructions();
  check('the tool server gives the card line, not the old line', lines(ins).includes(CARD) && !/no confirmation step/.test(ins));
  const p1 = await turn('t1', { trusted: true });
  check('a trusted message the helper has not confirmed gets the card line only', p1.includes('- ' + CARD) && !p1.includes(TRUSTED));

  fs.writeFileSync(confirmAnswer, 'no');
  const mark = inbox.length;
  toHelper({ type: 'confirm', id: 'k1', kind: 'trusted' });
  const no = await expect(m => m.type === 'confirm_result' && m.id === 'k1');
  await sync();
  const asked = questions().pop() || {};
  check('the Automatic question has its title and text', asked.title === 'Claudefox: turn on Automatic mode?' && asked.text === TRUSTED_Q, JSON.stringify(asked));
  check('a no is answered no and sends no state', !!no && no.ok === false && !inbox.slice(mark).some(m => m.type === 'confirmed_state'), JSON.stringify(no));

  fs.writeFileSync(confirmAnswer, 'yes');
  toHelper({ type: 'confirm', id: 'k2', kind: 'trusted' });
  const yes = await expect(m => m.type === 'confirm_result' && m.id === 'k2');
  await sync();
  check('a yes is answered yes and sent as Automatic mode on, Unsafe mode and files left alone', !!yes && yes.ok === true && lastState().trusted === true && lastState().unsafe === false && lastState().files === null, JSON.stringify(lastState()));
  const p2 = await turn('t2', { trusted: true });
  check('Automatic mode on and the message trusted: the Automatic line replaces the card line', p2.includes(TRUSTED) && !p2.includes('- ' + CARD));
  const p3 = await turn('t3', { trusted: false });
  check('Automatic mode on but the message not trusted: no Automatic line', !p3.includes(TRUSTED) && p3.includes('- ' + CARD));
  toHelper({ type: 'trusted_off' });
  await sync();
  check('trusted_off is sent back as Automatic mode off, Unsafe mode and files left alone', lastState().trusted === false && lastState().unsafe === false && lastState().files === null, JSON.stringify(lastState()));
  const p4 = await turn('t4', { trusted: true });
  check('after trusted_off a trusted message gets the card line only', !p4.includes(TRUSTED) && p4.includes('- ' + CARD));

  // Automatic mode answers the folder and picture questions by itself, but never past a refusal. Every folder below is made
  // here; `windows()` counts the confirm windows that showed.
  const windows = () => questions().length;
  const mkdir = name => fs.realpathSync(fs.mkdtempSync(path.join(tmp, name)));
  const notes = mkdir('notes-'), notes2 = mkdir('notes2-'), notes3 = mkdir('notes3-'), notes4 = mkdir('notes4-'), notes5 = mkdir('notes5-'), notes6 = mkdir('notes6-'), notes7 = mkdir('notes7-');
  const secret = path.join(P.BASE, 'private-test'); fs.mkdirSync(secret, { recursive: true });   // Claudefox's own data folder: protected
  const holdTurn = async (id, msg) => { const n = records().length; toHelper(Object.assign({ type: 'chat', id, text: 'hold' }, msg)); await until(() => records().length > n); };
  const endTurn = async id => { toHelper({ type: 'chat_cancel', id }); await expect(m => m.type === 'chat_done' && m.id === id, 15000); };
  const confirmKind = async (id, msg) => { toHelper(Object.assign({ type: 'confirm', id }, msg)); const r = await expect(m => m.type === 'confirm_result' && m.id === id); await sync(); return r || {}; };
  const grantsNow = () => (inbox.filter(m => m.type === 'local_grants').pop() || { folders: [] }).folders;
  const LOCAL_TEXT = /inside this computer/;
  fs.writeFileSync(confirmAnswer, 'yes');

  let q0 = windows();
  let fr = await confirmKind('f1', { kind: 'files', mode: 'read', folder: notes });
  check('Automatic off: the file-tools folder asks in the confirm window', fr.ok === true && windows() === q0 + 1 && lastState().files && lastState().files.folder === notes, JSON.stringify([fr, windows() - q0]));
  toHelper({ type: 'files_off' }); await sync();

  await confirmKind('a1', { kind: 'trusted' });
  check('Automatic is on after its own question (the one window it keeps)', lastState().trusted === true);
  q0 = windows();
  fr = await confirmKind('f2', { kind: 'files', mode: 'read', folder: notes });
  check('Automatic: the file-tools read folder is allowed with no confirm window', fr.ok === true && windows() === q0 && lastState().files && lastState().files.mode === 'read' && lastState().files.folder === notes, JSON.stringify([fr, windows() - q0, lastState().files]));
  fr = await confirmKind('f3', { kind: 'files', mode: 'write', folder: notes2 });
  check('Automatic: the file-tools read and write folder is allowed with no confirm window', fr.ok === true && windows() === q0 && lastState().files && lastState().files.mode === 'write' && lastState().files.folder === notes2, JSON.stringify([fr, windows() - q0, lastState().files]));
  toHelper({ type: 'files_off' }); await sync();
  fr = await confirmKind('f4', { kind: 'files', mode: 'read', folder: secret });
  check('Automatic: a protected folder (Claudefox\'s data) is still refused, with no window', fr.ok === false && /can't use/.test(fr.error || '') && windows() === q0 && lastState().files === null, JSON.stringify([fr, windows() - q0]));
  fr = await confirmKind('f5', { kind: 'files', mode: 'write', folder: path.join(__dirname, '..', '..') });
  check('Automatic: Claudefox\'s own code is still refused for writing, with no window', fr.ok === false && /can't use/.test(fr.error || '') && windows() === q0 && lastState().files === null, JSON.stringify([fr, windows() - q0]));
  fr = await confirmKind('f6', { kind: 'files', mode: 'read', folder: path.join(tmp, 'no-such-folder') });
  check('Automatic: a folder that is not there is still refused', fr.ok === false && /no folder/i.test(fr.error || '') && windows() === q0);

  // Local pages and pictures, in a running automatic turn.
  fs.writeFileSync(path.join(notes3, 'a.txt'), 'hi');
  await holdTurn('au1', { trusted: true });
  q0 = windows();
  const l1 = await call('local_files', { path: notes3 });
  await sync();
  check('Automatic turn: a new local-page folder is allowed with no confirm window', l1.ok === true && windows() === q0 && grantsNow().includes(notes3), JSON.stringify([l1, windows() - q0, grantsNow()]).slice(0, 300));
  const l2 = await call('local_files', { path: secret });
  check('Automatic turn: a protected folder is still refused, with no window', l2.ok === false && /Not allowed/.test(l2.error || '') && windows() === q0, JSON.stringify(l2));
  toHelper({ type: 'local_ask', id: 'la1', folder: notes4, reading: 'https://x.example/page' });
  const la1 = await expect(m => m.type === 'local_ask_result' && m.id === 'la1');
  check('Automatic turn: a file: tab\'s folder question is answered Yes with no window', !!la1 && la1.ok === true && windows() === q0 && grantsNow().includes(notes4), JSON.stringify(la1));
  toHelper({ type: 'local_ask', id: 'la2', folder: secret, reading: '' });
  const la2 = await expect(m => m.type === 'local_ask_result' && m.id === 'la2');
  check('Automatic turn: a file: tab in a protected folder is still refused, with no window', !!la2 && la2.ok === false && windows() === q0 && !grantsNow().includes(secret), JSON.stringify(la2));
  const mark5 = inbox.length;
  const pic = await call('download_image', { url: 'http://127.0.0.1:9/cat.png' });
  await sync();
  check('Automatic turn: a picture save shows no card (it is refused only for its address)', pic.ok === false && LOCAL_TEXT.test(pic.error || '') && !inbox.slice(mark5).some(m => m.type === 'download_ask' && m.id), JSON.stringify(pic));
  await endTurn('au1');

  toHelper({ type: 'local_ask', id: 'la3', folder: notes5, reading: '' });
  const la3 = await expect(m => m.type === 'local_ask_result' && m.id === 'la3');
  check('Automatic on but no turn running: the folder question asks in the window', !!la3 && la3.ok === true && windows() === q0 + 1 && /allow a folder/.test((questions().pop() || {}).title || ''), JSON.stringify([la3, windows() - q0]));
  q0 = windows();
  await holdTurn('au2', { trusted: false });
  const l3 = await call('local_files', { path: notes6 });
  check('Automatic on but the message not trusted: the folder question asks in the window', l3.ok === true && windows() === q0 + 1, JSON.stringify([l3, windows() - q0]));
  const mark6 = inbox.length;
  const picP = call('download_image', { url: 'http://127.0.0.1:9/cat.png' });
  const card = await expect(m => m.type === 'download_ask' && !!m.id && inbox.indexOf(m) >= mark6);
  toHelper({ type: 'download_off' });
  const pic2 = await picP;
  check('Automatic on but the message not trusted: the picture card shows, and Stop refuses it', !!card && pic2.ok === false && /did not allow saving this picture/.test(pic2.error || ''), JSON.stringify([card, pic2]));
  await endTurn('au2');

  // Unsafe mode includes everything Automatic does.
  toHelper({ type: 'trusted_off' }); await sync();
  q0 = windows();
  const un = await confirmKind('u1', { kind: 'unsafe' });
  check('Unsafe mode still asks its own question', un.ok === true && windows() === q0 + 1 && lastState().unsafe === true && lastState().trusted === false);
  q0 = windows();
  fr = await confirmKind('f7', { kind: 'files', mode: 'read', folder: notes7 });
  check('Unsafe: the file-tools folder is allowed with no confirm window', fr.ok === true && windows() === q0 && lastState().files && lastState().files.folder === notes7, JSON.stringify([fr, windows() - q0]));
  fr = await confirmKind('f8', { kind: 'files', mode: 'write', folder: secret });
  check('Unsafe: a protected folder is still refused, with no window', fr.ok === false && windows() === q0);
  toHelper({ type: 'files_off' }); await sync();
  const notes8 = mkdir('notes8-');
  await holdTurn('un1', { unsafe: true, trusted: true });
  const l4 = await call('local_files', { path: notes8 });
  check('Unsafe turn: a new local-page folder is allowed with no confirm window', l4.ok === true && windows() === q0 && grantsNow().includes(notes8), JSON.stringify([l4, windows() - q0]).slice(0, 300));
  const l5 = await call('local_files', { path: secret });
  check('Unsafe turn: a protected folder is still refused, with no window', l5.ok === false && windows() === q0);
  await endTurn('un1');
  const p5 = await turn('t5', { unsafe: true, trusted: true });
  check('an Unsafe turn gets the Automatic line', p5.includes(TRUSTED) && !p5.includes('- ' + CARD));
  toHelper({ type: 'unsafe_off' }); await sync();

  // Both off: every one asks again.
  q0 = windows();
  fr = await confirmKind('f9', { kind: 'files', mode: 'read', folder: notes });
  check('Both off: the file-tools folder asks again', fr.ok === true && windows() === q0 + 1, JSON.stringify([fr, windows() - q0]));
  toHelper({ type: 'files_off' }); await sync();
  const notes9 = mkdir('notes9-');
  await holdTurn('off1', { trusted: true });
  q0 = windows();
  const l6 = await call('local_files', { path: notes9 });
  check('Both off, though the message says trusted: the local-page folder asks', l6.ok === true && windows() === q0 + 1, JSON.stringify([l6, windows() - q0]));
  await endTurn('off1');

  // page_read: a successful helper-side read during a running turn tells the add-on; a failed read, or no turn, does not.
  fs.mkdirSync(P.WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(P.WORKSPACE, 'trusted-smoke.docx'), zipStore({ 'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>trusted smoke</w:t></w:r></w:p></w:body></w:document>', 'word/styles.xml': '<w:styles xmlns:w="x"/>' }));
  const n0 = records().length;
  toHelper({ type: 'chat', id: 'h1', text: 'hold' });
  await until(() => records().length > n0);
  const mark1 = inbox.length;
  const ok1 = await call('read_document', { path: 'trusted-smoke.docx' });
  await sync();
  check('read_document reads the test file', ok1.ok === true && /trusted smoke/.test(JSON.stringify(ok1.result)), JSON.stringify(ok1).slice(0, 160));
  check('page_read goes to the add-on after an ok read in a running turn', inbox.slice(mark1).some(m => m.type === 'page_read' && m.id === 'h1'));
  const mark2 = inbox.length;
  const bad = await call('read_document', { path: 'missing.docx' });
  await sync();
  check('a failed read sends no page_read', bad.ok === false && !inbox.slice(mark2).some(m => m.type === 'page_read'));
  toHelper({ type: 'chat_cancel', id: 'h1' });
  await expect(m => m.type === 'chat_done' && m.id === 'h1', 15000);
  const mark4 = inbox.length;
  const idle = await call('read_document', { path: 'trusted-smoke.docx' });
  await sync();
  check('no page_read when no turn runs', idle.ok === true && !inbox.slice(mark4).some(m => m.type === 'page_read'));
  helperRan = true;
}

// A stored (uncompressed) zip of the given parts: the smallest .docx that read_document opens.
function zipStore(files) {
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = [];
  let off = 0, count = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), nm = Buffer.from(name), c = crc(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm); off += 30 + nm.length + data.length; count++;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

(async () => {
  try {
    await helperTests();
  } catch (e) {
    check('trusted-smoke ran to the end', false, e.stack || e.message);
  } finally {
    if (helper) helper.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failed.length) {
    for (const f of failed) console.log(`FAIL  ${f}`);
    console.log(`${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`trusted-smoke: ${passed} checks passed${helperRan ? '' : ' (helper part skipped on Windows)'}`);
  process.exit(0);
})();
