'use strict';
// Questions only the user can answer, in a small window of their own (host/confirm.ps1): a Windows window the helper
// opens outside Zen, which nothing in the add-on or the panel can reach or click, a mod included. It guards what lets
// Claude reach further: a tool that runs a program on this PC, a plugin install, a folder for local pages, Unsafe mode
// and file tools. One question at a time; no answer within two minutes counts as no, and so does Stop.
//
// CLAUDE_IN_ZEN_CONFIRM (tests, with CLAUDE_IN_ZEN_TEST=1): a program run instead of the window, with the same environment variables; it prints
// "yes" or "no". Without it, only Windows has the window: elsewhere every question is a no.

const path = require('path');
const { spawn } = require('child_process');
const log = require('./log');
const { testHook } = require('./paths');
const T = require('./confirmtexts');

const ASK_MS = 120000;
const SCRIPT = path.join(__dirname, '..', 'confirm.ps1');

// The text the window shows: control characters other than line breaks are removed, so nothing hides or rewrites it.
function cleanText(s) { return String(s).replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ''); }

// deps: { killTree(child, sync) }
function createConfirm(deps) {
  let queue = Promise.resolve();
  const open = new Set();   // windows on screen now (at most one)

  function runOne(q) {
    return new Promise(resolve => {
      const lang = T.getLang();   // a text may be a string or { en, pt_BR }: the language at the moment the window opens
      const env = { ...process.env, CIZ_Q_TITLE: String(T.pick(q.title, lang) || 'Claude in Zen').slice(0, 120), CIZ_Q_TEXT: cleanText(T.pick(q.text, lang) || '').slice(0, 3000),
        CIZ_Q_YES: String(T.pick(q.yes, lang) || 'Yes').slice(0, 40), CIZ_Q_NO: String(T.pick(q.no, lang) || 'No').slice(0, 40) };
      const testExe = testHook('CLAUDE_IN_ZEN_CONFIRM');
      let exe, args;
      if (testExe) { exe = testExe; args = []; }
      else if (process.platform === 'win32') { exe = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', SCRIPT]; }
      else return resolve({ ok: false, error: 'This system has no confirm window, so the answer is no.' });
      let child, out = '', done = false, timer = null;
      const finish = r => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        open.delete(child);
        log.info(`confirm "${env.CIZ_Q_TITLE}": ${r.ok ? 'yes' : r.error}`);
        resolve(r);
      };
      try {
        child = spawn(exe, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        return resolve({ ok: false, error: `Could not open the confirm window (${e.message}).` });
      }
      open.add(child);
      timer = setTimeout(() => { deps.killTree(child); finish({ ok: false, error: 'No answer in the confirm window within two minutes, so the answer is no.' }); }, ASK_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', d => { out += d; });
      child.on('error', e => finish({ ok: false, error: `Could not open the confirm window (${e.message}).` }));
      child.on('close', () => finish(out.replace(/^﻿/, '').trim() === 'yes' ? { ok: true } : { ok: false, error: 'The answer in the confirm window was no.' }));
    });
  }

  // { title, text, yes, no } (each a string or { en, pt_BR }, see confirmtexts.js) -> Promise<{ ok, error }>. Questions wait their turn.
  function ask(q) {
    const p = queue.then(() => runOne(q));
    queue = p.catch(() => {});
    return p;
  }

  // Stop: every open window goes, which answers no.
  function closeAll(sync) { for (const c of open) deps.killTree(c, sync); }

  return { ask, closeAll };
}

module.exports = { createConfirm, cleanText, ASK_MS };
