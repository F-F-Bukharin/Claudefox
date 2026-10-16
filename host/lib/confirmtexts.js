'use strict';
// The helper's confirm windows in two languages (E11). The add-on tells the helper its language in hello (lang) and in
// { type: 'lang', lang } when Settings > Language changes it; the helper keeps it here. A question carries both texts
// (q() gives { title, text, yes, no }, each { en, pt_BR }) and confirm.js shows the one in the language at that moment.
// Keys are <question>.<part>; $1..$9 are filled by q() with the details (a folder, a name, a command).

const texts = {
  en: {
    'unsafe.title': 'Claude in Zen: turn on Unsafe mode?',
    'unsafe.text': 'Claude may then act on Google sign-in and account pages like on any other site, to debug sign-in problems. Unsafe mode includes Automatic mode: Claude also answers Yes by itself to the questions about saving a picture, using another site, sending a form, following a link to another site, uploading a file, filling a form and allowing a folder. Sites you blocked and protected folders stay off-limits. It still never types passwords, 2FA codes or payment details.\n\nUnsafe mode turns off when you press Stop or restart Zen.',
    'unsafe.yes': 'Turn on', 'unsafe.no': 'Cancel',
    'trusted.title': 'Claude in Zen: turn on Automatic mode?',
    'trusted.text': 'Claude then answers Yes by itself to these questions: saving a picture, using another site, sending a form or following a link to another site after reading a page, uploading a file, filling a form, and allowing a folder for file tools or local pages.\n\nGoogle sign-in and account pages, sites you blocked and protected folders stay off-limits. It still never types passwords, 2FA codes or payment details. Pages can try to steer it.\n\nIt stays on until you press Stop.',
    'trusted.yes': 'Turn on', 'trusted.no': 'Cancel',
    'files.read.title': 'Claude in Zen: turn on file tools?',
    'files.read.text': 'Let Claude read and search the files in this folder and its subfolders?\n\n$1\n\nNo changes, no shell.',
    'files.read.yes': 'Allow reading', 'files.read.no': 'Cancel',
    'files.write.title': 'Claude in Zen: turn on file tools?',
    'files.write.text': 'Let Claude read, create, change and delete files in this folder and its subfolders?\n\n$1\n\nThere is no undo. Claude never gets a shell.',
    'files.write.yes': 'Allow read and write', 'files.write.no': 'Cancel',
    'watch.title': 'Claude in Zen: let Claude watch videos for this session?',
    'watch.text': 'It runs Python, yt-dlp and ffmpeg on this PC.',
    'watch.yes': 'Turn on', 'watch.no': 'Cancel',
    'watchOnLoad.title': 'Claude in Zen: let Claude watch videos every time the panel opens?',
    'watchOnLoad.text': 'It runs Python, yt-dlp and ffmpeg on this PC.',
    'watchOnLoad.yes': 'Turn on', 'watchOnLoad.no': 'Keep off',
    'folder.title': 'Claude in Zen: allow a folder?',
    'folder.text': 'Claude asks to look in this folder and its subfolders:\n\n$1\n\nClaude was reading: $2\n\nIt may then open, list and read the files there, until you remove the folder in Claude in Zen\'s Profile, Permissions. Army workers never look there.',
    'folder.noPage': 'no page',
    'folder.yes': 'Allow this folder', 'folder.no': 'Deny',
    'runs.title': 'Claude in Zen: switch on something that runs programs?',
    'runs.text': 'Switch on $1? Every chat with it on runs this on your PC, with your permissions:\n\n$2\n\nA web page could try to trick Claude into using it. Only switch on what you trust.',
    'runs.yes': 'Switch on', 'runs.no': 'Cancel',
    'mcpRemote.title': 'Claude in Zen: add a tool server?',
    'mcpRemote.text': 'Add the tool server $1 at $2? When Claude uses it, what it reads from pages can go to that server.',
    'mcpRemote.yes': 'Add tool', 'mcpRemote.no': 'Cancel',
    'mcpLocal.title': 'Claude in Zen: add a tool that runs a program?',
    'mcpLocal.text': 'Add the tool "$1"? Every chat with it switched on runs this on your PC, one argument per line:\n\n$2\n\nOnly add tools you trust.',
    'mcpLocal.yes': 'Add tool', 'mcpLocal.no': 'Cancel',
    'install.title': 'Claude in Zen: install a plugin?',
    'install.text': 'Install the plugin "$1"?\n\nPlugins can run programs on your PC (hooks and tool servers). Only install plugins you trust.',
    'install.yes': 'Install', 'install.no': 'Cancel',
    'installFrom.title': 'Claude in Zen: install a plugin?',
    'installFrom.text': 'Install the plugin "$1" from $2?\n\nPlugins can run programs on your PC (hooks and tool servers). Only install plugins you trust.',
    'installFrom.yes': 'Install', 'installFrom.no': 'Cancel',
  },
  pt_BR: {
    'unsafe.title': 'Claude in Zen: ativar o modo Inseguro?',
    'unsafe.text': 'O Claude poderá então agir em páginas de login e de conta do Google como em qualquer outro site, para depurar problemas de login. O modo Inseguro inclui o modo automático: o Claude também responde Sim sozinho às perguntas sobre salvar uma imagem, usar outro site, enviar um formulário, seguir um link para outro site, enviar um arquivo, preencher um formulário e permitir uma pasta. Os sites que você bloqueou e as pastas protegidas continuam fora do alcance. Ele continua sem digitar senhas, códigos 2FA ou dados de pagamento.\n\nO modo Inseguro desliga quando você aperta Parar ou reinicia o Zen.',
    'unsafe.yes': 'Ativar', 'unsafe.no': 'Cancelar',
    'trusted.title': 'Claude in Zen: ativar o modo automático?',
    'trusted.text': 'O Claude passa a responder Sim sozinho a estas perguntas: salvar uma imagem, usar outro site, enviar um formulário ou seguir um link para outro site depois de ler uma página, enviar um arquivo, preencher um formulário e permitir uma pasta para as ferramentas de arquivos ou as páginas locais.\n\nAs páginas de login e de conta do Google, os sites que você bloqueou e as pastas protegidas continuam fora do alcance. Ele continua sem digitar senhas, códigos 2FA ou dados de pagamento. As páginas podem tentar influenciá-lo.\n\nO modo fica ativo até você apertar Parar.',
    'trusted.yes': 'Ativar', 'trusted.no': 'Cancelar',
    'files.read.title': 'Claude in Zen: ativar as ferramentas de arquivos?',
    'files.read.text': 'Permitir que o Claude leia e pesquise os arquivos desta pasta e das subpastas?\n\n$1\n\nSem alterações, sem shell.',
    'files.read.yes': 'Permitir leitura', 'files.read.no': 'Cancelar',
    'files.write.title': 'Claude in Zen: ativar as ferramentas de arquivos?',
    'files.write.text': 'Permitir que o Claude leia, crie, altere e apague arquivos desta pasta e das subpastas?\n\n$1\n\nNão há como desfazer. O Claude nunca recebe um shell.',
    'files.write.yes': 'Permitir leitura e escrita', 'files.write.no': 'Cancelar',
    'watch.title': 'Claude in Zen: deixar o Claude assistir a vídeos nesta sessão?',
    'watch.text': 'Isso executa Python, yt-dlp e ffmpeg neste PC.',
    'watch.yes': 'Ativar', 'watch.no': 'Cancelar',
    'watchOnLoad.title': 'Claude in Zen: deixar o Claude assistir a vídeos toda vez que o painel abrir?',
    'watchOnLoad.text': 'Isso executa Python, yt-dlp e ffmpeg neste PC.',
    'watchOnLoad.yes': 'Ativar', 'watchOnLoad.no': 'Manter desativado',
    'folder.title': 'Claude in Zen: permitir uma pasta?',
    'folder.text': 'O Claude pede para olhar nesta pasta e nas subpastas:\n\n$1\n\nO Claude estava lendo: $2\n\nEle poderá então abrir, listar e ler os arquivos de lá, até você remover a pasta em Perfil, Permissões, no Claude in Zen. Os agentes do exército nunca olham lá.',
    'folder.noPage': 'nenhuma página',
    'folder.yes': 'Permitir esta pasta', 'folder.no': 'Negar',
    'runs.title': 'Claude in Zen: ativar algo que executa programas?',
    'runs.text': 'Ativar $1? Todo chat com isso ativado executa o seguinte no seu PC, com as suas permissões:\n\n$2\n\nUma página da web pode tentar enganar o Claude para que ele use isso. Ative só o que você considera confiável.',
    'runs.yes': 'Ativar', 'runs.no': 'Cancelar',
    'mcpRemote.title': 'Claude in Zen: adicionar um servidor de ferramentas?',
    'mcpRemote.text': 'Adicionar o servidor de ferramentas $1 em $2? Quando o Claude o usar, o que ele lê das páginas pode ir para esse servidor.',
    'mcpRemote.yes': 'Adicionar ferramenta', 'mcpRemote.no': 'Cancelar',
    'mcpLocal.title': 'Claude in Zen: adicionar uma ferramenta que executa um programa?',
    'mcpLocal.text': 'Adicionar a ferramenta "$1"? Todo chat com ela ativada executa o seguinte no seu PC, um argumento por linha:\n\n$2\n\nAdicione só ferramentas em que você confia.',
    'mcpLocal.yes': 'Adicionar ferramenta', 'mcpLocal.no': 'Cancelar',
    'install.title': 'Claude in Zen: instalar um plugin?',
    'install.text': 'Instalar o plugin "$1"?\n\nPlugins podem executar programas no seu PC (hooks e servidores de ferramentas). Instale só plugins em que você confia.',
    'install.yes': 'Instalar', 'install.no': 'Cancelar',
    'installFrom.title': 'Claude in Zen: instalar um plugin?',
    'installFrom.text': 'Instalar o plugin "$1" de $2?\n\nPlugins podem executar programas no seu PC (hooks e servidores de ferramentas). Instale só plugins em que você confia.',
    'installFrom.yes': 'Instalar', 'installFrom.no': 'Cancelar',
  },
};

let current = 'en';
const normalLang = v => (/^pt([-_]|$)/i.test(String(v || '')) ? 'pt_BR' : 'en');
function setLang(v) { current = normalLang(v); }
const getLang = () => current;

const fill = (s, subs) => s.replace(/\$([1-9])/g, (_, n) => (subs[n - 1] === undefined ? '' : String(subs[n - 1])));
// A sub may itself be { en, pt_BR } (both() gives one), for a word inside a text.
const both = key => ({ en: texts.en[key], pt_BR: texts.pt_BR[key] });
function text(lang, key, subs) { return fill(texts[lang][key], subs.map(s => (s && typeof s === 'object' ? s[lang] : s))); }
// The question <name>: { title, text, yes, no }, each { en, pt_BR }, with the details filled in.
function q(name, ...subs) {
  const part = p => ({ en: text('en', `${name}.${p}`, subs), pt_BR: text('pt_BR', `${name}.${p}`, subs) });
  return { title: part('title'), text: part('text'), yes: part('yes'), no: part('no') };
}
// The same question already in the language of the moment, as plain strings (for code that hands a question to an injected confirm).
function now(name, ...subs) {
  const lang = current, w = q(name, ...subs);
  return { title: w.title[lang], text: w.text[lang], yes: w.yes[lang], no: w.no[lang] };
}
// A plain string stays as it is; { en, pt_BR } gives the language asked for (English for any other).
function pick(v, lang) {
  if (v && typeof v === 'object') return v[normalLang(lang)] !== undefined ? v[normalLang(lang)] : v.en;
  return v;
}

module.exports = { texts, q, now, both, pick, normalLang, setLang, getLang };
