'use strict';
// WebFetch scope (A3): which sites a chat may fetch. The helper answers the WebFetch hook (webfetch-hook.js) through
// decide(): a site listed for the chat, or any site in trusted mode, and never once Claude has read a local file in the
// message, so a local file's text cannot steer a fetch somewhere else.

// The tools that read the user's own files. One of them in a message turns WebFetch off for the rest of that message.
const LOCAL_READ_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__claude-in-zen__read_document', 'mcp__claude-in-zen__local_files', 'mcp__claude-in-zen__local_file_read'];

const NO_CHECK = 'Claudefox could not check this address, so WebFetch is blocked.';
const OFF = 'WebFetch is off for the rest of this message because Claude read a local file.';

// IPv4, [IPv6] and localhost match only exactly: "0.1" is no parent of "127.0.0.1", "localhost" none of "x.localhost".
const exactOnly = h => h === 'localhost' || h.startsWith('[') || /^[\d.]+$/.test(h);

// The site of an http(s) address: its lower-case host with one leading "www." and one trailing dot dropped. '' otherwise.
function siteOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  const host = u.hostname.toLowerCase();
  if (exactOnly(host)) return host;
  return host.replace(/^www\./, '').replace(/\.$/, '');
}

// Whether the site is an entry of the list, or a subdomain of one.
function match(list, site) {
  return list.some(entry => entry === site || (!exactOnly(site) && !exactOnly(entry) && site.endsWith('.' + entry)));
}

// turn: { sites, localRead } of the running turn, or null when there is none. trusted: the turn may fetch any site.
function decide(turn, url, trusted) {
  const site = siteOf(url);
  if (!turn || site === '') return { allowed: false, reason: NO_CHECK };
  if (turn.localRead) return { allowed: false, reason: OFF };
  if (trusted || match(turn.sites || [], site)) return { allowed: true, reason: '' };
  return { allowed: false, reason: `${site} is not one of this chat's sites. Ask the user to allow it in the panel first.` };
}

module.exports = { siteOf, match, decide, LOCAL_READ_TOOLS };
