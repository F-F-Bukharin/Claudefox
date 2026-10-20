'use strict';
// The plain parts of native video watching (extension/lib/watchCore.js): times, the frame clock, dropping near-duplicate
// frames, sheets, captions and the track choice.   node test/watch-native.js
const W = require('../extension/lib/watchCore');

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${extra !== undefined ? '  ' + extra : ''}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- times
check('seconds parse', W.parseClock('90') === 90 && W.parseClock('90.5') === 90.5 && W.parseClock(' 12 ') === 12);
check('clock times parse', W.parseClock('1:30') === 90 && W.parseClock('1:02:03') === 3723 && W.parseClock('1:30.25') === 90.25);
check('minutes past 59 are fine without hours', W.parseClock('90:00') === 5400);
check('bad times are refused', [null, '', 'abc', '1:3', '1:60', '1:75:00', '-5', '1:30:', '1e3'].every(x => W.parseClock(x) === null));
check('clock text', W.clock(0) === '0:00' && W.clock(65.9) === '1:05' && W.clock(3723) === '1:02:03', W.clock(65.9));
check('fine clock text has two decimals', W.clock(761.25, true) === '12:41.25' && W.clock(5.5, true) === '0:05.50' && W.clock(3600.25, true) === '1:00:00.25',
  [W.clock(761.25, true), W.clock(5.5, true), W.clock(3600.25, true)].join(' '));

// ---- the frame clock
{
  const s = W.sampler(0, 5, 1);
  const got = [];
  for (let t = 0; t < 6; t += 1 / 30) if (s.want(t)) got.push(Math.round(t * 30));   // frame numbers at 30 fps
  check('1 fps on a 30 fps video takes frames 0, 30, 60, 90, 120 and stops before 5 s', same(got, [0, 30, 60, 90, 120]), got.join(','));
  check('the clock is done at the end', s.done(5) && !W.sampler(0, 5, 1).done(4.9));
}
{
  const s = W.sampler(10, 12, 0.25);
  const got = [];
  for (let t = 10; t < 12.5; t += 1 / 24) if (s.want(t)) got.push(+t.toFixed(3));
  check('4 fps over 2 s gives 8 frames, each the first at or after its step', got.length === 8 && got[0] === 10 && got.every((t, i) => t >= 10 + i * 0.25 - 1e-3 && t < 10 + i * 0.25 + 1 / 24 + 1e-3), got.join(','));
}
{
  const s = W.sampler(0, 60, 1);
  const got = [0, 0.5, 1.0, 7.2, 7.5, 8.01].filter(t => s.want(t));
  check('a jump skips the steps it passed and never invents frames', same(got, [0, 1, 7.2, 8.01]) && s.next() === 9, got.join(',') + ' next ' + s.next());
  check('times before the start are not taken', !W.sampler(5, 10, 1).want(4.5));
}

// ---- dropping near-duplicates
{
  const flat = v => new Array(144).fill(v);
  const withSpot = (v, cells, d) => flat(v).map((x, i) => (i < cells ? x + d : x));
  check('no change: a mean of 0 and no cells', same(W.diff(flat(100), flat(100)), { mean: 0, cells: 0 }));
  check('a small region change counts its cells', W.diff(flat(100), withSpot(100, 6, 40)).cells === 6);
  const frames = [];
  for (let t = 0; t < 30; t++) frames.push({ t, gray: t < 12 ? flat(100) : t < 20 ? withSpot(100, 10, 60) : flat(30) });
  const kept = W.keep(frames).map(i => frames[i].t);
  check('a still stretch keeps its first frame and a heartbeat every 10 s', kept.includes(0) && kept.includes(10) && !kept.includes(1) && !kept.includes(5), kept.join(','));
  check('a slide change (a few cells) and a scene change are both kept', kept.includes(12) && kept.includes(20), kept.join(','));
  check('compression noise (mean 1, no cells) is dropped', W.keep([{ t: 0, gray: flat(100) }, { t: 1, gray: flat(101) }]).length === 1);
  check('every frame of a busy video is kept', W.keep(frames.map((f, i) => ({ t: i, gray: flat((i * 37) % 255) }))).length === 30);
}

// ---- sheets
{
  const frames = Array.from({ length: 45 }, (_, i) => ({ t: i * 2 }));
  const sheets = W.sheets(frames, 1);
  check('45 frames make sheets of 20, 20 and 5', same(sheets.map(s => s.frames.length), [20, 20, 5]));
  check('rows have 5 frames and span to the next row', sheets[0].rows.length === 4 && sheets[0].rows[0].frames.length === 5
    && sheets[0].rows[0].t0 === 0 && sheets[0].rows[0].t1 === 10, JSON.stringify(sheets[0].rows[0].t1));
  check('the last row of a sheet spans to the next sheet\'s first frame', sheets[0].rows[3].t1 === 40 && sheets[0].t1 === 40);
  check('the very last row spans to its last frame plus one step', sheets[2].rows.length === 1 && sheets[2].rows[0].t1 === 89, sheets[2].rows[0].t1);
  check('sheets are numbered from 1', same(sheets.map(s => s.n), [1, 2, 3]));
  check('no frames, no sheets', W.sheets([], 1).length === 0);
}

// ---- captions
{
  const cues = W.cleanCues([
    { start: 3, end: 5, text: ' second  line ' }, { start: 0, end: 2, text: 'first line' }, { start: 2, end: 3, text: '' },
    { start: 5, end: 6, text: 'second line' }, { start: 6, end: 8, text: 'line and more words' }, { start: 8, end: 9, text: 'and more words' },
  ]);
  check('cues come out in time order, squashed, without empties', cues[0].text === 'first line' && cues[1].text === 'second line', JSON.stringify(cues));
  check('a repeated cue extends the last one', cues[1].end === 6);
  check('a rolling caption keeps only its new words', cues[2].text === 'and more words', JSON.stringify(cues));
  check('a roll with nothing new adds nothing', cues.length === 3 && cues[2].end === 9, JSON.stringify(cues));
  check('what was said in a span', W.said(cues, 2.5, 5.5) === 'second line' && W.said(cues, 0, 10) === 'first line second line and more words');
  check('rolling words: the overlap is cut, case-insensitive', W.roll('we went to the', 'To The shop today') === 'shop today' && W.roll('', 'a b') === 'a b' && W.roll('x y', 'a b') === 'a b');

  const lines = W.captionLines(W.cleanCues([{ start: 0, end: 2, text: 'a' }, { start: 4, end: 5, text: 'b' }, { start: 11, end: 12, text: 'c' }, { start: 65, end: 66, text: 'd' }]));
  check('caption lines merge about 10 s each, with clock times', lines.text === '[0:00] a b\n[0:11] c\n[1:05] d\n' && lines.lines === 3, JSON.stringify(lines.text));
  const span = W.captionLines(W.cleanCues([{ start: 0, end: 2, text: 'a' }, { start: 20, end: 22, text: 'b' }, { start: 40, end: 41, text: 'c' }]), { t0: 15, t1: 30 });
  check('caption lines can be limited to a span', span.text === '[0:20] b\n', JSON.stringify(span.text));
  const long = W.captionLines(Array.from({ length: 500 }, (_, i) => ({ start: i * 11, end: i * 11 + 1, text: 'word '.repeat(20) })), { maxChars: 2000 });
  check('long captions are cut with a note', long.cut && long.text.length < 2200 && /captions cut at 2k characters/.test(long.text));

  const j3 = W.json3({ events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Hello ' }, { utf8: 'there' }] }, { tStartMs: 1500, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 1600 }, { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '  ' }] }, { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'world' }] }] });
  check('json3: segments joined, appends and empty events skipped, times in seconds', same(j3, [{ start: 0, end: 1.5, text: 'Hello there' }, { start: 3, end: 4, text: 'world' }]), JSON.stringify(j3));
  check('json3: nothing usable gives no cues', W.json3(null).length === 0 && W.json3({}).length === 0);

  const seen = W.seenCues([{ t: 0, text: 'a' }, { t: 1, text: 'a' }, { t: 2, text: '' }, { t: 3, text: 'b' }, { t: 4, text: 'b' }, { t: 9, text: 'b' }], 1);
  check('captions seen on screen become cues, a gap starts a new one', same(seen, [{ start: 0, end: 2, text: 'a' }, { start: 3, end: 5, text: 'b' }, { start: 9, end: 10, text: 'b' }]), JSON.stringify(seen));
}

// ---- the track choice
{
  const tracks = [{ lang: 'en', auto: true }, { lang: 'pt-BR', auto: false }, { lang: 'en', auto: false, isDefault: true }, { lang: 'es', auto: false }];
  check('no language asked: the default manual track', same(W.pickTrack(tracks, ''), { index: 2, translate: '' }));
  check('an exact language match wins', same(W.pickTrack(tracks, 'pt-BR'), { index: 1, translate: '' }));
  check('pt matches pt-BR', same(W.pickTrack(tracks, 'pt'), { index: 1, translate: '' }));
  check('a manual track beats an auto-generated one in the same language', same(W.pickTrack(tracks, 'en'), { index: 2, translate: '' }));
  check('only an auto-generated track in the language: it is used', same(W.pickTrack([{ lang: 'fr', auto: false }, { lang: 'de', auto: true }], 'de'), { index: 1, translate: '' }));
  check('a missing language is translated when the site can', same(W.pickTrack(tracks, 'ja', true), { index: 2, translate: 'ja' }));
  check('a missing language without translation falls back to the default', same(W.pickTrack(tracks, 'ja', false), { index: 2, translate: '' }));
  check('no tracks: null', W.pickTrack([], 'en') === null && W.pickTrack(null) === null);
  check('no default manual track: the first manual one', same(W.pickTrack([{ lang: 'en', auto: true }, { lang: 'fr', auto: false }], ''), { index: 1, translate: '' }));
}

// ---- the numbers the plan promises
check('the budget numbers are the plan\'s', W.CFX_WATCH.BASE_STEP === 1 && W.CFX_WATCH.ZOOM_STEP === 0.25 && W.CFX_WATCH.ZOOM_MAX_SPAN === 30
  && W.CFX_WATCH.ZOOM_MAX === 10 && W.CFX_WATCH.COLS * W.CFX_WATCH.ROWS === 20 && W.CFX_WATCH.CELL_W === 320 && W.CFX_WATCH.CELL_H === 180);

console.log(`${pass} checks passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
