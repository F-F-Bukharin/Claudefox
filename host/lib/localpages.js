'use strict';
// Local pages and files: Claude may open, list or read something on this computer only inside a folder the user
// allowed. The helper keeps the allowed folders (local-grants.json) and asks about a new one in its own confirm window
// (lib/confirm.js: "Allow this folder" or "Deny"), which nothing in the add-on or the panel can answer for the user. The
// add-on gets the list to guard file: tabs (extension/lib/local.js) and shows it in Profile, Permissions.
//
// Every path is followed to its real place first (links and junctions), and the real place is what the user is asked
// about, so a link inside an allowed folder never reaches outside it. Protected places (lib/guard.js) are refused
// before anyone is asked. Firefox does not let add-ons open file: tabs, so local_page_open asks the browser to open the
// page the way a desktop shortcut does: <browser>.exe -new-tab <file: URL>, with the browser that started this helper
// (Zen or Firefox). Army workers never get here (lib/armyguard.js).

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const guard = require('./guard');
const log = require('./log');
const { extractText, kindOf } = require('./doctext');

const TAB_MS = 20000;                     // the add-on looks for the new tab for up to 10 s
const MAX_LIST = 300;                     // entries local_files shows
const MAX_SCAN = 5000;                    // entries it looks at
const MAX_READ = 5 * 1024 * 1024;         // the largest file local_file_read opens
const PART = 60000;                       // characters per part
// What local_page_open shows: kinds Zen draws in a tab itself. Anything else (a program, a script, an archive) would go
// to Windows to "open", so it is refused; local_file_read gives the text of those.
const SHOWN = /\.(html?|xhtml?|shtml|svg|xml|txt|text|md|markdown|json|css|m?js|log|csv|tsv|pdf|png|jpe?g|gif|webp|bmp|ico|avif|apng|mp4|webm|og[gva]|mp3|wav|flac|m4a|opus)$/i;

// Browsers that take -new-tab like Firefox does. Only these are ever started to show a page.
const BROWSER = /^(firefox|zen|librewolf|waterfox|floorp|mullvadbrowser)\.exe$/i;
const isBrowserExe = p => BROWSER.test(path.win32.basename(String(p || '')));

function installed(folder, exe) {
  const pf = process.env.ProgramFiles, pf86 = process.env['ProgramFiles(x86)'], local = process.env.LOCALAPPDATA;
  const places = [pf && path.join(pf, folder, exe), pf86 && path.join(pf86, folder, exe),
    local && path.join(local, folder, exe), local && path.join(local, 'Programs', folder, exe)];
  return places.find(p => p && fs.existsSync(p)) || '';
}
// zen.exe and firefox.exe in the usual install places (as tools\xpi-tools.ps1 looks for Zen).
function findZen() { return installed('Zen Browser', 'zen.exe'); }
function findFirefox() { return installed('Mozilla Firefox', 'firefox.exe'); }

// The browser that started this helper: on Windows its parent's parent (browser -> cmd.exe -> node), read from the
// process table. '' when it is not a known browser or cannot be read.
function parentBrowser() {
  if (process.platform !== 'win32') return Promise.resolve('');
  const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(process.ppid)}"; if ($p) { (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)").ExecutablePath }`;
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
    const exe = String(out || '').trim();
    resolve(!err && isBrowserExe(exe) && fs.existsSync(exe) ? exe : '');
  }));
}

// The browser to show local pages in: CLAUDE_IN_ZEN_ZEN_EXE (tests only, with CLAUDE_IN_ZEN_TEST=1), else the one that
// started this helper, so Zen opens them in Zen and Firefox in Firefox, else Zen or Firefox where they usually are installed.
let browserFound = null;
async function findBrowser() {
  if (process.env.CLAUDE_IN_ZEN_TEST === '1' && process.env.CLAUDE_IN_ZEN_ZEN_EXE) return process.env.CLAUDE_IN_ZEN_ZEN_EXE;
  if (!browserFound) browserFound = (await parentBrowser()) || findZen() || findFirefox();
  return browserFound;
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
    return { asked, real, dir: st.isDirectory(), file: st.isFile(), size: st.size };
  } catch (e) {
    throw new Error(e && e.code === 'ENOENT' ? `There is nothing at ${asked}.` : `Could not open ${asked} (${(e && e.code) || e.message}).`);
  }
}

// A device, pipe or socket (a FIFO, or on Windows a name like CON): reading it could block the helper for good.
const NOT_A_FILE = p => `${p} is not a regular file (a device, pipe or socket), so it is not opened.`;
const sizeText = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// The allowed folders: kept in memory only, so they last one session. The file an older version saved (`file`) is deleted
// here, and `note` says so for the helper to log.
function createGrants(file) {
  let list = [];
  let note = '';
  try { fs.unlinkSync(file); note = 'Saved local-page folders were cleared: they now last one session.'; }
  catch (e) { if (e.code !== 'ENOENT') log.error('local grants', e.message); }
  return {
    note,
    list: () => list.slice(),
    // The allowed folder that holds this path, or ''.
    covering: p => list.find(f => guard.within(p, f)) || '',
    add(folder) { const f = path.resolve(folder); if (!list.some(g => guard.within(f, g))) list = list.filter(g => !guard.within(g, f)).concat([f]); },
    remove(folder) {
      const before = list.length;
      list = list.filter(g => !(guard.within(g, folder) && guard.within(folder, g)));
      return list.length !== before;
    },
  };
}

// deps: { askAddon(type, payload, ms) -> Promise<{ ok, error, tab_id, title }>, confirm({ title, text, yes, no }) ->
// Promise<{ ok, error }>, grants: createGrants(...), changed() (the list changed: tell the add-on),
// asking(folder) (a question about this folder is on screen, or '' when it is over) }
function createLocalPages(deps) {
  // A folder the user has not allowed yet: they answer in the confirm window, which says what Claude was reading
  // (no reading: no page). Resolves the allowed folder.
  async function askFolder(folder, reading) {
    const have = deps.grants.covering(folder);
    if (have) return have;
    if (deps.asking) deps.asking(folder);
    let r;
    try {
      r = await deps.confirm({
        title: 'Claude in Zen: allow a folder?',
        text: `Claude asks to look in this folder and its subfolders:\n\n${folder}\n\nClaude was reading: ${reading || 'no page'}\n\nIt may then open, list and read the files there, until you remove the folder in Claude in Zen's Profile, Permissions. Army workers never look there.`,
        yes: 'Allow this folder', no: 'Deny',
      });
    } finally { if (deps.asking) deps.asking(''); }
    if (!r || !r.ok) throw new Error(`The user did not allow Claude to look in ${folder}. ${(r && r.error) || ''}`.trim());
    deps.grants.add(folder);
    if (deps.changed) deps.changed();
    return deps.grants.covering(folder) || folder;
  }

  // The path's real place, once the user allows its folder. kind: 'file', 'dir' or 'any'.
  async function allow(raw, kind) {
    const f = realOf(raw);
    if (kind === 'dir' && !f.dir) throw new Error(`${f.real} is a file. Use local_file_read to read it or local_page_open to open it.`);
    if (kind === 'file' && f.dir) throw new Error(`${f.real} is a folder. Use local_files to see what is in it.`);
    if (!f.dir && !f.file) throw new Error(NOT_A_FILE(f.real));
    const why = guard.localProblem(f.real, f.dir);
    if (why) throw new Error(`Not allowed: ${f.real}: ${why}.`);
    f.folder = await askFolder(f.dir ? f.real : path.dirname(f.real));
    if (!guard.within(f.real, f.folder)) throw new Error(`Not allowed: ${f.real} is outside ${f.folder}.`);
    return f;
  }

  // The add-on found a file: tab outside the allowed folders (extension/lib/local.js): the same question, for that folder.
  async function allowFolder(raw) {
    const f = realOf(raw);
    if (!f.dir) throw new Error(`${f.real} is not a folder.`);
    const why = guard.localProblem(f.real, true);
    if (why) throw new Error(`Not allowed: ${f.real}: ${why}.`);
    return askFolder(f.real);
  }

  // local_page_open: a page or file in a new Zen tab, in front, for Claude to see and play.
  async function open(args) {
    const raw = args && args.path;
    const first = realOf(raw);   // checked before the user is asked, so nothing refused here ever asks
    const why = guard.localProblem(first.real, first.dir);
    if (why) throw new Error(`Not allowed: ${first.real}: ${why}.`);
    if (!first.dir && !first.file) throw new Error(NOT_A_FILE(first.real));
    if (!first.dir && !SHOWN.test(first.real)) {
      throw new Error(`local_page_open shows web pages, text, PDFs, images, audio and video, not ${path.extname(first.real) || 'files without an extension'}. Use local_file_read for the text of other files.`);
    }
    const f = await allow(raw, 'any');
    let url = pathToFileURL(f.real).href;
    if (f.dir && !url.endsWith('/')) url += '/';
    const exe = await findBrowser();
    if (!exe) throw new Error(`Could not find the browser (Zen or Firefox), so nothing was opened. Ask the user to open ${f.real} in the browser (drag it onto a tab), then use its tab.`);
    // The browser gives its child processes (this helper included) variables that change how a new browser process
    // starts. Without them it hands the URL to the browser that is already running, as a desktop shortcut would.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(MOZ_|XRE_|XUL_|MOZILLA_)/i.test(k)) delete env[k];
    try {
      const child = spawn(exe, ['-new-tab', url], { env, detached: true, stdio: 'ignore' });
      child.on('error', e => log.warn('browser -new-tab', e.message));
      child.unref();
    } catch (e) {
      throw new Error(`Could not ask the browser to open the page (${e.message}).`);
    }
    log.info(`local page: ${f.real}`);
    const t = await deps.askAddon('local_tab', { url }, TAB_MS);
    if (!t || !t.ok || !Number.isInteger(t.tab_id)) throw new Error((t && t.error) || 'The browser did not show the page.');
    return { tab_id: t.tab_id, title: t.title || '', url, path: f.real, allowed_folder: f.folder,
      note: 'Open in a new tab, in front. Use screenshot, get_page_text, find, click and press_key with this tab_id.' };
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

  return { open, list, read, allowFolder, askFolder };
}

module.exports = { createLocalPages, createGrants, toPath, findZen, findFirefox, findBrowser, isBrowserExe };
