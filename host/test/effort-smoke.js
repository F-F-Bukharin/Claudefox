'use strict';
// Cost and speed (wave 4): the army lead runs at high effort, armymax at max; the workers at medium; army_wait waits up to
// 280 s for every worker; the progress rule and the instructions are short; tool results are compact; claudeEnv sets
// MCP_TOOL_TIMEOUT; and the helper link is tried once more when it could not be made.   node host/test/effort-smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { onLines, sendLine } = require('../lib/lines');

if (process.platform === 'win32') { console.log('SKIP the tool server part uses a unix socket'); process.exit(0); }

const HOST = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-effort-'));
const results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const C = require(path.join(HOST, 'lib', 'chatargs.js'));
const A = require(path.join(HOST, 'lib', 'army.js'));
const T = require(path.join(HOST, 'lib', 'toolSchemas.js'));
const { createClaudeCode } = require(path.join(HOST, 'lib', 'claudecode.js'));
const tool = name => T.TOOLS.find(t => t.name === name);

// 1-3: the models, and the workers' effort
check('1. army is Opus 5.5 at high effort', C.MODELS.army.model === 'claude-opus-5-5' && C.MODELS.army.effort === 'high', JSON.stringify(C.MODELS.army));
check('2. armymax is Opus 5.5 at max effort, and the helper accepts it', !!C.MODELS.armymax && C.MODELS.armymax.model === 'claude-opus-5-5' && C.MODELS.armymax.effort === 'max' && C.chatModel('armymax') === C.MODELS.armymax);
check('3. workers are Haiku 5.5 at medium effort', C.WORKER_MODEL.model === 'claude-haiku-5-5' && C.WORKER_MODEL.effort === 'medium');

// 4-6: the lead's --effort and its prompt name the same effort; the progress rule
const tb = { strict: true, settings: {}, allowTools: [], skills: false, extras: [] };
const argsFor = (choice, army) => C.chatArgs({ mode: null, folder: '' }, '', choice, { army, tb, settingsFile: path.join(tmp, 'chat-settings.json'), mcpConfig: path.join(tmp, 'mcp.json') });
const at = (argv, flag) => argv[argv.indexOf(flag) + 1];
const sysOf = argv => at(argv, '--append-system-prompt') || '';
const leadEffort = s => (s.match(/you are the lead, on Opus at (\w+) effort/) || [])[1];
const armyArgs = argsFor(C.MODELS.army, true), maxArgs = argsFor(C.MODELS.armymax || {}, true);
check('4. the army lead runs at --effort high, and its prompt says high effort', at(armyArgs, '--effort') === 'high' && leadEffort(sysOf(armyArgs)) === 'high');
check('5. armymax runs at --effort max, and its prompt says max effort', at(maxArgs, '--effort') === 'max' && leadEffort(sysOf(maxArgs)) === 'max');
const PROGRESS = '- For any task that needs more than about three actions, send progress in the same message as your next tool call, every two or three steps, never on its own. It drives the progress bar the user watches. Skip it for quick questions.';
const progressDesc = tool('progress').description;
check('6. progress: sent with the next tool call, every two or three steps, never on its own', sysOf(argsFor(C.MODELS.speed, false)).includes(PROGRESS) && /same message as your next tool call/.test(progressDesc) && !/call it first/.test(progressDesc));

// 7-9: army_wait waits for every worker, up to 280 s; the tool server allows the call 300 s; claudeEnv
check('7. army_wait waits 280 s by default and at most, and 5 s at least', typeof A.waitSeconds === 'function' && A.waitSeconds(undefined) === 280 && A.waitSeconds(0) === 280 && A.waitSeconds(9999) === 280 && A.waitSeconds(1) === 5 && A.waitSeconds(60) === 60);
check('8. army_wait is allowed 300 s on the tool server, and its schema says 280', tool('army_wait').timeoutMs === 300000 && JSON.stringify(tool('army_wait').inputSchema).includes('default 280, 5 to 280'));
const cc = createClaudeCode({ accountDir: () => tmp, activeId: () => 'main', sendAddon: () => {} });
check('9. Claude Code processes get MCP_TOOL_TIMEOUT 960000', cc.claudeEnv(tmp).MCP_TOOL_TIMEOUT === '960000');

// ---- the tool server (claudefox-mcp.js) as Claude Code runs it: MCP lines on its stdio; the helper's pipe is a socket here
const sock = path.join(tmp, 'mcp.sock');
const base = path.join(tmp, 'claudefox');
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'pipe-token'), 'test-token');
const ENV = { LOCALAPPDATA: tmp, CLAUDEFOX_TEST: '1', CLAUDEFOX_PIPE: sock, CLAUDEFOX_CLIENT: 'effort-smoke' };
const children = [];

function session(extra) {
  const child = spawn(process.execPath, [path.join(HOST, 'claudefox-mcp.js')], {
    env: { ...process.env, ...ENV, CLAUDEFOX_PANEL: '', CLAUDEFOX_ARMY_TOKEN: '', ...extra },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  children.push(child);
  const got = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) { const m = JSON.parse(line); got.set(m.id, m); }
    }
  });
  let seq = 1;
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = seq++, t0 = Date.now();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const poll = () => {
      if (got.has(id)) return resolve(got.get(id));
      if (Date.now() - t0 > 15000) return reject(new Error(`no reply to ${method}`));
      setTimeout(poll, 20);
    };
    poll();
  });
  return { ask };
}

// A fake helper on the pipe: it answers hello, then each call with answer(call); answer returning null drops the link.
function fakeHelper(answer) {
  const calls = [];
  const server = net.createServer(s => {
    onLines(s, m => {
      if (m.type === 'hello') sendLine(s, { type: 'hello_ok' });
      if (m.type !== 'call') return;
      calls.push(m);
      const r = answer(m);
      if (r) sendLine(s, Object.assign({ type: 'result', id: m.id }, r)); else s.destroy();
    });
  });
  return {
    calls,
    listen: () => { try { fs.unlinkSync(sock); } catch {} return new Promise(r => server.listen(sock, r)); },
    close: () => server.close(),
  };
}

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'effort-smoke', version: '1' } };
const ONE_LINE = 'Claudefox browser tools. Follow the rules in your system prompt.';
const LIST = [{ id: 1, title: 'Docs', url: 'https://example.com/docs', active: true }];
const CALL = { name: 'tabs_list', arguments: {} };

(async () => {
  // 10-12: instructions
  const panel = await session({ CLAUDEFOX_PANEL: '1' }).ask('initialize', INIT);
  check('10. the panel gets the one-line instructions', panel.result.instructions === ONE_LINE, JSON.stringify(panel.result.instructions).slice(0, 90));
  const worker = await session({ CLAUDEFOX_ARMY_TOKEN: 'token-1' }).ask('initialize', INIT);
  check('11. an army worker gets the one-line instructions', worker.result.instructions === ONE_LINE);
  const outside = (await session({}).ask('initialize', INIT)).result.instructions;
  check('12. an outside client gets the long instructions', outside.startsWith("These tools act on the user's real Zen browser") && outside.length > 200, `${outside.length} characters`);

  // 13: compact results
  const helper = fakeHelper(() => ({ ok: true, result: LIST }));
  await helper.listen();
  const compact = (await session({}).ask('tools/call', CALL)).result.content[0].text;
  check('13. tool results are compact JSON, with no indented lines', compact.includes(JSON.stringify(LIST)) && !/\n\s/.test(compact), JSON.stringify(compact).slice(0, 90));

  // 14: the link is tried once more after 300 ms when it could not be made (the helper starts 100 ms later)
  helper.close();
  await new Promise(r => setTimeout(r, 100));
  const late = fakeHelper(() => ({ ok: true, result: LIST }));
  const pending = session({}).ask('tools/call', CALL);
  setTimeout(() => late.listen(), 100);
  const retried = (await pending).result;
  check('14. a link that cannot be made is tried once more after 300 ms', !retried.isError && retried.content[0].text.includes(JSON.stringify(LIST)), retried.content[0].text.slice(0, 90));

  // 15: a request that was written is not sent again: the helper reads it and drops the link
  const dropped = fakeHelper(() => null);
  await dropped.listen();
  const cut = (await session({}).ask('tools/call', CALL)).result;
  await new Promise(r => setTimeout(r, 1000));
  check('15. a request that was written is not sent again', cut.isError === true && dropped.calls.length === 1, `${dropped.calls.length} call(s) received`);

  for (const c of children) c.kill();
  late.close();
  dropped.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
