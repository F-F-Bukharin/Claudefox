'use strict';
// The download_image permission card (host/lib/downloadgate.js) on short real timers, and the folder rule for a picture
// (pictureFolder). Yes runs the download; a No, a card no panel shows and a card with no answer are all refused.
//   node host/test/downloadgate-smoke.js

const path = require('path');

let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) passed++; else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
// A section that throws (a missing module, say) is one FAIL, and the sections after it still run.
const run = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message || e).split('\n')[0]); } };
const NOT_ALLOWED = 'Claude can save pictures only to the pictures folder or a folder you allowed.';
const INFO = { host: 'example.com', name: 'cat.gif', folder: '/home/u/Art' };

// A gate with its cards recorded; the waits are short.
function rig(over = {}) {
  const { createDownloadGate } = require('../lib/downloadgate');
  const r = { shows: [], hides: [] };
  r.gate = createDownloadGate({ showCard: (id, info) => r.shows.push({ id, info }), hideCard: id => r.hides.push(id),
    panelWaitMs: 40, cardTimeoutMs: 80, ...over });
  r.last = () => r.shows[r.shows.length - 1].id;
  return r;
}

async function gateSection() {
  const texts = require('../lib/downloadgate');
  check('gate: the three texts are the brief\'s',
    texts.NO_PANEL === 'Open the Claude panel to answer whether Claude may save this picture.'
    && texts.DENIED === 'The user did not allow saving this picture.'
    && texts.BUSY === 'The user is already answering about another picture. Try again after that answer.');

  await run('gate: Yes after the card is shown gives ok and takes the card down', async () => {
    const r = rig();
    const p = r.gate.ask(INFO);
    check('gate: the card shows the picture once, with its host, name and folder',
      r.shows.length === 1 && r.shows[0].info.host === 'example.com' && r.shows[0].info.name === 'cat.gif' && r.shows[0].info.folder === '/home/u/Art');
    r.gate.shown(r.last());
    r.gate.answer(r.last(), true);
    const res = await p;
    check('gate: Yes gives ok', res.ok === true, JSON.stringify(res));
    check('gate: the card is taken down after the answer', r.hides.length === 1 && r.hides[0] === '1');
  });

  await run('gate: No after the card is shown gives the denial', async () => {
    const r = rig();
    const p = r.gate.ask(INFO);
    r.gate.shown(r.last());
    r.gate.answer(r.last(), false);
    const res = await p;
    check('gate: No gives the denial text', res.ok === false && res.message === texts.DENIED, JSON.stringify(res));
  });

  await run('gate: a No before the card is shown is honoured at once', async () => {
    const r = rig({ panelWaitMs: 500 });
    const p = r.gate.ask(INFO);
    r.gate.answer(r.last(), false);
    const res = await p;
    check('gate: an early No gives the denial, not the panel wait', res.message === texts.DENIED, JSON.stringify(res));
  });

  await run('gate: a Yes before the card is shown does not count', async () => {
    const r = rig();
    const p = r.gate.ask(INFO);
    r.gate.answer(r.last(), true);
    const res = await p;
    check('gate: an early Yes is ignored, so the wait ends with the panel text', res.ok === false && res.message === texts.NO_PANEL, JSON.stringify(res));
  });

  await run('gate: no panel within the wait gives the panel text', async () => {
    const r = rig();
    const res = await r.gate.ask(INFO);
    check('gate: no panel gives the panel text', res.ok === false && res.message === texts.NO_PANEL, JSON.stringify(res));
    check('gate: the card that no panel showed is taken down', r.hides.length === 1);
  });

  await run('gate: no answer after the card is shown counts as No', async () => {
    const r = rig();
    const p = r.gate.ask(INFO);
    r.gate.shown(r.last());
    const res = await p;
    check('gate: no answer gives the denial', res.ok === false && res.message === texts.DENIED, JSON.stringify(res));
  });

  await run('gate: a second ask while a card is open is refused and shows nothing', async () => {
    const r = rig();
    const p = r.gate.ask(INFO);
    const busy = await r.gate.ask({ host: 'b.example', name: 'x.png', folder: '/home/u/Art' });
    check('gate: the busy text', busy.ok === false && busy.message === 'The user is already answering about another picture. Try again after that answer.', JSON.stringify(busy));
    check('gate: the second ask shows no card', r.shows.length === 1);
    r.gate.cancel();
    check('gate: cancel gives the open card the denial', (await p).message === texts.DENIED);
  });

  await run('gate: cancel after the card is shown ends it, and the next ask shows a card (no cooldown)', async () => {
    const r = rig({ cardTimeoutMs: 1000 });
    const p = r.gate.ask(INFO);
    r.gate.shown(r.last());
    r.gate.cancel();
    const res = await p;
    check('gate: cancel gives the denial and hides the card', res.message === texts.DENIED && r.hides.length === 1, JSON.stringify(res));
    const again = r.gate.ask(INFO);
    check('gate: the next ask shows a card at once', r.shows.length === 2);
    r.gate.cancel();
    await again;
  });

  await run('gate: a wrong id is ignored', async () => {
    const r = rig({ cardTimeoutMs: 1000 });
    const p = r.gate.ask(INFO);
    r.gate.shown('999');
    r.gate.answer('999', true);
    r.gate.shown(r.last());
    r.gate.answer(r.last(), true);
    const res = await p;
    check('gate: only the open card\'s id counts', res.ok === true, JSON.stringify(res));
  });
}

async function folderSection() {
  const { pictureFolder } = require('../lib/downloadgate');
  const ctx = { outputDir: path.join('/data', 'out'), allowed: [path.resolve('/home/u/Art')], folderProblem: () => '' };
  check('folder: no folder goes to the pictures folder of the output folder', pictureFolder({}, ctx).folder === path.join('/data', 'out', 'pictures'));
  check('folder: an allowed folder is used', pictureFolder({ folder: '/home/u/Art' }, ctx).folder === path.resolve('/home/u/Art'));
  check('folder: a folder the user did not allow is refused', pictureFolder({ folder: '/home/u/Other' }, ctx).error === NOT_ALLOWED);
  check('folder: a relative folder is refused', pictureFolder({ folder: 'Art' }, ctx).error === NOT_ALLOWED);
  const asked = [];
  const guarded = Object.assign({}, ctx, { folderProblem: (f, mode) => { asked.push([f, mode]); return "it holds Claude in Zen's own code"; } });
  check('folder: a folder the guard refuses is refused', pictureFolder({ folder: '/home/u/Art' }, guarded).error === NOT_ALLOWED);
  check('folder: the guard is asked about it for writing', asked.length === 1 && asked[0][0] === path.resolve('/home/u/Art') && asked[0][1] === 'write', JSON.stringify(asked));
}

(async () => {
  await run('gate section', gateSection);
  await run('folder section', folderSection);
  console.log(failed ? `${failed} failed, ${passed} passed` : `All ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})();
