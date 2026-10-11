'use strict';
// Checks, the argument list and the environment for the watch_video tool (watch-tool plan, Task 3).
// No shell: the child starts with this argument list, and the source always comes after '--'.
const fs = require('fs');
const path = require('path');
const { toPath } = require('./localpages');
const guard = require('./guard');

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

module.exports = { checkSource, checkQuestion, checkTime, buildArgv, buildEnv, findPython };
