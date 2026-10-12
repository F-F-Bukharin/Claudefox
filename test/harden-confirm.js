'use strict';
// Hardening checks for the confirm window and the questions that add a tool server: what the window shows
// (host/confirm.ps1, host/lib/confirm.js), which remote tool servers ask first, and the cmd refusal (host/lib/plugins.js).
// No Zen and no Windows needed: the window is checked as text, and Windows is pretended where the code asks.
//   node test/harden-confirm.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-harden-confirm-')));
process.env.LOCALAPPDATA = path.join(tmp, 'local');   // paths.js reads it when it loads
const confirmLib = require('../host/lib/confirm');
const plugins = require('../host/lib/plugins');

// Adds a tool server through the real add flow, with a confirm window that answers `answer` and records each question.
async function addWith(spec, answer = { ok: false, error: 'no' }) {
  const asked = [], out = [];
  const tb = plugins.createToolbox({ findClaude: () => null, claudeEnv: () => ({}), dirOf: () => tmp, file: path.join(tmp, 'tools.json'),
    emit: m => out.push(m), confirm: async q => { asked.push(q); return answer; } });
  await tb.add('k', spec);
  return { asked, result: out.filter(m => m.type === 'tool_result' && m.action === 'add').pop() || {} };
}
// Runs fn as if on Windows, where the cmd /c wrap applies.
async function asWindows(fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', real); }
}

async function main() {
  // ---- what the window shows
  check('control characters other than line breaks are removed', !!confirmLib.cleanText && confirmLib.cleanText('a\x00b\x07c\x1b[31md\re\nf\tg\x9bh\x7f') === 'abc[31md\re\nfgh');

  const dump = path.join(tmp, 'window-text.txt');
  const exe = path.join(tmp, 'fake-window.js');
  fs.writeFileSync(exe, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(dump)}, process.env.CIZ_Q_TEXT || '');\nprocess.stdout.write('yes');\n`, { mode: 0o755 });
  process.env.CLAUDE_IN_ZEN_CONFIRM = exe;
  const confirm = confirmLib.createConfirm({ killTree: () => {} });
  const answer = await confirm.ask({ title: 'T', text: 'run\x1b[2J this\nnext\x00line', yes: 'Y', no: 'N' });
  check('the window gets its text without control characters', answer.ok && fs.existsSync(dump) && fs.readFileSync(dump, 'utf8') === 'run[2J this\nnextline',
    fs.existsSync(dump) ? JSON.stringify(fs.readFileSync(dump, 'utf8')) : 'no text');
  delete process.env.CLAUDE_IN_ZEN_CONFIRM;

  const ps = read('host/confirm.ps1');
  check('confirm.ps1 shows the text in a read-only, multiline Consolas 9 box', /New-Object System\.Windows\.Forms\.TextBox/.test(ps) && /\$box\.ReadOnly = \$true/.test(ps)
    && /\$box\.Multiline = \$true/.test(ps) && /Font\('Consolas', 9\)/.test(ps));
  check('confirm.ps1 gives that box a vertical scrollbar, at most 260 px tall', /ScrollBars = 'Vertical'/.test(ps) && /Math\]::Min\(260,/.test(ps));
  check('confirm.ps1 puts the question text in that box', /\$box\.Text = \(\$env:CIZ_Q_TEXT/.test(ps));
  check('confirm.ps1 keeps CRLF line endings', ps.endsWith('\r\n') && !/[^\r]\n/.test(ps));

  // ---- remote tool servers ask first
  const remote = await addWith({ name: 'my-api', target: 'https://example.com/mcp', header: 'Authorization: Bearer SECRET123' });
  const q = remote.asked[0] || {};
  check('an https tool server asks first, as kind mcp_remote, with the fixed text', remote.asked.length === 1 && q.kind === 'mcp_remote'
    && q.text === 'Add the tool server my-api at https://example.com/mcp? When Claude uses it, what it reads from pages can go to that server.', JSON.stringify(q));
  check('a header value never appears in that question', !/SECRET123|Bearer/.test(q.text || ''));
  check('a refused remote tool server is not added', !remote.result.ok && remote.result.error === 'Not added: no', remote.result.error);
  const loop = await addWith({ name: 'local-api', target: 'http://localhost:8080/mcp' });
  check('a loopback http tool server asks too', loop.asked.length === 1 && loop.asked[0].kind === 'mcp_remote');

  // ---- command servers show the exact argument list, one argument per line
  const cmd = await addWith({ name: 'srv', target: 'node server.js --port 3000' });
  check('a command server shows its exact argument list, one argument per line', cmd.asked.length === 1 && cmd.asked[0].kind === 'mcp_local'
    && cmd.asked[0].text.includes('\n\nnode\nserver.js\n--port\n3000\n\n'), JSON.stringify(cmd.asked[0] && cmd.asked[0].text));

  // ---- cmd /c refuses characters cmd would run as another command, before the window
  for (const bad of ['tool&calc', 'a|b', 'a<b', 'a>b', 'a^b', '100%', '"a\nb"']) {
    const r = await asWindows(() => addWith({ name: 'runner', target: `npx -y ${bad}` }));
    check(`cmd refuses the argument ${JSON.stringify(bad)} before the window`, r.asked.length === 0
      && r.result.error === 'That command has characters cmd would run as another command.', `${r.asked.length} asked, ${r.result.error}`);
  }
  const plain = await asWindows(() => addWith({ name: 'srv', target: 'node server.js&more' }));
  check('a command cmd does not wrap is still asked, not refused', plain.asked.length === 1 && plain.result.error !== 'That command has characters cmd would run as another command.');
  const wrapped = await asWindows(() => addWith({ name: 'srv', target: 'npx -y tool' }));
  check('a plain npx command is wrapped in cmd /c and shown that way', wrapped.asked.length === 1 && wrapped.asked[0].text.includes('\n\ncmd\n/c\nnpx\n-y\ntool\n\n'));
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
  process.exitCode = failed ? 1 : 0;
}, e => { console.log(`FAIL ${e.stack || e}`); process.exitCode = 1; });
