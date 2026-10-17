'use strict';
// Hardening checks for the confirm window and the questions that add a tool server: what the window shows
// (host/confirm.ps1, host/lib/confirm.js), which remote tool servers ask first, and the cmd refusal (host/lib/plugins.js).
// The test-only hooks (the pipe, the confirm window, the tool server's script) count only with CLAUDEFOX_TEST=1,
// and an army limit can be lowered through its variable but never raised.
// No Zen and no Windows needed: the window is checked as text, and Windows is pretended where the code asks.
//   node test/harden-confirm.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-harden-confirm-')));
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
// Runs fn as if on the given platform, where the code asks for it (Windows: the cmd /c wrap and the confirm window).
async function asPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try { return await fn(); } finally { Object.defineProperty(process, 'platform', real); }
}
// Runs fn as if on Windows, where the cmd /c wrap applies.
const asWindows = fn => asPlatform('win32', fn);

// This process's environment without any CLAUDEFOX_ variable, plus extra: what a child process gets in these checks.
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDEFOX_')) delete env[k];
  return { ...env, ...extra };
}
// Runs a one-line node program with childEnv(extra) and returns its stdout, or null when it fails.
function nodeWith(code, extra) {
  const r = spawnSync(process.execPath, ['-e', code], { env: childEnv(extra), encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout : null;
}
// Starts the tool server (host/claudefox-mcp.js), asks it for one tool, and returns that reply, or null if none comes in 4 s.
function askToolServer(env, tool) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'host', 'claudefox-mcp.js')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const timer = setTimeout(() => finish(null), 4000);
    const finish = r => { clearTimeout(timer); child.kill(); resolve(r); };
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m = null;
        try { m = JSON.parse(line); } catch {}
        if (m && m.id === 2) finish(m);
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: {} } }) + '\n');
  });
}

async function main() {
  // ---- what the window shows
  check('control characters other than line breaks are removed', !!confirmLib.cleanText && confirmLib.cleanText('a\x00b\x07c\x1b[31md\re\nf\tg\x9bh\x7f') === 'abc[31md\re\nfgh');

  const dump = path.join(tmp, 'window-text.txt');
  const exe = path.join(tmp, 'fake-window.js');
  fs.writeFileSync(exe, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(dump)}, process.env.CFX_Q_TEXT || '');\nprocess.stdout.write('yes');\n`, { mode: 0o755 });
  // Without CLAUDEFOX_TEST=1 the override is ignored: the real window path answers (no window here) and the fake never runs.
  delete process.env.CLAUDEFOX_TEST;
  process.env.CLAUDEFOX_CONFIRM = exe;
  const unset = await asPlatform('linux', () => confirmLib.createConfirm({ killTree: () => {} }).ask({ title: 'T', text: 'x', yes: 'Y', no: 'N' }));
  check('without CLAUDEFOX_TEST the confirm override is ignored: the fake window never runs', !unset.ok && !fs.existsSync(dump)
    && unset.error === 'This system has no confirm window, so the answer is no.', JSON.stringify(unset));
  process.env.CLAUDEFOX_TEST = '1';
  // The fake window is a script with a #! line, which Windows cannot start as a program: this check runs on Linux and macOS.
  if (process.platform === 'win32') console.log('SKIP  the window text check needs a #! script (Linux/macOS)');
  else {
  const confirm = confirmLib.createConfirm({ killTree: () => {} });
  const answer = await confirm.ask({ title: 'T', text: 'run\x1b[2J this\nnext\x00line', yes: 'Y', no: 'N' });
  check('the window gets its text without control characters', answer.ok && fs.existsSync(dump) && fs.readFileSync(dump, 'utf8') === 'run[2J this\nnextline',
    fs.existsSync(dump) ? JSON.stringify(fs.readFileSync(dump, 'utf8')) : 'no text');
  }
  delete process.env.CLAUDEFOX_CONFIRM;
  delete process.env.CLAUDEFOX_TEST;

  const ps = read('host/confirm.ps1');
  check('confirm.ps1 shows the text in a read-only, multiline Consolas 9 box', /New-Object System\.Windows\.Forms\.TextBox/.test(ps) && /\$box\.ReadOnly = \$true/.test(ps)
    && /\$box\.Multiline = \$true/.test(ps) && /Font\('Consolas', 9\)/.test(ps));
  check('confirm.ps1 gives that box a vertical scrollbar, at most 260 px tall', /ScrollBars = 'Vertical'/.test(ps) && /Math\]::Min\(260,/.test(ps));
  check('confirm.ps1 puts the question text in that box', /\$box\.Text = \(\$env:CFX_Q_TEXT/.test(ps));
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
  // ---- the test hooks count only with CLAUDEFOX_TEST=1: the pipe name (host/lib/paths.js)
  const pathsFile = path.join(root, 'host', 'lib', 'paths.js');
  const pipeWith = extra => nodeWith(`process.stdout.write(require(${JSON.stringify(pathsFile)}).PIPE)`, extra);
  const defaultPipe = pipeWith({});
  const override = path.join(tmp, 'override.sock');
  check('the pipe has a default name when no override is set', !!defaultPipe && defaultPipe !== override, defaultPipe);
  check('without CLAUDEFOX_TEST, CLAUDEFOX_PIPE does not move the pipe', !!defaultPipe && pipeWith({ CLAUDEFOX_PIPE: override }) === defaultPipe);
  check('with CLAUDEFOX_TEST=1, CLAUDEFOX_PIPE moves the pipe', pipeWith({ CLAUDEFOX_TEST: '1', CLAUDEFOX_PIPE: override }) === override);

  // ---- the test hooks count only with CLAUDEFOX_TEST=1: the tool server's script (host/claudefox-mcp.js)
  const scriptFile = path.join(tmp, 'script.json'), scriptLog = path.join(tmp, 'script-calls.jsonl');
  fs.writeFileSync(scriptFile, JSON.stringify({ log: scriptLog, results: { get_page_text: 'SCRIPTED-PAGE' } }));
  const serverEnv = extra => childEnv({ TMPDIR: tmp, LOCALAPPDATA: path.join(tmp, 'local-server'), CLAUDEFOX_SCRIPT: scriptFile, ...extra });
  const off = await askToolServer(serverEnv({}), 'get_page_text');
  check('without CLAUDEFOX_TEST the script is ignored: no scripted answer, no call logged', off !== null && !JSON.stringify(off).includes('SCRIPTED-PAGE') && !fs.existsSync(scriptLog), JSON.stringify(off));
  const on = await askToolServer(serverEnv({ CLAUDEFOX_TEST: '1' }), 'get_page_text');
  check('with CLAUDEFOX_TEST=1 the script answers the call, and the call is logged', on !== null && JSON.stringify(on).includes('SCRIPTED-PAGE') && fs.existsSync(scriptLog), JSON.stringify(on));

  // ---- an army limit can be lowered through its variable, never raised (host/lib/armyguard.js)
  const armyFile = path.join(root, 'host', 'lib', 'armyguard.js');
  const limitsWith = extra => { const out = nodeWith(`process.stdout.write(JSON.stringify(require(${JSON.stringify(armyFile)}).LIMITS))`, extra); return out === null ? null : JSON.parse(out); };
  const ARMY_VARS = ['CLAUDEFOX_ARMY_CALLS', 'CLAUDEFOX_ARMY_NAVS', 'CLAUDEFOX_ARMY_PAGES', 'CLAUDEFOX_ARMY_EXTRA_TABS', 'CLAUDEFOX_ARMY_SOFT_MS', 'CLAUDEFOX_ARMY_HARD_MS', 'CLAUDEFOX_ARMY_RUN_MS'];
  const defaults = limitsWith({});
  const atDefaults = o => o !== null && !!defaults && JSON.stringify(o) === JSON.stringify(defaults);
  check('no army limit can be raised through its variable', atDefaults(limitsWith(Object.fromEntries(ARMY_VARS.map(k => [k, '1000000000'])))));
  check('an infinite or junk army limit keeps its default', ['Infinity', 'abc', '0', '-5'].every(v => atDefaults(limitsWith({ CLAUDEFOX_ARMY_CALLS: v, CLAUDEFOX_ARMY_HARD_MS: v }))));
  const lower = limitsWith({ CLAUDEFOX_ARMY_CALLS: '3' });
  check('an army limit can be lowered through its variable', !!defaults && lower !== null && lower.calls === 3 && Object.keys(defaults).every(k => k === 'calls' || lower[k] === defaults[k]), JSON.stringify(lower));
}

main().then(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
  process.exitCode = failed ? 1 : 0;
}, e => { console.log(`FAIL ${e.stack || e}`); process.exitCode = 1; });
