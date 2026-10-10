'use strict';
// Local pages and files: Claude may open, list or read something on this computer only inside a folder the user
// allowed. The add-on asks the user ("Allow this folder" or "Deny") and keeps the allowed folders
// (extension/lib/local.js); the helper does the file side here.
//
// Every path is followed to its real place first (links and junctions), and the real place is what the user is asked
// about, so a link inside an allowed folder never reaches outside it. Protected places (lib/guard.js) are refused
// before anyone is asked. Firefox does not let add-ons open file: tabs, so local_page_open asks Zen to open the page
// the way a desktop shortcut does: zen.exe -new-tab <file: URL>. Army workers never get here (lib/armyguard.js).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const guard = require('./guard');
const log = require('./log');
const { extractText, kindOf } = require('./doctext');

const ASK_MS = 150000;                    // the add-on gives the user 120 s to answer
const TAB_MS = 20000;                     // the add-on looks for the new tab for up to 10 s
const MAX_LIST = 300;                     // entries local_files shows
const MAX_SCAN = 5000;                    // entries it looks at
const MAX_READ = 5 * 1024 * 1024;         // the largest file local_file_read opens
const PART = 60000;                       // characters per part

// zen.exe: CLAUDE_IN_ZEN_ZEN_EXE (tests), else the usual install places (as tools\xpi-tools.ps1 looks).
function findZen() {
  if (process.env.CLAUDE_IN_ZEN_ZEN_EXE) return process.env.CLAUDE_IN_ZEN_ZEN_EXE;
  const pf = process.env.ProgramFiles, pf86 = process.env['ProgramFiles(x86)'], local = process.env.LOCALAPPDATA;
  const places = [pf && path.join(pf, 'Zen Browser', 'zen.exe'), pf86 && path.join(pf86, 'Zen Browser', 'zen.exe'),
    local && path.join(local, 'Zen Browser', 'zen.exe'), local && path.join(local, 'Programs', 'Zen Browser', 'zen.exe')];
  return places.find(p => p && fs.existsSync(p)) || '';
}

// A path as Claude gave it (a full path or a file: URL) -> a full path. Network shares and device paths are refused.
function toPath(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/^"(.*)"$/, '$1');
  if (!s) throw new Error('Give the full path of a file or folder on this computer, like C:\\Users\\you\\Downloads\\game\\index.html.');
  if (s.includes('\0')) throw new Error('That path is not valid.');
  if (/^file:/i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new Error('That file: URL is not valid.'); }
    if (u.hostname && u.hostname.toLowerCase() !== 'localhost') throw new Error('Files on network shares are off-limits.');
    try { s = fileURLToPath('file://' + u.pathname); } catch (e) { throw new Error(`That file: URL is not valid (${e.message}).`); }
  }
  if (process.platform === 'win32') {
    s = s.replace(/\//g, '\\');
    if (/^\\\\/.test(s)) throw new Error('Files on network shares and device paths are off-limits.');
    if (!/^[A-Za-z]:\\/.test(s)) throw new Error('Give the full path, starting with the drive, like C:\\Users\\you\\Downloads\\game.');
  } else if (!path.isAbsolute(s)) throw new Error('Give the full path, starting with /.');
  return path.resolve(s);
}

// The real place of a path, and what it is.
function realOf(raw) {
  const asked = toPath(raw);
  try {
    const real = fs.realpathSync.native(asked);
    const st = fs.statSync(real);
    return { asked, real, dir: st.isDirectory(), size: st.size };
  } catch (e) {
    throw new Error(e && e.code === 'ENOENT' ? `There is nothing at ${asked}.` : `Could not open ${asked} (${(e && e.code) || e.message}).`);
  }
}

const sizeText = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// deps: { askAddon(type, payload, ms) -> Promise<{ ok, error, folder, tab_id, title }> }
function createLocalPages(deps) {
  // The path's real place, once the user allows its folder. kind: 'file', 'dir' or 'any'.
  async function allow(raw, kind) {
    const f = realOf(raw);
    if (kind === 'dir' && !f.dir) throw new Error(`${f.real} is a file. Use local_file_read to read it or local_page_open to open it.`);
    if (kind === 'file' && f.dir) throw new Error(`${f.real} is a folder. Use local_files to see what is in it.`);
    const why = guard.localProblem(f.real, f.dir);
    if (why) throw new Error(`Not allowed: ${f.real}: ${why}.`);
    const r = await deps.askAddon('local_grant', { path: f.real, kind: f.dir ? 'dir' : 'file' }, ASK_MS);
    if (!r || !r.ok) throw new Error((r && r.error) || 'The user did not allow it.');
    // The folder the user allowed must hold the real place (it does, as the add-on took the folder from it).
    if (!r.folder || !guard.within(f.real, r.folder)) throw new Error(`Not allowed: ${f.real} is outside ${r.folder || 'the folder the user allowed'}.`);
    f.folder = r.folder;
    return f;
  }

  // local_page_open: a page or file in a new Zen tab, in front, for Claude to see and play.
  async function open(args) {
    const f = await allow(args && args.path, 'any');
    let url = pathToFileURL(f.real).href;
    if (f.dir && !url.endsWith('/')) url += '/';
    const exe = findZen();
    if (!exe) throw new Error(`Could not find zen.exe, so nothing was opened. Ask the user to open ${f.real} in Zen (drag it onto Zen), then use its tab.`);
    // Zen gives its child processes (this helper included) variables that change how a new zen.exe starts. Without
    // them it hands the URL to the Zen that is already running, as a desktop shortcut would.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(MOZ_|XRE_|XUL_|MOZILLA_)/i.test(k)) delete env[k];
    try {
      const child = spawn(exe, ['-new-tab', url], { env, detached: true, stdio: 'ignore' });
      child.on('error', e => log.warn('zen -new-tab', e.message));
      child.unref();
    } catch (e) {
      throw new Error(`Could not ask Zen to open the page (${e.message}).`);
    }
    log.info(`local page: ${f.real}`);
    const t = await deps.askAddon('local_tab', { url }, TAB_MS);
    if (!t || !t.ok || !Number.isInteger(t.tab_id)) throw new Error((t && t.error) || 'Zen did not show the page.');
    return { tab_id: t.tab_id, title: t.title || '', url, path: f.real, allowed_folder: f.folder,
      note: 'Open in a new Zen tab, in front. Use screenshot, get_page_text, find, click and press_key with this tab_id.' };
  }

  // local_files: what is in a folder, folders first. Protected folders and secret files are left out.
  async function list(args) {
    const f = await allow(args && args.path, 'dir');
    let items;
    try { items = fs.readdirSync(f.real, { withFileTypes: true }).slice(0, MAX_SCAN); } catch (e) { throw new Error(`Could not list ${f.real} (${e.code || e.message}).`); }
    const dirs = [], files = [];
    for (const d of items) {
      const full = path.join(f.real, d.name);
      let st = null;
      try { st = fs.statSync(full); } catch {}   // follows links; a broken link has no stat
      const isDir = st ? st.isDirectory() : d.isDirectory();
      if (isDir ? guard.folderProblem(full) : guard.secretFile(full)) continue;
      if (isDir) dirs.push(`${d.name}/`);
      else files.push(`${d.name}  (${st ? sizeText(st.size) : 'broken link'})`);
    }
    const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const all = dirs.sort(byName).concat(files.sort(byName));
    const shown = all.slice(0, MAX_LIST);
    const more = all.length - shown.length;
    return { title: f.real, url: pathToFileURL(f.real).href,
      text: (shown.length ? shown.join('\n') : '(Empty folder.)') + (more > 0 ? `\n…and ${more} more.` : ''), truncated: more > 0 };
  }

  // local_file_read: the text of a file (HTML, scripts, text; Office files as Markdown), in parts.
  async function read(args) {
    const f = await allow(args && args.path, 'file');
    if (f.size > MAX_READ) throw new Error(`${f.real} is ${sizeText(f.size)}, more than local_file_read opens (5 MB). Open it with local_page_open instead.`);
    let text;
    if (kindOf(f.real)) text = extractText(f.real).text;
    else {
      const buf = fs.readFileSync(f.real);
      if (buf.subarray(0, 8000).includes(0)) throw new Error(`${f.real} is not a text file. Open it with local_page_open to see it.`);
      text = buf.toString('utf8').replace(/^\uFEFF/, '');
    }
    const start = Math.max(0, Math.floor(Number(args && args.start_at) || 0));
    const next = start + PART < text.length ? start + PART : null;
    return { title: path.basename(f.real), url: pathToFileURL(f.real).href, text: text.slice(start, start + PART) || '(Empty file.)',
      total_chars: text.length, next_start: next, truncated: next != null };
  }

  return { open, list, read };
}

module.exports = { createLocalPages, toPath, findZen };
