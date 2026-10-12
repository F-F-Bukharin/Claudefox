'use strict';
// Shared locations for the host, the tool server and the installer.
const os = require('os');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BASE = path.join(LOCAL, 'claude-in-zen');
const USER = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
// The test-only overrides (CLAUDE_IN_ZEN_PIPE, CLAUDE_IN_ZEN_CONFIRM, CLAUDE_IN_ZEN_SCRIPT) count only with CLAUDE_IN_ZEN_TEST=1,
// so no variable in a user's environment can move the pipe, swap the confirm window or script the tool server.
const testHook = name => (process.env.CLAUDE_IN_ZEN_TEST === '1' ? process.env[name] : undefined);

module.exports = {
  BASE,
  LOG_DIR: path.join(BASE, 'logs'),
  TOKEN_FILE: path.join(BASE, 'pipe-token'),
  CLAUDE_CONFIG_DIR: path.join(BASE, 'claude'),      // the first account's Claude Code profile ("main")
  ACCOUNTS_DIR: path.join(BASE, 'accounts'),         // one Claude Code profile folder per added account
  ACCOUNTS_FILE: path.join(BASE, 'accounts.json'),   // which account is active, cached emails
  WORKSPACE: path.join(BASE, 'workspace'),
  MCP_CONFIG: path.join(BASE, 'mcp.json'),
  MCP_ARMY_CONFIG: path.join(BASE, 'mcp-army.json'),   // the lead's tool server in Army mode (army_start, army_wait)
  ARMY_DIR: path.join(BASE, 'army'),                    // one tool-server config per running army worker
  LOCAL_GRANTS: path.join(BASE, 'local-grants.json'),   // folders the user allowed for local pages (lib/localpages.js)
  WATCH_DIR: path.join(BASE, 'watch'),                 // one run folder per watch_video run (lib/watchrun.js)
  WATCH_ON_LOAD: path.join(BASE, 'watch-on-load.json'),   // the saved answer to "watch videos every time the panel opens?" (lib/watchgate.js)
  PIPE: testHook('CLAUDE_IN_ZEN_PIPE') || (process.platform === 'win32'
    ? `\\\\.\\pipe\\claude-in-zen-${USER}`
    : path.join(os.tmpdir(), `claude-in-zen-${USER}.sock`)),
  testHook,
};
