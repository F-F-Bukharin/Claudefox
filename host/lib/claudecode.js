'use strict';
// Claude Code on this PC: where the program is, the environment every Claude Code process the helper starts gets, who
// is signed in, and the tool server config its chat turns load.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const P = require('./paths');
const log = require('./log');

// Locates the Claude Code binary. The native installer puts it in ~/.local/bin.
function findClaude() {
  const win = process.platform === 'win32';
  const names = win ? ['claude.exe'] : ['claude'];
  const candidates = [];
  // A test stub for the program's path. It counts only with CLAUDE_IN_ZEN_TEST=1 (lib/paths.js), so a variable in a
  // user's environment cannot point the helper at another program.
  const stub = P.testHook('CLAUDE_IN_ZEN_CLAUDE');
  if (stub) candidates.push(stub);
  candidates.push(path.join(os.homedir(), '.local', 'bin', names[0]));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) for (const n of names) candidates.push(path.join(dir, n));
  }
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// The tool server config Claude Code loads for chat turns (and that "Test" scripts can reuse).
function writeMcpConfig() {
  const cfg = {
    mcpServers: {
      'claude-in-zen': {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(__dirname, '..', 'zen-mcp.js')],
        env: { CLAUDE_IN_ZEN_CLIENT: 'Claude in Zen panel', CLAUDE_IN_ZEN_PANEL: '1', CLAUDE_IN_ZEN_WATCH: '1' },
        alwaysLoad: true,   // never hidden behind tool search, whatever else is switched on
      },
    },
  };
  try { fs.writeFileSync(P.MCP_CONFIG, JSON.stringify(cfg, null, 2)); } catch (e) { log.error('mcp.json', e.message); }
  // Army turns: the same server, which then also offers army_start and army_wait to the lead.
  const lead = JSON.parse(JSON.stringify(cfg));
  lead.mcpServers['claude-in-zen'].env.CLAUDE_IN_ZEN_ARMY_LEAD = '1';
  try { fs.writeFileSync(P.MCP_ARMY_CONFIG, JSON.stringify(lead, null, 2)); } catch (e) { log.error('mcp-army.json', e.message); }
}

// deps: { accountDir(id), activeId(), sendAddon(msg) }
function createClaudeCode({ accountDir, activeId, sendAddon }) {
  // Environment for every Claude Code process the host starts: the profile folder of the active account (or the
  // one given), and no API-key or third-party-provider variables, so usage always runs on the user's plan.
  function claudeEnv(dir) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir || accountDir(activeId()), MCP_TOOL_TIMEOUT: '960000' };
    for (const k of [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    ]) delete env[k];
    return env;
  }

  // Sends the active account's sign-in state. Each call supersedes the ones before it, so a slow
  // "auth status" for an account the user just switched away from can never overwrite the new one.
  let statusSeq = 0;
  function sendStatus() {
    const seq = ++statusSeq, id = activeId();
    statusOf(accountDir(id))
      .then(s => { if (seq === statusSeq) sendAddon({ type: 'claude_status', ...s, accountId: id }); })
      .catch(e => log.error('status', e.message));
  }

  // "claude auth status" for one profile folder.
  function statusOf(dir) {
    return new Promise(resolve => {
      const exe = findClaude();
      if (!exe) return resolve({ installed: false, loggedIn: false });
      execFile(exe, ['auth', 'status'], { env: claudeEnv(dir), timeout: 20000, windowsHide: true }, (err, stdout) => {
        let info = {};
        try { info = JSON.parse(String(stdout || '').trim() || '{}'); } catch {}
        const pick = {};
        for (const k of ['authMethod', 'email', 'emailAddress', 'organizationName', 'orgName', 'subscriptionType', 'configDirectory']) {
          if (typeof info[k] === 'string') pick[k] = info[k];
        }
        const loggedIn = typeof info.loggedIn === 'boolean' ? info.loggedIn : (!err && pick.authMethod !== 'none');
        resolve({ installed: true, loggedIn, ...pick });
      });
    });
  }

  return { findClaude, claudeEnv, statusOf, sendStatus };
}

module.exports = { createClaudeCode, writeMcpConfig };
