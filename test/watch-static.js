'use strict';
// Static checks for the watch tool (the plan's Task 1 section "vendor", more sections come later).
// The vendored claude-video copy must carry no cookie handling, no cloud engine, no setup script and no reads of the user's settings.   node test/watch-static.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'host', 'vendor', 'claude-video');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };

// section vendor
const KEPT = ['watch.py', 'download.py', 'frames.py', 'transcribe.py', 'config.py', 'runtime.py'];
for (const f of ['gemini.py', 'whisper.py', 'local_whisperx.py', 'setup.py']) check(`${f} is gone`, !fs.existsSync(path.join(VENDOR, f)));
check('LICENSE and NOTICE.md are there', fs.existsSync(path.join(VENDOR, 'LICENSE')) && fs.existsSync(path.join(VENDOR, 'NOTICE.md')));
for (const f of KEPT) {
  const file = path.join(VENDOR, f);
  check(`${f} is there`, fs.existsSync(file));
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  check(`${f}: no cookie handling`, !/cookie/i.test(text));
  check(`${f}: no network or cloud import`, !/urlopen|urllib\.request|import requests|httpx|import (gemini|whisper|local_whisperx|setup|groq|openai|genai|whisperx)\b/.test(text));
  check(`${f}: no removed-engine or setup.py text`, !/setup\.py|whisperx|groq|openai|gemini|WATCH_/i.test(text));
  check(`${f}: reads no environment, home folder or .env`, !/environ|Path\.home|expanduser|\.env\b/.test(text));
}
const py = spawnSync('python3', ['-I', '-B', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(VENDOR)}); import watch, download, frames, transcribe, config, runtime; print('imports ok')`], { encoding: 'utf8' });
if (!py.error) check('the vendored modules import under python3 -I', py.status === 0 && /imports ok/.test(py.stdout), (py.stderr || '').trim().split('\n').pop());

console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
process.exit(failed ? 1 : 0);
