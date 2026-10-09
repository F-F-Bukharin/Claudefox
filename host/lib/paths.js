'use strict';
// Shared locations for the host, the tool server and the installer.
const os = require('os');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BASE = path.join(LOCAL, 'claude-in-zen');
const USER = (os.userInfo().username || 'user').replace(/[^A-Za-z0-9_.-]/g, '_');

module.exports = {
  BASE,
  LOG_DIR: path.join(BASE, 'logs'),
  TOKEN_FILE: path.join(BASE, 'pipe-token'),
  CLAUDE_CONFIG_DIR: path.join(BASE, 'claude'),      // the first account's Claude Code profile ("main")
  ACCOUNTS_DIR: path.join(BASE, 'accounts'),         // one Claude Code profile folder per added account
  ACCOUNTS_FILE: path.join(BASE, 'accounts.json'),   // which account is active, cached emails
  WORKSPACE: path.join(BASE, 'workspace'),
  MCP_CONFIG: path.join(BASE, 'mcp.json'),
  PIPE: process.env.CLAUDE_IN_ZEN_PIPE || (process.platform === 'win32'
    ? `\\\\.\\pipe\\claude-in-zen-${USER}`
    : path.join(os.tmpdir(), `claude-in-zen-${USER}.sock`)),
};
