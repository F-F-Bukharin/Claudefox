'use strict';
// The chat accounts on this PC. Every chat account is its own Claude Code profile folder: "main" is the one "Sign in
// Claude Code.bat" signs in, added accounts live in accounts\<id>. Switching only changes which folder chat turns use,
// so nothing is ever logged out to switch and each account keeps its own sign-in, like Google's account switcher.
// The sign-in flows are in signin.js.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const log = require('./log');

// Returns { acc, accountIds, accountDir, activeId, removeAccountDir, saveAccounts }. acc is the stored state:
// { active, meta, hidden }, kept in P.ACCOUNTS_FILE.
function createAccounts() {
  let acc = loadAccounts();

  function loadAccounts() {
    let a = {};
    try { a = JSON.parse(fs.readFileSync(P.ACCOUNTS_FILE, 'utf8')) || {}; } catch {}
    return {
      active: typeof a.active === 'string' ? a.active : 'main',
      meta: a.meta && typeof a.meta === 'object' ? a.meta : {},
      hidden: Array.isArray(a.hidden) ? a.hidden.filter(x => typeof x === 'string') : [],
    };
  }

  function saveAccounts() {
    try { fs.writeFileSync(P.ACCOUNTS_FILE, JSON.stringify(acc, null, 2)); } catch (e) { log.error('accounts.json', e.message); }
  }

  const ADDED_ID = /^a[0-9a-z]{4,24}$/;

  function accountIds() {
    const ids = acc.hidden.includes('main') ? [] : ['main'];
    try {
      for (const d of fs.readdirSync(P.ACCOUNTS_DIR, { withFileTypes: true })) {
        if (d.isDirectory() && ADDED_ID.test(d.name) && !acc.hidden.includes(d.name)) ids.push(d.name);
      }
    } catch {}
    return ids;
  }

  function accountDir(id) { return id === 'main' || !ADDED_ID.test(id) ? P.CLAUDE_CONFIG_DIR : path.join(P.ACCOUNTS_DIR, id); }

  function activeId() {
    const ids = accountIds();
    return ids.includes(acc.active) ? acc.active : (ids[0] || 'main');
  }

  function removeAccountDir(id) {
    if (!ADDED_ID.test(id)) return;   // never touch "main" or anything outside accounts\
    try { fs.rmSync(path.join(P.ACCOUNTS_DIR, id), { recursive: true, force: true }); } catch (e) { log.warn('remove account dir', e.message); }
  }

  return { acc, accountIds, accountDir, activeId, removeAccountDir, saveAccounts };
}

module.exports = { createAccounts };
