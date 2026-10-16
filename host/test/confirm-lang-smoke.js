'use strict';
// Portuguese (E11): the helper's confirm windows speak the language the add-on sends in its hello (lang) and in {type:'lang'}.
// confirmtexts.js holds both texts; confirmflow.js and confirm.js pick one. The helper part needs Linux or macOS (a fake
// confirm window is a script with a shebang).   node host/test/confirm-lang-smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ciz-conflang-'));
process.env.LOCALAPPDATA = tmp;
process.env.CLAUDE_IN_ZEN_TEST = '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const failed = []; let passed = 0, helper = null, helperRan = false;
const check = (name, cond, extra) => { if (cond) passed++; else failed.push(name + (extra ? '  ' + extra : '')); };

// 1. the texts themselves
let T;
try { T = require('../lib/confirmtexts'); } catch (e) { check('host/lib/confirmtexts.js loads', false, e.message); }
if (T) {
  const keys = l => Object.keys(T.texts[l] || {});
  check('confirmtexts has English and Portuguese, with the same keys', keys('en').length > 8 && keys('en').join() === keys('pt_BR').join(), keys('en').filter(k => !(k in T.texts.pt_BR)).join(' '));
  const places = s => (String(s).match(/\$[1-9]/g) || []).sort().join();
  check('each text has the same $1..$9 places in both languages', keys('en').every(k => places(T.texts.en[k]) === places(T.texts.pt_BR[k])));
  check('no Portuguese text is a copy of the English (but a name like "OK" may)', keys('en').filter(k => T.texts.en[k] === T.texts.pt_BR[k]).length === 0, keys('en').filter(k => T.texts.en[k] === T.texts.pt_BR[k]).join(' '));
  check('q(): a question carries both languages and pick() chooses', (() => {
    const q = T.q('trusted'); return q.title.en === T.texts.en['trusted.title'] && q.title.pt_BR === T.texts.pt_BR['trusted.title'] && T.pick(q.title, 'pt_BR') === q.title.pt_BR && T.pick(q.title, 'en') === q.title.en;
  })());
  check('pick() of a plain string returns it; an unknown language is English', T.pick('plain', 'pt_BR') === 'plain' && T.pick(T.q('trusted').text, 'fr') === T.texts.en['trusted.text']);
  check('q() fills $1.. with the details, once per language, without reading $ in a detail as a pattern', (() => {
    const q = T.q('files.read', 'C:\\a$&b'); return q.text.en.includes('C:\\a$&b') && q.text.pt_BR.includes('C:\\a$&b');
  })());
  check('normalLang: pt_BR and pt-BR are Portuguese, everything else English', T.normalLang('pt_BR') === 'pt_BR' && T.normalLang('pt-BR') === 'pt_BR' && T.normalLang('en') === 'en' && T.normalLang(undefined) === 'en' && T.normalLang('xx') === 'en');
}

async function helperTests() {
  if (process.platform === 'win32') return;
  helperRan = true;
  const confirmLog = path.join(tmp, 'confirm.log');
  const fakeConfirm = path.join(tmp, 'confirm');
  fs.writeFileSync(fakeConfirm, `#!${process.execPath}\nconst fs = require('fs');\nconst e = process.env;\nfs.appendFileSync(${JSON.stringify(confirmLog)}, JSON.stringify({ title: e.CIZ_Q_TITLE, text: e.CIZ_Q_TEXT, yes: e.CIZ_Q_YES, no: e.CIZ_Q_NO }) + '\\n');\nprocess.stdout.write('yes');\n`, { mode: 0o755 });
  const questions = () => { try { return fs.readFileSync(confirmLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const env = { ...process.env, LOCALAPPDATA: tmp, CLAUDE_IN_ZEN_PIPE: path.join(tmp, 'helper.sock'), CLAUDE_IN_ZEN_TEST: '1', CLAUDE_IN_ZEN_CONFIRM: fakeConfirm };
  delete env.ANTHROPIC_API_KEY;
  helper = spawn(process.execPath, [path.join(__dirname, '..', 'claude-in-zen-host.js')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  helper.stdin.on('error', () => {});
  const inbox = [], waiters = [];
  let hbuf = Buffer.alloc(0);
  helper.stdout.on('data', chunk => {
    hbuf = Buffer.concat([hbuf, chunk]);
    while (hbuf.length >= 4 && hbuf.length >= 4 + hbuf.readUInt32LE(0)) {
      const len = hbuf.readUInt32LE(0);
      const msg = JSON.parse(hbuf.subarray(4, 4 + len).toString());
      hbuf = hbuf.subarray(4 + len);
      inbox.push(msg);
      for (const w of waiters.splice(0)) if (!w(msg)) waiters.push(w);
    }
  });
  const toHelper = msg => {
    const body = Buffer.from(JSON.stringify(msg)), head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    helper.stdin.write(Buffer.concat([head, body]));
  };
  const expect = (pred, ms = 6000) => new Promise(resolve => {
    const hit = inbox.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => resolve(undefined), ms);
    waiters.push(m => { if (!pred(m)) return false; clearTimeout(timer); resolve(m); return true; });
  });
  let seq = 0;
  // Ask one question and give the window that showed.
  const ask = async (msg) => {
    const n = questions().length, id = `q${++seq}`;
    toHelper({ type: 'confirm', id, ...msg });
    const res = await expect(m => m.type === 'confirm_result' && m.id === id);
    return { res, win: questions().slice(n).pop() };
  };
  // A folder the helper has not allowed yet asks again (an allowed one is answered without a window).
  const folder = path.join(tmp, 'docs'), folder2 = path.join(tmp, 'docs2'); fs.mkdirSync(folder); fs.mkdirSync(folder2);
  // The files windows come first: once Automatic or Unsafe mode is on, the helper answers a folder question by itself.
  const kindsFor = f => [
    ['files (read)', { kind: 'files', mode: 'read', folder: f }], ['files (write)', { kind: 'files', mode: 'write', folder: f }],
    ['unsafe', { kind: 'unsafe' }], ['trusted', { kind: 'trusted' }],
  ];
  const T2 = T;

  await sleep(800);
  toHelper({ type: 'hello', version: 'conflang', lang: 'pt_BR' });
  await expect(m => m.type === 'confirmed_state');
  const pt = {};
  for (const [name, msg] of kindsFor(folder)) {
    const { res, win } = await ask(msg);
    pt[name] = win;
    check(`hello lang pt_BR: the ${name} window is in Portuguese`, !!win && !!res && res.ok === true && /^(Ativar|Permitir leitura|Permitir leitura e escrita)$/.test(win.yes) && win.no === 'Cancelar' && /Claude/.test(win.title), JSON.stringify(win));
  }
  check('Unsafe, Trusted and files windows have different Portuguese texts', new Set(Object.values(pt).map(w => w && w.text)).size === 4);
  check('the Portuguese file window names the folder', !!pt['files (read)'] && pt['files (read)'].text.includes(folder));
  if (T2) check('the Portuguese Unsafe window is exactly the Portuguese text', pt.unsafe && pt.unsafe.text === T2.texts.pt_BR['unsafe.text'] && pt.unsafe.title === T2.texts.pt_BR['unsafe.title']);

  toHelper({ type: 'unsafe_off' }); toHelper({ type: 'trusted_off' });   // so the files windows ask again
  toHelper({ type: 'lang', lang: 'en' });
  const en = {};
  for (const [name, msg] of kindsFor(folder2)) {
    const { win } = await ask(msg);
    en[name] = win;
    check(`after {type:'lang', lang:'en'}: the ${name} window is in English`, !!win && /^(Turn on|Allow reading|Allow read and write)$/.test(win.yes) && win.no === 'Cancel' && /Claude in Zen/.test(win.title), JSON.stringify(win));
  }
  const AUTO_EN = 'Claude then answers Yes by itself to these questions: saving a picture, using another site, sending a form or following a link to another site after reading a page, uploading a file, filling a form, and allowing a folder for file tools or local pages.\n\nGoogle sign-in and account pages, sites you blocked and protected folders stay off-limits. It still never types passwords, 2FA codes or payment details. Pages can try to steer it.\n\nIt stays on until you press Stop.';
  const AUTO_PT = 'O Claude passa a responder Sim sozinho a estas perguntas: salvar uma imagem, usar outro site, enviar um formulário ou seguir um link para outro site depois de ler uma página, enviar um arquivo, preencher um formulário e permitir uma pasta para as ferramentas de arquivos ou as páginas locais.\n\nAs páginas de login e de conta do Google, os sites que você bloqueou e as pastas protegidas continuam fora do alcance. Ele continua sem digitar senhas, códigos 2FA ou dados de pagamento. As páginas podem tentar influenciá-lo.\n\nO modo fica ativo até você apertar Parar.';
  check('the English Automatic window: its title and what it answers and keeps', en.trusted && en.trusted.title === 'Claude in Zen: turn on Automatic mode?' && en.trusted.text === AUTO_EN, JSON.stringify(en.trusted));
  check('the Portuguese Automatic window: its title and what it answers and keeps', pt.trusted && pt.trusted.title === 'Claude in Zen: ativar o modo automático?' && pt.trusted.text === AUTO_PT, JSON.stringify(pt.trusted));
  check('the Unsafe window says it includes Automatic mode, in English and Portuguese', en.unsafe && /Unsafe mode includes Automatic mode/.test(en.unsafe.text) && pt.unsafe && /O modo Inseguro inclui o modo automático/.test(pt.unsafe.text));
  check('no window text says Trusted or Confiável', !T || !Object.values(T.texts.en).some(v => /Trusted/.test(v)) && !Object.values(T.texts.pt_BR).some(v => /Confiável/.test(v)));

  toHelper({ type: 'lang', lang: 'pt_BR' });
  check('{type:"lang", lang:"pt_BR"} switches back', (await ask({ kind: 'trusted' })).win.yes === 'Ativar');
  toHelper({ type: 'hello', version: 'conflang', lang: 'en' });
  await sleep(100);
  check('a new hello with lang en switches to English', (await ask({ kind: 'trusted' })).win.yes === 'Turn on');
  toHelper({ type: 'lang', lang: 'fr' });
  check('a language the helper does not know is English', (await ask({ kind: 'trusted' })).win.yes === 'Turn on');
  toHelper({ type: 'lang', lang: 'pt_BR' });
  toHelper({ type: 'hello', version: 'conflang' });
  await sleep(100);
  check('a hello without lang means English', (await ask({ kind: 'trusted' })).win.yes === 'Turn on');
}

(async () => {
  try {
    await helperTests();
  } catch (e) {
    check('confirm-lang-smoke ran to the end', false, e.stack || e.message);
  } finally {
    if (helper) helper.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failed.length) {
    for (const f of failed) console.log(`FAIL  ${f}`);
    console.log(`${failed.length} check(s) failed`);
    process.exit(1);
  }
  console.log(`confirm-lang-smoke: ${passed} checks passed${helperRan ? '' : ' (helper part skipped on Windows)'}`);
  process.exit(0);
})();
