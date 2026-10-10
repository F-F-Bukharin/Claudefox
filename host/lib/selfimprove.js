'use strict';
// Improve Claude in Zen. Claude edits a copy of the add-on, the helper checks the change and runs the add-on's tests
// on the copy, and the real add-on changes only when the user presses Apply. Only extension/ and host/ can change.
// The safety code, the tests, the installers and the manifest are off limits (PROTECTED).
// A proposal is a folder under %LOCALAPPDATA%\claude-in-zen\self\<id>:
//   base\           the add-on as it was when the copy was made (Apply checks the real files still match it)
//   work\           the copy Claude edits; the tests run here
//   changes.diff    the whole change as a unified diff
//   settings.json   the settings of the run

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const P = require('./paths');
const guard = require('./guard');

const SELF_DIR = path.join(P.BASE, 'self');
const COPY_DIRS = ['extension', 'host', 'test'];
const EDITABLE = ['extension/', 'host/'];
// Exact files, or folders ending in "/". Claude never changes these, whatever the request.
const PROTECTED = [
  'extension/manifest.json',     // permissions and version
  'extension/lib/policy.js',     // which browser tools may run, and their limits
  'host/claude-in-zen-host.js',  // the helper's wiring, the chat and this approval step
  'host/lib/selfimprove.js',     // this file
  'host/lib/guard.js',           // the file guard
  'host/lib/chatargs.js',        // models, tool lists and the permissions of every turn
  'host/lib/paths.js',
  'host/lib/nm.js',              // the native messaging channel
  'host/install.ps1',
  'host/pick-folder.ps1',
  'host/test/',
  'test/',
];
const SKIP = new Set(['node_modules', '.git', 'build', 'web-ext-artifacts']);
const TOOLS = 'Read,Glob,Grep,Edit,Write';
const MAX_FILE = 400 * 1024;      // bigger files are not checked
const MAX_CELLS = 16e6;           // the longest diff worked out line by line
const DIFF_SHOWN = 60000;         // characters of the diff sent to the panel (changes.diff has all of it)
const CONTEXT = 3;                // lines of context around each change
const TEST_MS = 10 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const COOKIE_RE = /\bbrowser\.cookies\b|\bchrome\.cookies\b|\bdocument\.cookie\b/;
const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{8,}|WEB_EXT_API_(?:KEY|SECRET)\s*[=:]|BEGIN [A-Z ]*PRIVATE KEY/;

const proposals = new Map();   // id -> { id, dir, base, work, canApply, changes }

function isProtected(rel) {
  return PROTECTED.some(p => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
}
function isEditable(rel) {
  return EDITABLE.some(root => rel.startsWith(root)) && !isProtected(rel) && !rel.split('/').includes('..');
}

// Every regular file in the copied folders, as posix paths relative to the add-on folder.
function listFiles(root) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const a = path.join(abs, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) out.push(r);
    }
  };
  for (const d of COPY_DIRS) walk(path.join(root, d), d);
  return out.sort();
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}
function copyInto(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
// Line diff as steps [' ' | '+' | '-', text]. Equal ends are skipped first; the middle uses an LCS table.
function lineDiff(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops = [];
  for (let i = 0; i < s; i++) ops.push([' ', a[i]]);
  const n = ea - s;
  const m = eb - s;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS || n > 60000 || m > 60000) {
    for (let i = s; i < ea; i++) ops.push(['-', a[i]]);
    for (let j = s; j < eb; j++) ops.push(['+', b[j]]);
  } else {
    const w = m + 1;
    const T = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        T[i * w + j] = a[s + i] === b[s + j] ? T[(i + 1) * w + j + 1] + 1 : Math.max(T[(i + 1) * w + j], T[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[s + i] === b[s + j]) { ops.push([' ', a[s + i]]); i++; j++; }
      else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) { ops.push(['-', a[s + i]]); i++; }
      else { ops.push(['+', b[s + j]]); j++; }
    }
    while (i < n) { ops.push(['-', a[s + i]]); i++; }
    while (j < m) { ops.push(['+', b[s + j]]); j++; }
  }
  for (let k = ea; k < a.length; k++) ops.push([' ', a[k]]);
  return ops;
}

// A unified diff of one file, with CONTEXT lines around each change.
function unified(rel, status, ops) {
  const out = [
    `--- ${status === 'added' ? '/dev/null' : `a/${rel}`}`,
    `+++ ${status === 'removed' ? '/dev/null' : `b/${rel}`}`,
  ];
  const oldAt = [];
  const newAt = [];
  let o = 1;
  let nw = 1;
  ops.forEach(([t], k) => {
    oldAt[k] = o;
    newAt[k] = nw;
    if (t !== '+') o++;
    if (t !== '-') nw++;
  });
  const changed = [];
  ops.forEach(([t], k) => { if (t !== ' ') changed.push(k); });
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - CONTEXT);
    let end = Math.min(ops.length - 1, changed[k] + CONTEXT);
    let next = k + 1;
    while (next < changed.length && changed[next] - CONTEXT <= end + 1) {
      end = Math.min(ops.length - 1, changed[next] + CONTEXT);
      next++;
    }
    let oldN = 0;
    let newN = 0;
    for (let x = start; x <= end; x++) {
      if (ops[x][0] !== '+') oldN++;
      if (ops[x][0] !== '-') newN++;
    }
    const oldStart = oldN ? oldAt[start] : oldAt[start] - 1;
    const newStart = newN ? newAt[start] : newAt[start] - 1;
    out.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@`);
    for (let x = start; x <= end; x++) out.push(ops[x][0] + ops[x][1]);
    k = next;
  }
  return out.join('\n');
}

// One file's change: status, line counts, the steps (for the checks) and the diff text.
function change(rel, status, a, b) {
  const size = b ? b.length : 0;
  if ((a && a.includes(0)) || (b && b.includes(0))) {
    return { path: rel, status, binary: true, size, added: 0, removed: 0, ops: [], diff: `Binary file ${rel} ${status}.` };
  }
  const ops = lineDiff(a ? a.toString('utf8').split('\n') : [], b ? b.toString('utf8').split('\n') : []);
  return {
    path: rel, status, binary: false, size,
    added: ops.filter(x => x[0] === '+').length,
    removed: ops.filter(x => x[0] === '-').length,
    ops,
    diff: unified(rel, status, ops),
  };
}

// The files that differ between two copies of the add-on.
function diffTrees(baseDir, workDir) {
  const names = [...new Set([...listFiles(baseDir), ...listFiles(workDir)])].sort();
  const out = [];
  for (const rel of names) {
    const a = readMaybe(path.join(baseDir, rel));
    const b = readMaybe(path.join(workDir, rel));
    if (a && b && a.equals(b)) continue;
    out.push(change(rel, !a ? 'added' : !b ? 'removed' : 'modified', a, b));
  }
  return out;
}

// The reasons a change may not be applied (none when it may). These checks write nothing.
function checkChanges(changes) {
  const problems = new Set();
  for (const c of changes) {
    const rel = c.path;
    if (c.status === 'removed') problems.add(`${rel}: removes a file. Changes may only edit or add files.`);
    else if (isProtected(rel)) problems.add(`${rel}: protected (safety code, tests, installers or the manifest). Claude does not change it.`);
    else if (!isEditable(rel)) problems.add(`${rel}: outside extension/ and host/.`);
    if (c.binary) { problems.add(`${rel}: a binary file. Only text files can change.`); continue; }
    if (c.size > MAX_FILE) problems.add(`${rel}: bigger than ${MAX_FILE / 1024} KB.`);
    for (const [t, text] of c.ops) {
      if (t !== '+') continue;
      if (COOKIE_RE.test(text)) problems.add(`${rel}: adds cookie access. Claude in Zen never reads or writes cookies.`);
      if (SECRET_RE.test(text)) problems.add(`${rel}: adds a key or secret. Keys stay in environment variables, never in files.`);
    }
  }
  return [...problems];
}

function inSelfDir(dir) {
  return path.resolve(dir).startsWith(path.resolve(SELF_DIR) + path.sep);
}

// Copies made by a run that never ended (Zen or the helper was closed) are removed after a day.
function cleanStale() {
  let names;
  try { names = fs.readdirSync(SELF_DIR); } catch { return; }
  for (const name of names) {
    if (proposals.has(name)) continue;
    const dir = path.join(SELF_DIR, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_MS && inSelfDir(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

// A new copy for one change: every file of the add-on, twice (the base, and the copy Claude edits).
function prepare(root) {
  cleanStale();
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(SELF_DIR, id);
  const base = path.join(dir, 'base');
  const work = path.join(dir, 'work');
  for (const rel of listFiles(root)) {
    copyInto(path.join(root, rel), path.join(base, rel));
    copyInto(path.join(root, rel), path.join(work, rel));
  }
  return { id, dir, base, work };
}

// Removes a copy and its proposal. Only folders under SELF_DIR are ever removed.
function drop(sandbox) {
  if (!sandbox || !sandbox.dir || !inSelfDir(sandbox.dir)) return;
  proposals.delete(sandbox.id);
  try { fs.rmSync(sandbox.dir, { recursive: true, force: true }); } catch {}
}

function systemPrompt(sandbox) {
  return [
    "You are Claude, made by Anthropic, improving Claude in Zen: the add-on in the user's Zen browser that shows a Claude panel and runs Claude Code through a small helper on the PC.",
    `You work only in this copy of the add-on: ${sandbox.work}. It holds extension/ (the panel, the background page and the browser tools) and host/ (the helper). The real add-on is not touched: the user reviews your change and presses Apply.`,
    '',
    '# What you may do',
    '- Read, Glob, Grep, Edit and Write, inside this copy only. There is no shell and no web access. You cannot run the tests: the helper runs them after you finish.',
    `- Change or add files under extension/ and host/. Off limits, whatever the request: ${PROTECTED.join(', ')}.`,
    '- Do not delete files. Keep the change small and focused on what the user asked for, in the style of the file you edit. Plain JavaScript, no new dependencies.',
    '- Never add access to cookies, passwords, keys or other secrets, and never weaken an approval, a limit or the file guard.',
    '',
    '# When you are done',
    'Reply to the user in plain words: what you changed and why, the files you changed, and what to check in the panel. If the request is unclear, unsafe or already done, change nothing and say why. Do not claim the tests passed; the helper reports that.',
  ].join('\n');
}

// The first message of a run. Empty means: pick one change.
function request(text) {
  const t = String(text || '').trim();
  return t
    ? `Improve Claude in Zen as the user asks:\n\n${t}`
    : 'Improve Claude in Zen: pick the one change that would help the user most in the panel or the tools, make it, and keep it small.';
}

// The flags of one improve run (Opus 5.5 at max effort, from the caller). settings: the account's settings from the
// toolbox; plugins are forced off, and the guard's deny rules hold for every file tool.
function args(sandbox, choice, settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  if (s.enabledPlugins) for (const k of Object.keys(s.enabledPlugins)) s.enabledPlugins[k] = false;
  s.disableClaudeAiConnectors = true;
  s.permissions = { deny: guard.denyRules() };
  const file = path.join(sandbox.dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(s, null, 1));
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
    '--settings', file,
    '--append-system-prompt', systemPrompt(sandbox),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', TOOLS,
    '--tools', TOOLS,
    '--model', choice.model, '--effort', choice.effort,
  ];
}

// Runs the add-on's own tests in a folder. Passes when the test runner exits 0.
function runTests(dir) {
  return new Promise(resolve => {
    let out = '';
    const take = d => { out = (out + d).slice(-20000); };
    let child;
    try {
      child = spawn(process.execPath, [path.join(dir, 'test', 'run-all.js')], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, summary: `Could not run the tests: ${e.message}`, tail: '' });
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, TEST_MS);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, summary: `Could not run the tests: ${e.message}`, tail: '' }); });
    child.on('close', code => {
      clearTimeout(timer);
      const lines = out.trim().split('\n').filter(l => l.trim());
      resolve({
        ok: code === 0,
        summary: lines.length ? lines[lines.length - 1].trim() : `The tests exited with code ${code}.`,
        tail: lines.slice(-14).join('\n'),
      });
    });
  });
}

// Works out the change, checks it, runs the tests when it passes the checks, and keeps it for Apply or Discard.
async function propose(sandbox) {
  const changes = diffTrees(sandbox.base, sandbox.work);
  const blocked = checkChanges(changes);
  const diffText = changes.map(c => c.diff).join('\n');
  const diffFile = path.join(sandbox.dir, 'changes.diff');
  fs.writeFileSync(diffFile, diffText);
  const tests = changes.length && !blocked.length ? await runTests(sandbox.work) : null;
  const canApply = changes.length > 0 && blocked.length === 0 && !!tests && tests.ok;
  proposals.set(sandbox.id, {
    id: sandbox.id, dir: sandbox.dir, base: sandbox.base, work: sandbox.work, canApply,
    changes: changes.map(c => ({ path: c.path, status: c.status })),
  });
  const shown = diffText.length > DIFF_SHOWN ? `${diffText.slice(0, DIFF_SHOWN)}\n… the rest is in changes.diff` : diffText;
  return {
    id: sandbox.id,
    changed: changes.length,
    added: changes.reduce((n, c) => n + c.added, 0),
    removed: changes.reduce((n, c) => n + c.removed, 0),
    files: changes.map(c => ({ path: c.path, status: c.status, added: c.added, removed: c.removed })),
    blocked,
    tests,
    canApply,
    diff: shown,
    diffFile,
  };
}

// Writes the change into the add-on folder. Refuses when a file changed since the copy was made.
function apply(id, root) {
  const p = proposals.get(String(id));
  if (!p) return { ok: false, text: 'That change is gone: it was applied or discarded already, or Zen or the helper restarted. Ask Claude again.' };
  if (!p.canApply) return { ok: false, text: 'That change did not pass its checks, so it cannot be applied. Discard it, or ask for a different change.' };
  const conflicts = p.changes.filter(c => {
    const now = readMaybe(path.join(root, c.path));
    const was = readMaybe(path.join(p.base, c.path));
    return now && was ? !now.equals(was) : !!now !== !!was;
  }).map(c => c.path);
  if (conflicts.length) return { ok: false, text: `These files changed since Claude made the change, so nothing was applied: ${conflicts.join(', ')}. Discard it and ask again.` };
  // Two steps: every new file is written beside its target first, so a failure there changes nothing. Then the files
  // are renamed into place.
  const staged = [];
  try {
    for (const c of p.changes) {
      const dst = path.join(root, c.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = `${dst}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, fs.readFileSync(path.join(p.work, c.path)));
      staged.push({ tmp, dst });
    }
  } catch (e) {
    for (const st of staged) { try { fs.rmSync(st.tmp, { force: true }); } catch {} }
    return { ok: false, text: `Could not write the change (${e.message}). Nothing was changed. Try Apply again, or Discard.` };
  }
  try {
    for (const st of staged) fs.renameSync(st.tmp, st.dst);
  } catch (e) {
    return { ok: false, text: `Could not finish writing the change (${e.message}). Some files may already be changed: check them against ${path.join(p.dir, 'changes.diff')}.` };
  }
  drop(p);
  const n = p.changes.length;
  const helper = p.changes.some(c => c.path.startsWith('host/'));
  return {
    ok: true,
    files: p.changes.map(c => c.path),
    text: `Applied ${n} file${n === 1 ? '' : 's'}. Reload Claude in Zen to use the change${helper ? '; the helper changes need Zen restarted' : ''}.`,
  };
}

function discard(id) {
  const p = proposals.get(String(id));
  if (p) drop(p);
  return { ok: true, text: 'Discarded. Claude in Zen did not change.' };
}

module.exports = {
  SELF_DIR, PROTECTED, TOOLS, proposals,
  isProtected, isEditable, listFiles, lineDiff, unified, diffTrees, checkChanges,
  prepare, drop, propose, apply, discard, args, request, runTests,
};
