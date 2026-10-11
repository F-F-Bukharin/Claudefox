'use strict';
// The vendored watch engine on a generated local video (watch-tool plan, Task 2). Skips when python3 or ffmpeg is missing.   node host/test/watch-engine-smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'host', 'vendor', 'claude-video', 'watch.py');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };

if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).error || spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).error) {
  console.log('SKIP python3 or ffmpeg is not installed');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-engine-'));
try {
  const clip = path.join(dir, 'clip.mp4');
  const made = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=5', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' });
  check('the test clip is made', made.status === 0 && fs.existsSync(clip), (made.stderr || '').trim());
  const run = spawnSync('python3', ['-B', SCRIPT, '--detail', 'efficient', '--max-frames', '24', '--resolution', '512',
    '--no-whisper', '--out-dir', path.join(dir, 'out'), '--', clip], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  const out = run.stdout || '';
  check('watch.py exits 0', run.status === 0, (run.stderr || '').trim().split('\n').pop());
  check('the report has Frames and Transcript sections', /^## Frames$/m.test(out) && /^## Transcript$/m.test(out));
  const frames = [...out.matchAll(/^- `([^`]+)` \(t=/gm)].map(m => m[1]);
  check('at least one frame is listed', frames.length >= 1, String(frames.length));
  check('no more than 24 frames are listed', frames.length <= 24, String(frames.length));
  for (const f of frames) {
    const head = fs.existsSync(f) ? fs.readFileSync(f).subarray(0, 3) : Buffer.alloc(0);
    check(`${path.basename(f)} exists and starts as JPEG`, head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff);
  }
  check('the report names no cookie, setup script or cloud engine', !/cookie|setup\.py|whisperx|groq|openai|gemini/i.test(out));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
process.exit(failed ? 1 : 0);
