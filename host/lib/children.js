'use strict';
// The child processes the helper starts (a chat turn, an army worker, a watch run, the Improve tests) and the list of
// them in the data folder (%LOCALAPPDATA%\claude-in-zen\children.json): { pid, kind, started }. A helper that stops
// without cleaning up leaves them running, so the next start stops the ones still running and clears the file.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const P = require('./paths');
const log = require('./log');

const FILE = path.join(P.BASE, 'children.json');
// Only these programs are stopped: the helper's own node, Claude Code, and the cmd it can run. A pid can be reused by
// the user's own program after a reboot, so anything else holding that pid is left alone.
const ALLOWED = process.platform === 'win32' ? ['node.exe', 'claude.exe', 'cmd.exe'] : ['node', 'claude'];

const live = new Map();   // pid -> { pid, kind, started } for the children running now

function save() {
  try {
    fs.mkdirSync(P.BASE, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...live.values()]));
  } catch (e) { log.warn('children.json', e.message); }
}

// Lists a child the helper has just started, and takes it off the list when it exits. Never throws.
function track(child, kind) {
  try {
    if (!child || !child.pid) return;   // a spawn that failed has no pid
    const entry = { pid: child.pid, kind, started: Date.now() };
    live.set(entry.pid, entry);
    save();
    child.once('exit', () => {
      if (live.get(entry.pid) !== entry) return;   // a newer child may have taken the same pid
      live.delete(entry.pid);
      save();
    });
  } catch (e) { log.warn('children track', e.message); }
}

function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The program a pid runs, in lower case ("node", or "node.exe" on Windows). '' when it cannot be read.
function imageName(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = /^"([^"]+)"/.exec(out.trim());
      return m ? m[1].toLowerCase() : '';
    }
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase();
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 }).trim();
    return path.basename(comm).toLowerCase();
  } catch { return ''; }
}

// When a pid's process started, in ms since 1970, or null when it cannot be read.
function startedAt(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      const t = Date.parse(out.trim());
      return Number.isFinite(t) ? t : null;
    }
    if (process.platform === 'linux') {
      // Field 22 of /proc/<pid>/stat is the start in clock ticks after boot; the fields after the ")" of the name start at 3.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const btime = Number((/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8')) || [])[1]);
      let hz = 100;
      try { hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 }).trim()) || 100; } catch {}
      return Number.isFinite(ticks) && btime ? btime * 1000 + (ticks / hz) * 1000 : null;
    }
    const t = Date.parse(execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000 }).trim());
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

// A listed child is still the same process only if it started before the helper listed it. A process that started later
// holds a reused pid: it may be the user's own node or Claude Code, so it is left alone, and so is one whose start cannot
// be read. The slack covers the coarse clocks (boot time in whole seconds on Linux).
const START_SLACK_MS = 2000;
function sameProcess(pid, listedAt) {
  const t = startedAt(pid);
  return t !== null && Number.isFinite(listedAt) && t <= listedAt + START_SLACK_MS;
}

// Stops a process and what it started. On POSIX the whole group goes, since the chat and army children lead one.
function killTree(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch {}
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// Called once when the helper starts, before any child exists: stops the leftovers the file names, then clears it.
// A missing or broken file means there is nothing to do.
function reapAtStart() {
  let list;
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return; }
  if (!Array.isArray(list)) return;
  let stopped = 0;
  for (const e of list) {
    const pid = Number(e && e.pid);
    // Never this process or the one that started it, and never pid 0 or 1: a group kill with those reaches far more
    // than one program.
    if (!Number.isInteger(pid) || pid < 2 || pid === process.pid || pid === process.ppid) continue;
    if (!running(pid) || !ALLOWED.includes(imageName(pid)) || !sameProcess(pid, Number(e.started))) continue;
    killTree(pid);
    stopped++;
  }
  try { fs.writeFileSync(FILE, '[]'); } catch (e) { log.warn('children.json', e.message); }
  if (stopped) log.info(`stopped ${stopped} process(es) left running by an earlier helper`);
}

module.exports = { FILE, track, reapAtStart };
