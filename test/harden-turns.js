'use strict';
// Checks for the panel's models and for the helper's child processes. A chat message can name only the four panel
// models (lib/chatargs.js, lib/chatturns.js). Each child the helper starts is listed in children.json, and a helper
// that starts after a crash stops the leftovers that file names (lib/children.js). The chat turn runs a fake Claude
// Code script (POSIX only); the leftovers are real node and sleep processes started here. Nothing reaches Claude or
// the network.   node test/harden-turns.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cfx-harden-turns-')));
process.env.LOCALAPPDATA = path.join(tmp, 'local');   // paths.js reads it when it loads, so this comes before any lib

const P = require('../host/lib/paths');
const { MODELS, chatModel } = require('../host/lib/chatargs');
const { createChatTurns } = require('../host/lib/chatturns');
// lib/children.js is required inside the checks that use it, so a missing file fails only those checks.
const children = () => require('../host/lib/children');

const WINDOWS = process.platform === 'win32';
let passed = 0, failed = 0;
const check = (name, ok, extra) => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const firstLine = e => String((e && e.message) || e).split('\n')[0];
// A check whose code may throw (a missing function or file): a throw is a failed check, with its reason.
const run = (name, fn) => {
  let ok = false, extra = '';
  try { ok = !!fn(); } catch (e) { extra = firstLine(e); }
  check(name, ok, extra);
};
// A group of checks: a throw inside it fails one check, and the groups after it still run.
async function group(name, fn) {
  try { await fn(); } catch (e) { check(`${name} ran without an error`, false, firstLine(e)); }
}
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Polls every 20 ms until pred gives a truthy value (returned), or ms have passed (null).
async function waitFor(pred, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(20);
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A process group with this id exists: a child started detached leads its own group, so its pid names one.
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch { return false; } };
// The entries of children.json; [] when the file is missing or broken.
function listed() {
  try { const v = JSON.parse(fs.readFileSync(children().FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}

// A chat that names selfimprove runs on the Speed model, its child is listed while it runs, and it leads its own
// process group (so killTree can take its tool servers with it).
async function chatTurnChecks() {
  if (WINDOWS) { console.log('SKIP  the chat turn check runs a shell script, so it does not run on Windows'); return; }
  const dir = fs.mkdtempSync(path.join(tmp, 'turn-'));
  const argsFile = path.join(dir, 'args.txt'), pidFile = path.join(dir, 'pid.txt');
  const fake = path.join(dir, 'claude');
  // The fake Claude Code: writes its arguments one per line, then its own pid, sleeps 2 s and exits 0.
  fs.writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
echo $$ > "${pidFile}"
sleep 2
exit 0
`, { mode: 0o755 });
  fs.mkdirSync(P.WORKSPACE, { recursive: true });   // the helper makes this folder at start, and chat turns run in it
  const sent = [];
  const turns = createChatTurns({
    sendAddon: m => sent.push(m),
    callAddon: async () => ({ ok: false, error: 'no add-on in this check' }),
    findClaude: () => fake,
    claudeEnv: () => ({ ...process.env }),
    accountDir: () => dir,
    activeId: () => 'check-account',
    toolbox: {
      ensureFresh: async () => {},
      chatOptions: () => ({ strict: true, settings: {}, allowTools: [], skills: false, extras: [], servers: [] }),
      skillText: () => '',
      learn: () => [],
      labelFor: () => '',
    },
    confirmed: { unsafe: false, files: null },
    sameDir: (a, b) => path.resolve(a) === path.resolve(b),
    isDir: () => false,
    ROOT: root,
    shuttingDown: () => false,
  });
  let listedWhileRunning = false;
  try {
    turns.startChat({ id: 'chk-1', text: 'hello', model: 'selfimprove' });
    const pidText = await waitFor(() => {
      try { const t = fs.readFileSync(pidFile, 'utf8'); return t.endsWith('\n') ? t : ''; } catch { return ''; }
    }, 10000);
    const pid = pidText ? Number(pidText) : 0;
    const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').split('\n') : [];
    const after = flag => args[args.indexOf(flag) + 1];
    check('a chat that names selfimprove runs on the Speed model (Haiku, high effort)',
      after('--model') === 'claude-haiku-5-5' && after('--effort') === 'high', `--model ${after('--model')}, --effort ${after('--effort')}`);
    listedWhileRunning = !!pid && listed().some(e => e.pid === pid && e.kind === 'chat');
    check('the chat child is listed in children.json while it runs', listedWhileRunning);
    check('the chat child leads its own process group', !!pid && groupAlive(pid));
    const done = await waitFor(() => sent.find(m => m.type === 'chat_done' && m.id === 'chk-1'), 15000);
    check('the chat turn finishes without an error', !!done && done.ok === true, done ? done.error : 'no chat_done came in');
    check('the chat child is taken off children.json when it exits', listedWhileRunning && !listed().some(e => e.pid === pid));
  } finally {
    turns.cancelChat('*', 'the check ended');   // no-op when the turn already finished
  }
}

// track() lists a child while it runs and takes it off when it exits; a child without a pid is ignored.
async function trackChecks() {
  let threw = false;
  try { children().track(null, 'probe'); children().track({}, 'probe'); } catch { threw = true; }
  check('track() ignores a child that has no pid', !threw);
  const probe = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'ignore' });
  probe.on('error', () => {});
  children().track(probe, 'probe');
  const during = listed().find(e => e.pid === probe.pid);
  check('track() lists a new child in children.json', !!during && during.kind === 'probe' && typeof during.started === 'number');
  await new Promise(r => probe.once('exit', r));   // track's own exit listener was added first, so it has run by now
  check('track() takes the child off children.json when it exits', !!during && !listed().some(e => e.pid === probe.pid));
}

// A helper that starts after a crash stops the node process the file names, leaves the sleep (another program) alone,
// and clears the file.
async function reapChecks() {
  if (WINDOWS) { console.log('SKIP  the leftover check starts sleep and uses process groups, so it does not run on Windows'); return; }
  const node = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  node.on('error', () => {});
  sleeper.on('error', () => {});
  try {
    await sleep(200);
    fs.mkdirSync(path.dirname(children().FILE), { recursive: true });
    fs.writeFileSync(children().FILE, JSON.stringify([
      { pid: node.pid, kind: 'chat', started: Date.now() },
      { pid: sleeper.pid, kind: 'army', started: Date.now() },
    ]));
    check('both leftovers are running before the helper starts', alive(node.pid) && alive(sleeper.pid));
    children().reapAtStart();
    const gone = await waitFor(() => !alive(node.pid), 2000);
    check('a leftover node process is stopped when the helper starts', !!gone);
    await sleep(300);
    check('a leftover sleep process, not a helper program, is left running', alive(sleeper.pid));
    check('children.json is cleared when the helper starts', listed().length === 0);
  } finally {
    for (const c of [node, sleeper]) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} }
  }

  // A pid that was reused: the entry was listed a minute before this node process started, so it is someone else's
  // node (the user's own), not the helper's leftover, and it is left running.
  const reused = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  reused.on('error', () => {});
  try {
    await sleep(200);
    fs.writeFileSync(children().FILE, JSON.stringify([{ pid: reused.pid, kind: 'chat', started: Date.now() - 60000 }]));
    children().reapAtStart();
    await sleep(500);
    check('a node process that started after its entry was listed (a reused pid) is left running', alive(reused.pid));
    check('children.json is cleared after a reused pid too', listed().length === 0);
  } finally { try { process.kill(-reused.pid, 'SIGKILL'); } catch {} }
}

async function main() {
  // ---- B13: the models a chat message may name
  for (const name of ['selfimprove', 'toString', '__proto__', 'constructor', undefined, '']) {
    run(`a chat that names "${name}" gets Speed`, () => chatModel(name) === MODELS.speed);
  }
  for (const name of ['speed', 'speedplus', 'quality', 'army']) {
    run(`a chat that names "${name}" gets its own model`, () => chatModel(name) === MODELS[name]);
  }
  check('chat turns take their model from chatModel', read('host/lib/chatturns.js').includes('chatModel(msg.model)'));

  // ---- B10: every spawn the helper makes for a chat, an army worker, a watch run or the Improve tests is listed
  const sites = [
    ['host/lib/chatturns.js', "children.track(child, 'chat');"],
    ['host/lib/army.js', "children.track(child, 'army');"],
    ['host/lib/watchrun.js', "children.track(child, 'watch');"],
    ['host/lib/selfimprove.js', "children.track(child, 'improve-test');"],
  ];
  for (const [file, call] of sites) check(`${file} lists its child in children.json`, read(file).includes(call));
  // The chat turn gets its own process group on Linux and macOS. The behaviour check above shows it on POSIX; this
  // text check also covers Windows, where that check does not run.
  check('the chat turn asks for its own process group on POSIX', read('host/lib/chatturns.js').includes("detached: process.platform !== 'win32'"));

  await group('the chat turn check', chatTurnChecks);
  await group('the track check', trackChecks);
  await group('the leftover check', reapChecks);
}

const watchdog = setTimeout(() => { console.log('FAIL  the checks did not finish within 90 s'); process.exit(1); }, 90000);
main().then(() => {
  clearTimeout(watchdog);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
  process.exitCode = failed ? 1 : 0;
}, e => {
  clearTimeout(watchdog);
  console.log(`FAIL  ${firstLine(e)}`);
  process.exitCode = 1;
});
