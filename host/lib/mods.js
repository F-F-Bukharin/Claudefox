'use strict';
// Mods: small add-ons for the panel, one folder each under extension/mods/<id>/. The core never changes them.
// A mod has panel.js and/or style.css, and an optional mod.json with a name and a description. Whether a mod is on,
// and any error the panel reported for it, is kept in mods.json beside the helper's other files, not in the add-on.
const fs = require('fs');
const path = require('path');

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_JS = 256 * 1024;   // bytes
const MAX_CSS = 128 * 1024;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readState(stateFile) {
  const s = readJson(stateFile);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}
function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = stateFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}
function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return -1; }
}

// One mod folder, as the panel needs it. `broken` says why it cannot load ('' when it can).
function describeMod(modsDir, id, saved) {
  const dir = path.join(modsDir, id);
  const mod = { id, name: id, description: '', panel: false, style: false, enabled: saved.enabled !== false, broken: '' };
  const hasMeta = fs.existsSync(path.join(dir, 'mod.json'));
  const meta = hasMeta ? readJson(path.join(dir, 'mod.json')) : null;
  if (hasMeta && (!meta || typeof meta !== 'object' || Array.isArray(meta))) mod.broken = 'mod.json is not valid JSON';
  if (meta && typeof meta.name === 'string' && meta.name.trim()) mod.name = meta.name.trim().slice(0, 60);
  if (meta && typeof meta.description === 'string') mod.description = meta.description.trim().slice(0, 200);
  const js = sizeOf(path.join(dir, 'panel.js'));
  const css = sizeOf(path.join(dir, 'style.css'));
  mod.panel = js >= 0;
  mod.style = css >= 0;
  if (!mod.broken && !mod.panel && !mod.style) mod.broken = 'has neither panel.js nor style.css';
  if (!mod.broken && js > MAX_JS) mod.broken = 'panel.js is larger than 256 KB';
  if (!mod.broken && css > MAX_CSS) mod.broken = 'style.css is larger than 128 KB';
  if (!mod.broken && saved.broken) mod.broken = String(saved.broken).slice(0, 300);
  return mod;
}

// Every mod folder with a valid name, sorted by id. A missing mods folder gives an empty list.
function scanMods(modsDir, stateFile) {
  let ids = [];
  try {
    ids = fs.readdirSync(modsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && ID.test(d.name)).map(d => d.name).sort();
  } catch { return []; }
  const state = readState(stateFile);
  return ids.map(id => describeMod(modsDir, id, state[id] && typeof state[id] === 'object' ? state[id] : {}));
}

// Changes one mod's saved state. Turning a mod on clears its error: that is how "try again" works.
function setModState(modsDir, stateFile, id, patch) {
  if (!ID.test(String(id || ''))) return { ok: false, error: 'not a mod id' };
  const state = readState(stateFile);
  const next = { ...(state[id] && typeof state[id] === 'object' ? state[id] : {}) };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.broken === 'string') {
    next.broken = patch.broken.slice(0, 300);
    if (next.broken) next.enabled = false;   // a reported failure turns the mod off, and the reason is kept
  }
  if (patch.enabled === true && !patch.broken) next.broken = '';   // turning it on again is how a mod is tried again
  state[id] = next;
  writeState(stateFile, state);
  return { ok: true };
}

// Turns every mod off (the panel's "Turn all mods off").
function allModsOff(modsDir, stateFile) {
  const state = readState(stateFile);
  for (const m of scanMods(modsDir, stateFile)) state[m.id] = { ...(state[m.id] || {}), enabled: false };
  writeState(stateFile, state);
}

module.exports = { ID, MAX_JS, MAX_CSS, scanMods, describeMod, setModState, allModsOff };
