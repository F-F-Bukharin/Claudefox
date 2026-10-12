// The two language files for tests (extension/_locales/<lang>/messages.json) and what a test needs to look at them.
//   load()    -> { en, pt_BR }: the repo's two messages.json files, parsed ({ key: { message } }).
//   pseudo()  -> { en, pt_BR }: the real English, and every pt_BR message as «English», so a test can see at a glance
//                which texts went through t() (the $n of each message stay).
//   SKIP_TEXT -> a RegExp for visible texts that need no translation (brand and product names, symbols, numbers, key
//                names, slash commands, web addresses, paths, the language names), matched against the whole trimmed text.
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'extension', '_locales');
const LANGS = ['en', 'pt_BR'];

function load() {
  const out = {};
  for (const l of LANGS) out[l] = JSON.parse(fs.readFileSync(path.join(DIR, l, 'messages.json'), 'utf8'));
  return out;
}

function pseudo() {
  const { en } = load();
  const pt = {};
  for (const k of Object.keys(en)) pt[k] = { message: '«' + en[k].message + '»' };
  return { en, pt_BR: pt };
}

// Names the add-on never translates (contract C7), then anything that is only symbols, punctuation or digits, key
// names, slash commands, web addresses and the two language names, which are shown in their own language everywhere.
const NAMES = ['Claude', 'Claude Code', 'claude\\.ai', 'Claude in Zen', 'Claudefox', 'Zen', 'Firefox', 'Anthropic', 'Opus 5\\.5',
  'Sonnet', 'Haiku 5\\.5', 'Caveman', 'vidIQ', 'Desktop Commander', 'MCP', '2FA'];
const SKIP_TEXT = new RegExp('^(?:'
  + '(?:' + NAMES.join('|') + ')'
  + '|[\\s\\d\\p{P}\\p{S}\\p{Extended_Pictographic}]*'                      // …  —  ×  ✓  ✕  ■  ·  numbers, emoji
  + '|(?:Ctrl|Alt|Shift|Win|Enter|Esc|Tab|F\\d+)(?:\\+(?:Ctrl|Alt|Shift|Win|Enter|Esc|Tab|F\\d+|[A-Z0-9]))+'  // Alt+Shift+C
  + '|\\/[a-z][a-z-]*'                                                       // /tabs
  + '|[a-z0-9-]+(?:\\.[a-z0-9-]+)+'                                          // example.org
  + '|[\\w.-]+(?:[\\\\/][\\w.-]+)+'                                           // extension\mods, a/b
  + '|English|Português \\(Brasil\\)'
  + ')$', 'u');

module.exports = { load, pseudo, SKIP_TEXT, LANGS, DIR };
