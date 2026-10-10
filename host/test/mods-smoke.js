'use strict';
// Mods: the folder scan, the saved on/off and error state, and "turn all off". Temp folders only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const MODS = require('../lib/mods');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-mods-'));
const modsDir = path.join(root, 'mods');
const stateFile = path.join(root, 'state', 'mods.json');
const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(modsDir, rel)), { recursive: true }); fs.writeFileSync(path.join(modsDir, rel), text); };
put('good/panel.js', 'window.goodMod = true;');
put('good/mod.json', JSON.stringify({ name: 'Good mod', description: 'A test mod.' }));
put('styleonly/style.css', 'body { color: red; }');
put('empty/notes.txt', 'nothing to load');
put('badjson/panel.js', 'window.x = 1;');
put('badjson/mod.json', '{ not json');
put('Bad_Name/panel.js', 'window.x = 1;');
put('big/panel.js', 'x'.repeat(MODS.MAX_JS + 1));
put('saved/panel.js', 'window.saved = true;');

const list = MODS.scanMods(modsDir, stateFile);
const byId = Object.fromEntries(list.map(m => [m.id, m]));
ok('the scan lists mod folders with a valid name only', list.map(m => m.id).join(',') === 'badjson,big,empty,good,saved,styleonly', list.map(m => m.id).join(','));
ok('a folder name with capitals or underscores is left out', !byId['Bad_Name']);
ok('mod.json gives the name and the description', byId.good.name === 'Good mod' && byId.good.description === 'A test mod.');
ok('without mod.json the name is the folder name, and the mod is on', byId.saved.name === 'saved' && byId.saved.enabled === true && byId.saved.broken === '');
ok('panel.js and style.css are seen', byId.good.panel === true && byId.good.style === false && byId.styleonly.style === true && byId.styleonly.panel === false);
ok('a folder with neither file is broken', /neither/.test(byId.empty.broken), byId.empty.broken);
ok('an invalid mod.json is broken', /not valid JSON/.test(byId.badjson.broken), byId.badjson.broken);
ok('a panel.js over 256 KB is broken', /larger than 256 KB/.test(byId.big.broken), byId.big.broken);
ok('a missing mods folder gives an empty list', MODS.scanMods(path.join(root, 'nothing'), stateFile).length === 0);

MODS.setModState(modsDir, stateFile, 'good', { enabled: false });
ok('turning a mod off is saved', MODS.scanMods(modsDir, stateFile).find(m => m.id === 'good').enabled === false);
MODS.setModState(modsDir, stateFile, 'good', { enabled: true, broken: '' });
ok('turning it back on works', MODS.scanMods(modsDir, stateFile).find(m => m.id === 'good').enabled === true);

MODS.setModState(modsDir, stateFile, 'saved', { broken: 'boom at line 3' });
let s = MODS.scanMods(modsDir, stateFile).find(m => m.id === 'saved');
ok('a reported failure marks the mod broken, with its message', s.broken === 'boom at line 3', s.broken);
ok('a broken mod stays on (its switch is what turns it off)', s.enabled === true);
MODS.setModState(modsDir, stateFile, 'saved', { enabled: true, broken: '' });
s = MODS.scanMods(modsDir, stateFile).find(m => m.id === 'saved');
ok('turning it on again clears the error (try again)', s.broken === '' && s.enabled === true);

MODS.allModsOff(modsDir, stateFile);
ok('turn all mods off switches every mod off', MODS.scanMods(modsDir, stateFile).every(m => m.enabled === false));
ok('the state file is plain JSON', (() => { try { JSON.parse(fs.readFileSync(stateFile, 'utf8')); return true; } catch { return false; } })());
ok('no temp files are left beside it', fs.readdirSync(path.dirname(stateFile)).every(f => !/\.tmp$/.test(f)));
ok('an id that is not a mod id is refused', MODS.setModState(modsDir, stateFile, '../evil', { enabled: true }).ok === false);
ok('and nothing is written for it', !JSON.parse(fs.readFileSync(stateFile, 'utf8'))['../evil']);

fs.rmSync(root, { recursive: true, force: true });
console.log(`${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
