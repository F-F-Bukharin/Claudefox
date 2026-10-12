'use strict';
// Child process lifecycle for the watch tool: a deadline, a kill of the whole tree on deadline or Stop, and one run folder per run (watch-tool plan, Task 5).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const children = require('./children');

function createWatchRuns({ killTree }) {
  const live = new Set();   // { child, stopped, timedOut } for every run that has not settled

  function run({ exe, args, cwd, env, deadlineMs }) {
    return new Promise(resolve => {
      const entry = { child: null, stopped: false, timedOut: false };
      let stdout = '', stderr = '', settled = false, timer = null;
      const settle = code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        live.delete(entry);
        resolve({ code, stdout, stderr, timedOut: entry.timedOut, stopped: entry.stopped });
      };
      let child;
      try {
        child = spawn(exe, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        stderr = String((e && e.message) || e);
        return settle(-1);
      }
      entry.child = child;
      children.track(child, 'watch');   // listed in children.json, so a helper that stops without cleaning up leaves no run behind
      live.add(entry);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', e => { stderr += String((e && e.message) || e); settle(-1); });
      child.on('close', code => settle(code === null ? -1 : code));
      timer = setTimeout(() => { entry.timedOut = true; killTree(child, false); }, deadlineMs);
    });
  }

  function stopAll(sync) {
    for (const entry of live) {
      entry.stopped = true;
      if (entry.child) killTree(entry.child, sync);
    }
  }

  return { run, stopAll };
}

// A new run folder under baseDir: run-XXXXXX.
function makeRunDir(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  return fs.mkdtempSync(path.join(baseDir, 'run-'));
}

// A killed ffmpeg can hold a file for a moment on Windows, so removal is retried.
function removeRunDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

module.exports = { createWatchRuns, makeRunDir, removeRunDir };
