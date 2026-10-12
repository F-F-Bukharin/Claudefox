'use strict';
// Checks, the argument list and the environment for the watch_video tool (watch-tool plan, Task 3).
// No shell: the child starts with this argument list, and the source always comes after '--'.
const fs = require('fs');
const path = require('path');
const { toPath } = require('./localpages');
const guard = require('./guard');
const { makeRunDir, removeRunDir } = require('./watchrun');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.flv', '.wmv']);
const SCRUB = /^WATCH_|^YTDLP_|^YT_DLP_|^GEMINI_|^GROQ_|^OPENAI_|^PYTHON(PATH|HOME|STARTUP)$|API_?KEY|TOKEN|SECRET|PASSWORD|COOKIE/i;
const MAX_SOURCE = 2048;
const MAX_QUESTION = 500;

function checkSource(raw, folderOf) {
  const source = String(raw == null ? '' : raw).trim();
  if (!source) return { ok: false, error: 'Give a video address or the path of a video file.' };
  if (source.length > MAX_SOURCE) return { ok: false, error: `The source is longer than ${MAX_SOURCE} characters.` };
  if (source.startsWith('-')) return { ok: false, error: 'A source cannot start with a dash.' };
  if (/^https?:\/\//i.test(source)) {
    let url;
    try { url = new URL(source); } catch { return { ok: false, error: 'That address is not valid.' }; }
    if (!url.hostname) return { ok: false, error: 'That address has no host.' };
    return { ok: true, kind: 'url', source };
  }
  let real;
  try {
    real = fs.realpathSync.native(toPath(source));
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? 'That video file was not found.' : (e.message || 'That path is not valid.') };
  }
  if (!fs.statSync(real).isFile()) return { ok: false, error: 'That path is not a file.' };
  if (!VIDEO_EXT.has(path.extname(real).toLowerCase())) return { ok: false, error: 'That file is not a video type this tool reads.' };
  const problem = guard.localProblem(real, false);
  if (problem) return { ok: false, error: `Claude cannot watch that file: ${problem}.` };
  if (!folderOf(real)) return { ok: false, error: 'Allow the folder that holds this video in Local folders first.' };
  return { ok: true, kind: 'file', source: real };
}

function checkQuestion(raw) {
  const value = raw == null ? '' : String(raw);
  if (value.includes('\0')) return { ok: false, error: 'The question contains a NUL character.' };
  if (value.length > MAX_QUESTION) return { ok: false, error: `The question is longer than ${MAX_QUESTION} characters.` };
  return { ok: true, value };
}

function checkTime(raw) {
  const s = raw == null ? '' : String(raw).trim();
  return /^(\d+(\.\d+)?|\d{1,2}:\d{2}(:\d{2})?(\.\d+)?)$/.test(s) ? s : null;
}

function buildArgv({ script, source, question, start, end, runDir }) {
  const argv = [script, '--detail', 'efficient', '--max-frames', '24', '--resolution', '512', '--no-whisper', '--out-dir', runDir];
  if (question) argv.push(`--question=${question}`);
  if (start) argv.push('--start', start);
  if (end) argv.push('--end', end);
  argv.push('--', source);
  return argv;
}

function buildEnv(base) {
  const env = {};
  for (const [name, value] of Object.entries(base || {})) if (!SCRUB.test(name)) env[name] = value;
  env.PYTHONUTF8 = '1';
  return env;
}

const PY_CANDIDATES = [['py', ['-3']], ['python', []], ['python3', []]];
const PY_CHECK = "import sys; print('%d.%d' % sys.version_info[:2])";
const PY_HINT = 'Python 3.10 or newer was not found. Install it from python.org with "Add python.exe to PATH" ticked, then run Set up Claudefox.bat again.';

// probe(exe, args) -> { code, stdout }, injected so the tests can fake the interpreters.
async function findPython(probe) {
  for (const [exe, args] of PY_CANDIDATES) {
    const r = await probe(exe, [...args, '-c', PY_CHECK]);
    const m = r && r.code === 0 ? /^3\.(\d+)$/.exec(String(r.stdout).trim()) : null;
    if (m && Number(m[1]) >= 10) return { exe, args };
  }
  return { error: PY_HINT };
}

// Result assembly (Task 6). The report lists frames as ``- `<path>` (t=..., reason=...)``; only files inside the run folder are read.
function parseFrames(stdout, runDir) {
  const root = path.resolve(runDir) + path.sep;
  const frames = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^- `([^`]+)` \(t=([^,)]*)/.exec(line);
    if (!m) continue;
    const p = path.resolve(m[1]);
    if (p.startsWith(root)) frames.push({ path: p, t: m[2] });
  }
  return frames;
}

function isJpeg(buf) {
  return !!buf && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function assembleResult({ stdout, stderr, code, runDir, readFile, maxFrames = 24, maxText = 60 * 1024 }) {
  if (code !== 0) return { text: `watch failed (exit code ${code}): ${String(stderr || '').slice(-600)}`, frames: [] };
  const listed = parseFrames(stdout, runDir);
  const frames = [];
  let unreadable = 0;
  for (const f of listed.slice(0, maxFrames)) {
    const buf = readFile(f.path);
    if (isJpeg(buf)) frames.push({ mimeType: 'image/jpeg', data: buf.toString('base64') });
    else unreadable++;
  }
  let text = String(stdout || '');
  if (Buffer.byteLength(text) > maxText) text = Buffer.from(text).subarray(0, maxText).toString('utf8') + '\n(report cut at 60 KB)';
  if (unreadable) text += `\n(${unreadable} frame(s) could not be read)`;
  if (listed.length > maxFrames) text += `\n(frames beyond ${maxFrames} are not returned)`;
  return { text, frames };
}

// The clock argument: empty, or a time the argument list can carry (checkTime). A bad one is refused at once.
function clockArg(name, raw) {
  if (raw == null || String(raw).trim() === '') return '';
  const t = checkTime(raw);
  if (t === null) throw new Error(`The ${name} time is not valid. Use seconds (90) or a clock time (1:30).`);
  return t;
}

const readOrNull = p => { try { return fs.readFileSync(p); } catch { return null; } };

// The tool (watch-tool spec, "Gating and permission"). A refusal or a missing Python throws at once. Unless watching is on
// for the session, the permission step asks the user first; a No throws its text and nothing runs.
// deps: { enabled, permission: { ask(source) -> Promise<{ ok, message? }> }, folderOf, baseDir, scriptPath, getPython,
//         runs: { run(opts) -> Promise<{ code, stdout, stderr, timedOut, stopped }> }, deadlineMs }
async function watchVideo(args, deps) {
  const src = checkSource(args.source, deps.folderOf);
  if (!src.ok) throw new Error(src.error);
  const q = checkQuestion(args.question);
  if (!q.ok) throw new Error(q.error);
  const start = clockArg('start', args.start);
  const end = clockArg('end', args.end);
  const py = await deps.getPython();
  if (!deps.enabled) {
    const v = await deps.permission.ask(args.source);
    if (!v.ok) throw new Error(v.message);
  }
  const runDir = makeRunDir(deps.baseDir);
  try {
    const argv = buildArgv({ script: deps.scriptPath, source: src.source, question: q.value, start, end, runDir });
    const r = await deps.runs.run({ exe: py.exe, args: [...py.args, ...argv], cwd: runDir, env: buildEnv(process.env), deadlineMs: deps.deadlineMs });
    if (r.stopped) return { text: 'Stopped.', frames: [] };
    if (r.timedOut) return { text: 'The video took longer than 10 minutes, so it was stopped.', frames: [] };
    return assembleResult({ stdout: r.stdout, stderr: r.stderr, code: r.code, runDir, readFile: readOrNull });
  } finally {
    try { removeRunDir(runDir); } catch { /* still held by a child that is shutting down; the result is already read */ }
  }
}

module.exports = { checkSource, checkQuestion, checkTime, buildArgv, buildEnv, findPython, parseFrames, assembleResult, watchVideo };
