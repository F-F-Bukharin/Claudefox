'use strict';
// Shared locations for the host, the tool server and the installer.
const os = require('os');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BASE = path.join(LOCAL, 'claudefox');
const USER = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');
// The test-only overrides (CLAUDEFOX_PIPE, CLAUDEFOX_CONFIRM, CLAUDEFOX_SCRIPT, CLAUDEFOX_PICK) count only with
// CLAUDEFOX_TEST=1, so no variable in a user's environment can move the pipe, swap the confirm window, script the tool
// server or answer the folder window.
const testHook = name => (process.env.CLAUDEFOX_TEST === '1' ? process.env[name] : undefined);

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
  // Pictures Claude saves (download_image) go straight into the user's Downloads folder (a test may move it).
  DOWNLOADS_DIR: testHook('CLAUDEFOX_DOWNLOADS') || path.join(process.env.USERPROFILE || os.homedir(), 'Downloads'),
  OUTPUT_DIR: path.join(BASE, 'output'),                // files Claude makes and the add-on stores here (Settings, Saving files; lib/output.js)
  LOCAL_GRANTS: path.join(BASE, 'local-grants.json'),   // folders the user allowed for local pages (lib/localpages.js)
  WATCH_ON_LOAD: path.join(BASE, 'watch-on-load.json'),   // the saved answer to "watch videos every time the panel opens?" (lib/watchgate.js)
  PIPE: testHook('CLAUDEFOX_PIPE') || (process.platform === 'win32'
    ? `\\\\.\\pipe\\claudefox-${USER}`
    : path.join(os.tmpdir(), `claudefox-${USER}.sock`)),
  testHook,
};
