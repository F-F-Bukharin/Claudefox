'use strict';
// Claude in Zen: accounts. Sign-in reuses the claude.ai session Zen has open (no cookies are read),
// and the helper's account switch keeps one Claude Code profile per account (accountAction, onAccountResult).

// ---------------------------------------------------------------- sign-in
// Reuses the claude.ai session already open in Zen. The browser attaches the
// session itself; the add-on never reads cookies. Only email/name/uuid are
// kept, and only in storage.session.

const ACCOUNT_ENDPOINTS = ['/api/account', '/api/bootstrap', '/api/organizations'];

function pickAccount(path, j) {
  if (!j || typeof j !== 'object') return null;
  if (Array.isArray(j)) {               // /api/organizations: no email, org only
    const org = j[0];
    return org && org.uuid ? { email: '', name: org.name || 'Claude organization', uuid: org.uuid, via: path } : null;
  }
  const a = j.account && typeof j.account === 'object' ? j.account : j;
  const email = a.email_address || a.email || '';
  const uuid = a.uuid || a.id || '';
  if (!email && !uuid) return null;
  return { email, name: a.full_name || a.display_name || a.name || '', uuid, via: path };
}

async function fetchAccountFromBackground() {
  const notes = [];
  for (const path of ACCOUNT_ENDPOINTS) {
    try {
      const r = await fetch(CIZ.CLAUDE_ORIGIN + path, {
        credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' },
      });
      notes.push(`${path} ${r.status}`);
      if (r.status === 401) return { account: null, notes, signedOut: true };
      if (!r.ok) continue;
      const acct = pickAccount(path, await r.json().catch(() => null));
      if (acct) return { account: acct, notes };
    } catch (e) {
      notes.push(`${path} ${e.message}`);
    }
  }
  return { account: null, notes };
}

// Fallback: run the same request from inside an open claude.ai tab, where it
// is a normal same-origin call. Returns only the minimal fields.
async function fetchAccountViaTab() {
  const tabs = await browser.tabs.query({ url: CIZ.CLAUDE_ORIGIN + '/*' });
  if (!tabs.length) return { account: null, notes: ['no claude.ai tab open'] };
  const code = `(async () => {
    const paths = ${JSON.stringify(ACCOUNT_ENDPOINTS)};
    const notes = [];
    for (const p of paths) {
      try {
        const r = await fetch(p, { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } });
        notes.push(p + ' ' + r.status);
        if (r.status === 401) return { signedOut: true, notes };
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j)) { const o = j[0]; if (o && o.uuid) return { path: p, acct: { email: '', name: o.name || '', uuid: o.uuid, array: true }, notes }; continue; }
        const a = (j && j.account && typeof j.account === 'object') ? j.account : j;
        const email = a.email_address || a.email || '', uuid = a.uuid || a.id || '';
        if (email || uuid) return { path: p, acct: { email, name: a.full_name || a.display_name || a.name || '', uuid }, notes };
      } catch (e) { notes.push(p + ' ' + e.message); }
    }
    return { notes };
  })()`;
  const [res] = await browser.tabs.executeScript(tabs[0].id, { code });
  if (!res) return { account: null, notes: ['tab check returned nothing'] };
  if (res.acct) return { account: Object.assign(res.acct, { via: res.path + ' (tab)' }), notes: res.notes };
  return { account: null, notes: res.notes || [], signedOut: !!res.signedOut };
}

// Opening the .xpi to install it leaves a tab on the file behind. Close those when the add-on starts.
async function closeInstallerTabs() {
  try {
    const tabs = await browser.tabs.query({});
    const ids = tabs.filter(t => /^file:\/\/.*\/(signed\/)?claude[-_]in[-_]zen[^/]*\.xpi$/i.test(t.url || '')).map(t => t.id);
    if (ids.length) await browser.tabs.remove(ids);
  } catch {}
}

// Remembered sign-in: after a manual sign-in the add-on keeps a marker (email, name, account id; never
// cookies) in storage.local. When Zen starts, it checks the claude.ai session again on its own, so you stay
// signed in until you sign out here or on claude.ai. Signing out here forgets the marker.
const REMEMBER_KEY = 'rememberedAccount';

async function remembered() {
  try { return (await browser.storage.local.get(REMEMBER_KEY))[REMEMBER_KEY] || null; } catch { return null; }
}

let resumeBusy = false;
async function resumeSignIn(why) {
  if (resumeBusy || cizState.get().signedIn) return;
  const r = await remembered();
  if (!r) return;
  resumeBusy = true;
  try { await signIn({ auto: why }); } finally { resumeBusy = false; }
}

// The add-on's account is the claude.ai session Zen has open. Once the add-on is signed in, it follows that
// session: when claude.ai is on another account (for example after you sign in there as the account you picked
// with Use), the add-on switches over the next time a claude.ai page loads. It never signs out by itself and
// never reads cookies.
let followBusy = false;
async function followClaudeAccount() {
  if (followBusy || !cizState.get().signedIn) return;
  followBusy = true;
  try {
    const { account } = await fetchAccountFromBackground();
    if (!account || !account.email) return;   // signed out, or claude.ai unreadable right now: keep the add-on as it is
    const now = cizState.get().account || {};
    if (String(now.email || '').toLowerCase() === account.email.toLowerCase()) return;
    await cizState.set({ account, signedInAt: Date.now() });
    await browser.storage.local.set({ [REMEMBER_KEY]: { email: account.email, name: account.name || '', uuid: account.uuid || '', at: Date.now() } });
    await cizState.addLog('info', `The add-on follows claude.ai: now signed in as ${account.email}`);
  } catch {
    // claude.ai could not be read; the add-on stays as it was
  } finally {
    followBusy = false;
  }
}

// A claude.ai tab finishing its load is a good moment to retry (e.g. Zen started offline), or to follow a
// claude.ai account that changed while the add-on was signed in.
browser.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status !== 'complete' || !tab || !String(tab.url || '').startsWith(CIZ.CLAUDE_ORIGIN + '/')) return;
  if (cizState.get().signedIn) followClaudeAccount();
  else resumeSignIn('claude.ai tab');
});

async function signIn(opts) {
  const auto = opts && opts.auto;
  await cizState.addLog('info', auto ? 'Signing back in from the claude.ai session…' : 'Checking claude.ai session…');
  let res = await fetchAccountFromBackground();
  if (!res.account && !res.signedOut) {
    await cizState.addLog('info', `Direct check failed (${res.notes.join(', ')}); trying an open claude.ai tab`);
    try { res = await fetchAccountViaTab(); } catch (e) { res = { account: null, notes: [e.message] }; }
  }
  if (!res.account) {
    await cizState.set({ signedIn: false, account: null, signedInAt: null });
    const why = res.signedOut ? 'not signed in to claude.ai' : res.notes.join(', ');
    if (auto && res.signedOut) {
      // claude.ai itself was signed out: the remembered sign-in no longer holds.
      try { await browser.storage.local.remove(REMEMBER_KEY); } catch {}
      await cizState.addLog('warn', 'claude.ai is signed out, so the add-on is too. Sign in to claude.ai, then press Sign in.');
      return;
    }
    await cizState.addLog(auto ? 'warn' : 'error', auto
      ? `Could not sign back in yet (${why}). It retries when a claude.ai tab loads, or press Sign in.`
      : `Sign-in failed: ${why}. Open claude.ai, sign in there, then try again.`);
    return;
  }
  const before = await remembered();
  await cizState.set({ signedIn: true, account: res.account, signedInAt: Date.now() });
  try {
    const a = res.account;
    await browser.storage.local.set({ [REMEMBER_KEY]: { email: a.email || '', name: a.name || '', uuid: a.uuid || '', at: Date.now() } });
  } catch {}
  const who = res.account.email || res.account.name || res.account.uuid;
  await cizState.addLog('info', `Signed in as ${who} (via ${res.account.via})${auto ? ', remembered from last time' : ''}`);
  if (before && before.uuid && res.account.uuid && before.uuid !== res.account.uuid) {
    await cizState.addLog('warn', `claude.ai is now a different account than last time (${before.email || before.uuid}).`);
  }
}

async function signOut() {
  try { await browser.storage.local.remove(REMEMBER_KEY); } catch {}
  await stopAll('Sign-out');
  await cizState.set({ signedIn: false, account: null, signedInAt: null });
  await cizState.addLog('info', 'Signed out of the add-on (claude.ai itself is untouched)');
}

// ---------------------------------------------------------------- accounts
// The helper keeps one Claude Code profile per account (Google-style switching). The add-on relays the
// panel's requests, keeps the list in state, and can retry a message after a switch (usage limit).

let pendingRetry = null;   // { id, text }: send this again once the switch to account id is done

// Profile shows how a switch went (accountNote) and that one is waiting (accountBusy), not only the action log.
async function accountNote(ok, text) {
  await cizState.set({ accountNote: { ok: !!ok, text: String(text || '').slice(0, 300) } });
}

async function accountAction(type, id, retry) {
  if (cizState.get().agent !== 'active') return cizState.addLog('error', 'Press Start first.');
  if (chatRuns.size && type !== 'account_signin') {
    if (type === 'account_use') await accountNote(false, t('bg_acctBusy'));
    return cizState.addLog('error', 'Claude is still answering. Try again after it finishes.');
  }
  const accountId = String(id || '');
  if (!sendNative({ type, id: accountId })) {
    if (type === 'account_use') await accountNote(false, t('bg_acctNoHelper'));
    return cizState.addLog('error', 'Accounts: the helper is not connected.');
  }
  if (type === 'account_use') await cizState.set({ accountBusy: accountId, accountNote: null });
  if (type === 'account_use' && retry && typeof retry === 'string') pendingRetry = { id: accountId, text: retry.slice(0, 50000) };
  if (type === 'account_add') await cizState.addLog('info', 'Opening a sign-in window for another Claude account…');
}

function accountLabel(id) {
  const a = (cizState.get().accounts || []).find(x => x.id === id);
  return (a && a.email) || 'the account';
}

async function onAccountResult(msg) {
  const id = String(msg.id || '');
  switch (msg.action) {
    case 'use': {
      await cizState.set({ accountBusy: '' });
      if (!msg.ok) {
        pendingRetry = null;
        await accountNote(false, msg.error || t('bg_acctNoSwitch'));
        return cizState.addLog('error', `Switch failed: ${msg.error}`);
      }
      await cizState.set({ chatSession: '' });   // conversations belong to the account that had them
      if (typeof winSessions !== 'undefined') winSessions.clear();   // each window's too
      await followClaudeAccount();   // if claude.ai is already on the chosen account, the add-on follows it now
      const who = msg.email || accountLabel(id);
      await accountNote(true, t('bg_acctNow', who));
      await cizState.addLog('info', `Chat now uses ${who}`);
      if (pendingRetry && pendingRetry.id === id) postToPanels({ type: 'retry', text: pendingRetry.text });
      pendingRetry = null;
      return;
    }
    case 'login_started':
      await cizState.set({ accountLogin: { id, isNew: !!msg.isNew, at: Date.now() } });
      return cizState.addLog('info', 'A sign-in window is open: pick the Claude account in the browser and click Authorize. The panel notices when you are done.');
    case 'login':
      await cizState.set({ accountLogin: null });
      if (!msg.ok) return cizState.addLog(/Cancelled/.test(msg.error) ? 'info' : 'error', `Sign-in: ${msg.error}`);
      await cizState.set({ chatSession: '' });
      if (typeof winSessions !== 'undefined') winSessions.clear();
      return cizState.addLog('info', msg.already
        ? `${msg.email} was already on the list. Switched to it.`
        : `Signed in as ${msg.email || 'the new account'}. The chat uses it now.`);
    case 'add':
    case 'signin':
      if (!msg.ok) return cizState.addLog('error', `Sign-in: ${msg.error}`);
      return;
    case 'remove':
      return cizState.addLog(msg.ok ? 'info' : 'error', msg.ok ? 'Account removed from Claude in Zen.' : `Remove failed: ${msg.error}`);
  }
}

let claudeCheckAsked = false;   // log the next status answer (set by the panel's "check" link)

function requestClaudeStatus(fromPanel) {
  if (fromPanel) {
    claudeCheckAsked = true;
    cizState.addLog('info', 'Checking Claude Code sign-in…');
  }
  if (!sendNative({ type: 'claude_status' }) && fromPanel) {
    claudeCheckAsked = false;
    cizState.addLog('error', 'Claude Code check failed: the helper is not connected.');
  }
}
