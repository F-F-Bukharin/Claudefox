'use strict';
// The project folder this helper runs from (host\..). With the source there, the helper runs tools\install-xpi.ps1:
// it rebuilds the .xpi (or picks the signed one for this version) and hands it to Zen, which shows its install
// prompt. When Zen is linked to the folder the add-on just reloads instead. Friends' copies have no source.


const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const log = require('./log');

// deps: { ROOT, sendAddon }
function createUpdates({ ROOT, sendAddon }) {
  function sourceInfo() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
      return { sourceVersion: String(m.version || ''), canUpdate: process.platform === 'win32' && fs.existsSync(path.join(ROOT, 'tools', 'install-xpi.ps1')), linked: isLinked() };
    } catch { return { sourceVersion: '', canUpdate: false, linked: false }; }
  }

  // True when a Zen profile loads the add-on straight from this folder (a proxy file written by link.ps1).
  function isLinked() {
    try {
      const zen = path.join(process.env.APPDATA || '', 'zen');
      const ini = fs.readFileSync(path.join(zen, 'profiles.ini'), 'utf8');
      const want = path.resolve(ROOT, 'extension').toLowerCase().replace(/[\\/]+$/, '');
      for (const m of ini.matchAll(/^Path=(.+)$/gm)) {
        const rel = m[1].trim();
        const dir = path.isAbsolute(rel) ? rel : path.join(zen, rel);
        try {
          const target = fs.readFileSync(path.join(dir, 'extensions', 'claude-in-zen@f.local'), 'utf8').trim();
          if (path.resolve(target).toLowerCase().replace(/[\\/]+$/, '') === want) return true;
        } catch {}
      }
    } catch {}
    return false;
  }

  let updating = false;
  function updateAddon() {
    const done = (ok, error, version, note) => {
      updating = false;
      sendAddon({ type: 'update_result', ok, error: error || '', version: version || '', note: note || '' });
    };
    if (updating) return;
    const info = sourceInfo();
    if (!info.canUpdate) return done(false, 'This copy has no add-on source to build from. Install the newer .xpi you were sent instead.');
    updating = true;
    log.info(`update: installing v${info.sourceVersion}`);
    // Zen gives its child processes (this helper included) variables that change how a new zen.exe starts.
    // install-xpi.ps1 drops them too; dropping them here keeps PowerShell itself clean.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(MOZ_|XRE_|XUL_|MOZILLA_)/i.test(k)) delete env[k];
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'install-xpi.ps1'), '-Quiet'],
      { cwd: ROOT, env, timeout: 120000, windowsHide: true }, (err, stdout) => {
        const lines = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (err && err.code === 2) return done(false, 'Zen is linked to the project folder, so the add-on reloads instead of reinstalling.');
        if (err) return done(false, (lines.find(l => /failed/i.test(l)) || lines.pop() || err.message).slice(0, 300));
        done(true, '', info.sourceVersion, lines.find(l => /signed build|unsigned/i.test(l)) || '');
      });
  }

  return { sourceInfo, updateAddon };
}

module.exports = { createUpdates };
