'use strict';
// Signing chat accounts in, switching between them and removing them: the account list the panel shows, and the
// "claude auth login" console window of an add or a sign-in. The stored accounts are in accounts.js.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const P = require('./paths');
const log = require('./log');

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

// deps: everything createAccounts() returns, plus { findClaude, claudeEnv, statusOf, sendStatus } (claudecode.js),
// sendAddon(msg), and chatBusy(): true while a chat turn runs (no account change then).
function createSignIn({ acc, accountIds, accountDir, activeId, removeAccountDir, saveAccounts, findClaude, claudeEnv, statusOf, sendStatus, sendAddon, chatBusy }) {
  let login = null;   // the open sign-in window: { id, dir, isNew, started, timer }

  async function listAccounts() {
    // A new account is not on the list until its sign-in finishes: until then its folder is only the sign-in in progress.
    const pending = login && login.isNew ? login.id : '';
    const ids = accountIds().filter(id => id !== pending);
    if (acc.hidden.includes('main')) {
      // "Sign in Claude Code.bat" may have signed the removed main profile back in: show it again.
      const s = await statusOf(P.CLAUDE_CONFIG_DIR);
      if (s.loggedIn) { acc.hidden = acc.hidden.filter(x => x !== 'main'); ids.unshift('main'); }
    }
    const active = activeId();
    const rows = await Promise.all(ids.map(async id => {
      const s = await statusOf(accountDir(id));
      const m = acc.meta[id] || {};
      const email = String(s.email || s.emailAddress || m.email || '');
      const plan = String(s.subscriptionType || m.plan || '');
      if (s.loggedIn && email) acc.meta[id] = Object.assign({}, m, { email, plan });
      return {
        id, email, plan, loggedIn: !!s.loggedIn, active: id === active,
        org: String(s.orgName || s.organizationName || ''), lastUsed: Number(m.lastUsed) || 0,
      };
    }));
    saveAccounts();
    rows.sort((a, b) => (b.active - a.active) || (b.loggedIn - a.loggedIn) || (b.lastUsed - a.lastUsed));
    return rows;
  }

  let accountsSeq = 0;
  function sendAccounts() {
    const seq = ++accountsSeq;   // same rule as sendStatus: only the newest list reaches the panel
    listAccounts()
      .then(rows => { if (seq === accountsSeq) sendAddon({ type: 'accounts', accounts: rows, login: login ? { id: login.id, isNew: login.isNew } : null }); })
      .catch(e => log.error('accounts', e.message));
  }

  function accountDone(action, id, ok, error, extra) {
    sendAddon(Object.assign({ type: 'account_result', action, id, ok: !!ok, error: error || '' }, extra || {}));
  }

  function afterAccountChange() {
    sendStatus();
    sendAccounts();
  }

  function useAccount(id) {
    if (chatBusy()) return accountDone('use', id, false, 'Claude is still answering. Switch accounts after it finishes.');
    if (!accountIds().includes(id)) return accountDone('use', id, false, 'That account is not on this PC any more.');
    acc.active = id;
    acc.meta[id] = Object.assign({}, acc.meta[id], { lastUsed: Date.now() });
    saveAccounts();
    log.info(`accounts: using ${id}`);
    accountDone('use', id, true, '', { email: (acc.meta[id] || {}).email || '' });
    afterAccountChange();
  }

  function addAccount() {
    if (login) return accountDone('add', login.id, false, 'A sign-in window is already open. Finish it or press Cancel.');
    if (chatBusy()) return accountDone('add', '', false, 'Claude is still answering. Add the account after it finishes.');
    const id = 'a' + Date.now().toString(36);
    startLogin(id, true);
  }

  function signInAccount(id) {
    if (login) return accountDone('signin', login.id, false, 'A sign-in window is already open. Finish it or press Cancel.');
    if (!accountIds().includes(id)) return accountDone('signin', id, false, 'That account is not on this PC any more.');
    startLogin(id, false);
  }

  // "claude auth login" in a console window of its own, so the user sees what it says. On Windows a small .cmd
  // file runs it (the window stays open long enough to read the result); elsewhere (tests) it runs directly.
  function openLoginWindow(exe, dir) {
    if (process.platform === 'win32') {
      const q = v => String(v).replace(/%/g, '%%');
      const script = path.join(P.BASE, 'sign-in.cmd');
      const lines = [
        '@echo off', 'chcp 65001 >nul', 'title Claudefox - add a Claude account',
        `set "CLAUDE_CONFIG_DIR=${q(dir)}"`, 'set "ANTHROPIC_API_KEY="', 'set "ANTHROPIC_AUTH_TOKEN="', 'set "CLAUDE_CODE_OAUTH_TOKEN="',
        'echo A browser window opens. Sign in to the Claude account you want, then click Authorize.', 'echo.',
        `"${q(exe)}" auth login`, 'echo.', `"${q(exe)}" auth status --text`, 'echo.',
        'echo The Claudefox panel picks this up on its own. You can close this window.', 'timeout /t 15 >nul',
      ];
      fs.writeFileSync(script, lines.join('\r\n') + '\r\n', 'utf8');
      const child = spawn('cmd.exe', ['/d', '/s', '/c', `"start "" "${script}""`],
        { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', e => log.warn('sign-in window', e.message));
      child.unref();
      return;
    }
    const child = spawn(exe, ['auth', 'login'], { env: claudeEnv(dir), cwd: P.WORKSPACE, detached: true, stdio: 'ignore' });
    child.on('error', e => log.warn('auth login', e.message));
    child.unref();
  }

  function startLogin(id, isNew) {
    const action = isNew ? 'add' : 'signin';
    const exe = findClaude();
    if (!exe) return accountDone(action, id, false, 'Claude Code is not installed on this PC.');
    const dir = accountDir(id);
    try { fs.mkdirSync(dir, { recursive: true }); openLoginWindow(exe, dir); }
    catch (e) { if (isNew) removeAccountDir(id); return accountDone(action, id, false, `Could not open the sign-in window: ${e.message}`); }
    login = { id, dir, isNew, started: Date.now(), timer: null };
    sendAccounts();   // the panel drops the new folder's row and shows the sign-in instead
    log.info(`accounts: sign-in window open for ${isNew ? 'a new account' : id}`);
    accountDone('login_started', id, true, '', { isNew });
    const poll = async () => {
      if (!login || login.id !== id) return;
      const s = await statusOf(dir);
      if (!login || login.id !== id) return;
      if (s.loggedIn) return finishLogin(true, s);
      if (Date.now() - login.started > LOGIN_TIMEOUT_MS) return finishLogin(false, null, 'The sign-in was not finished within 10 minutes.');
      login.timer = setTimeout(poll, 3000);
    };
    login.timer = setTimeout(poll, 4000);
  }

  function finishLogin(ok, status, error) {
    const L = login;
    if (!L) return;
    login = null;
    clearTimeout(L.timer);
    if (!ok) {
      if (L.isNew) removeAccountDir(L.id);
      accountDone('login', L.id, false, error || 'Sign-in failed.');
      return afterAccountChange();
    }
    const email = String(status.email || status.emailAddress || '');
    const dupe = L.isNew && email && accountIds().find(k => k !== L.id && ((acc.meta[k] || {}).email || '').toLowerCase() === email.toLowerCase());
    let id = L.id;
    if (dupe) { removeAccountDir(L.id); id = dupe; }   // already on the list: just switch to it
    acc.active = id;
    acc.meta[id] = Object.assign({}, acc.meta[id], { email, plan: String(status.subscriptionType || ''), lastUsed: Date.now() });
    saveAccounts();
    log.info(`accounts: signed in, now using ${id}`);
    accountDone('login', id, true, '', { email, already: !!dupe });
    afterAccountChange();
  }

  function removeAccount(id) {
    if (!accountIds().includes(id)) return accountDone('remove', id, false, 'That account is not on this PC any more.');
    if (login && login.id === id) return accountDone('remove', id, false, 'Finish or cancel its sign-in window first.');
    if (id === activeId() && accountIds().length > 1) return accountDone('remove', id, false, 'Switch to another account before removing this one.');
    if (chatBusy()) return accountDone('remove', id, false, 'Claude is still answering. Remove the account after it finishes.');
    const exe = findClaude();
    const finish = () => {
      if (id === 'main') { if (!acc.hidden.includes('main')) acc.hidden.push('main'); }
      else removeAccountDir(id);
      delete acc.meta[id];
      if (acc.active === id) acc.active = accountIds()[0] || 'main';
      saveAccounts();
      log.info(`accounts: removed ${id}`);
      accountDone('remove', id, true);
      afterAccountChange();
    };
    if (!exe) return finish();
    execFile(exe, ['auth', 'logout'], { env: claudeEnv(accountDir(id)), timeout: 20000, windowsHide: true }, finish);
  }

  // The panel's Cancel on an open sign-in window.
  function cancelSignIn() {
    if (login) finishLogin(false, null, 'Cancelled.');
  }

  // Shutdown: stop watching the open window (the window itself stays: finishing it still works later).
  function forgetLogin() {
    if (login) { clearTimeout(login.timer); login = null; }
  }

  return { sendAccounts, useAccount, addAccount, signInAccount, removeAccount, cancelSignIn, forgetLogin };
}

module.exports = { createSignIn };
