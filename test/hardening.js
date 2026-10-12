'use strict';
// Hardening checks: the words that mark a password, 2FA or payment field (extension/lib/policy.js). No browser needed.
//   node test/hardening.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };

// policy.js is a plain script: load it into its own context, as test/dom-page-tools.js does.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'policy.js'), 'utf8') + '\nthis.cizSensitiveField = cizSensitiveField;', ctx);
const refusedAs = desc => ctx.cizSensitiveField(desc);

// Portuguese and Spanish words, each labelling a field that must be refused. Every spelling counts: as written,
// in capitals, and without accents.
const TERMS = [
  ['senha', 'password field'], ['contraseña', 'password field'], ['clave', 'password field'],
  ['código de verificação', '2FA code field'], ['código de segurança', '2FA code field'], ['verificação em duas etapas', '2FA code field'],
  ['código de acceso', '2FA code field'], ['código de verificación', '2FA code field'],
  ['cartão', 'payment field'], ['número do cartão', 'payment field'], ['nome no cartão', 'payment field'], ['validade do cartão', 'payment field'],
  ['vencimento', 'payment field'], ['CVV', 'payment field'], ['CVC', 'payment field'], ['tarjeta', 'payment field'],
  ['número de tarjeta', 'payment field'], ['fecha de vencimiento', 'payment field'], ['titular', 'payment field'],
];
const spellings = word => [word, word.toUpperCase(), word.normalize('NFD').replace(/[̀-ͯ]/g, '')];
for (const [word, kind] of TERMS) {
  const got = spellings(word).map(label => refusedAs({ type: 'text', label }));
  check(`a field labelled "${word}" is refused as a ${kind}`, got.every(k => k === kind), got.join(' | '));
}
check('an ordinary Portuguese "Nome" field is not refused', refusedAs({ type: 'text', label: 'Nome' }) === null);
check('an ordinary Portuguese "Endereço de entrega" field is not refused', refusedAs({ type: 'text', label: 'Endereço de entrega' }) === null);

console.log(`${passed} checks passed${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
