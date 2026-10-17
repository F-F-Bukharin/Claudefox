'use strict';
// Sentences that more than one prompt says word for word: the Zen MCP instructions (claudefox-mcp.js), the chat prompt and
// the army worker prompt (lib/chatargs.js), and the description of the local page tool (lib/toolSchemas.js).
const NEVER_TYPE_SECRETS = 'Never type passwords, 2FA codes or payment details.';
const NEVER_TYPE_SECRETS_ANY_MODE = 'Never type passwords, 2FA codes or payment details, in any mode.';
const GOOGLE_SIGNIN_HANDS_OFF = 'Google sign-in pages are hands-off.';
const FILE_PAGES_NOT_TABS = 'tab_open and navigate cannot open file: pages.';

module.exports = { NEVER_TYPE_SECRETS, NEVER_TYPE_SECRETS_ANY_MODE, GOOGLE_SIGNIN_HANDS_OFF, FILE_PAGES_NOT_TABS };
