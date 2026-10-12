'use strict';
// Checks for the site gate (extension/lib/siteGate.js): the site rules, the lists a chat and a message keep, the card that asks,
// its timers and queue, the blocked and trusted cases, workers, risky actions and the tab redaction.
// Plain node + vm; the add-on globals (cizState, browser, setTimeout) are fakes.
//   node test/site-gate.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'siteGate.js'), 'utf8');
let passed = 0, failed = 0;
const check = (name, ok, extra) => { if (ok) { passed++; console.log(`PASS ${name}`); } else { failed++; console.log(`FAIL ${name}${extra ? '  ' + extra : ''}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

// A fresh context per scenario: fake cizState (records set() calls), fake timers (advance(ms) runs the due ones).
function mk() {
  const h = { sets: [], ask: null, now: 0, timers: [], nextTimer: 1 };
  const cizState = { get: () => ({ siteAsk: h.ask }), async set(p) { h.sets.push(p); if ('siteAsk' in p) h.ask = p.siteAsk; } };
  const fakeSetTimeout = (fn, ms) => { const t = { id: h.nextTimer++, at: h.now + ms, fn }; h.timers.push(t); return t.id; };
  const fakeClearTimeout = id => { h.timers = h.timers.filter(t => t.id !== id); };
  const ctx = vm.createContext({ cizState, browser: { storage: { local: { get: async () => ({}) } } }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, console });
  vm.runInContext(src, ctx, { filename: 'siteGate.js' });
  h.g = vm.runInContext('cizSiteGate', ctx);
  h.siteOf = vm.runInContext('cizSiteOf', ctx);
  h.match = vm.runInContext('cizSiteMatch', ctx);
  h.inText = vm.runInContext('cizSitesInText', ctx);
  h.advance = async ms => {
    const end = h.now + ms;
    for (;;) {
      const due = h.timers.filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      h.timers = h.timers.filter(t => t !== due); h.now = due.at; due.fn(); await tick();
    }
    h.now = end; await tick();
  };
  return h;
}
// Tracks a promise: {done, ok, val, err}.
function track(p) { const s = { done: false }; p.then(v => { s.done = true; s.ok = true; s.val = v; }, e => { s.done = true; s.ok = false; s.err = e; }); return s; }
const refusedText = site => `The user did not allow ${site}. Do not try it again in this message.`;
const msgOf = s => (s.err && s.err.message) || '';
const begin = (h, o) => h.g.begin(o.id || 'm1', Object.assign({ tabUrl: 'https://start.com/x', windowId: 7, text: '', newChat: false, allow: [] }, o));

(async () => {
  // 1. Site rules: the shared table.
  {
    const h = mk();
    const sites = [['https://www.YouTube.com/watch?v=1', 'youtube.com'], ['http://m.youtube.com/', 'm.youtube.com'], ['http://127.0.0.1:8080/x', '127.0.0.1'],
      ['http://localhost:3000/', 'localhost'], ['https://[::1]:8443/', '[::1]'], ['file:///C:/x', ''], ['about:blank', ''], ['not a url', ''],
      ['https://youtube.com./a', 'youtube.com'], ['https://user:pw@www.a.com:81/p', 'a.com']];
    for (const [u, want] of sites) check(`siteOf ${u} -> '${want}'`, h.siteOf(u) === want, `got '${h.siteOf(u)}'`);
    const matches = [[['youtube.com'], 'm.youtube.com', true], [['youtube.com'], 'youtube.com', true], [['youtube.com'], 'notyoutube.com', false],
      [['m.youtube.com'], 'youtube.com', false], [['0.1'], '127.0.0.1', false], [['127.0.0.1'], '127.0.0.1', true], [['localhost'], 'localhost', true], [[], 'a.com', false]];
    for (const [l, s, want] of matches) check(`match ${JSON.stringify(l)} ${s} -> ${want}`, h.match(l, s) === want);
  }

  // 2. Sites in text.
  {
    const h = mk();
    check('sitesInText: URL', same(h.inText('open https://www.Example.com/a?b=1 please'), ['example.com']));
    check('sitesInText: bare domain', same(h.inText('go to youtube.com and look'), ['youtube.com']));
    check('sitesInText: .com.br', same(h.inText('veja g1.globo.com.br agora'), ['g1.globo.com.br']));
    check('sitesInText: email excluded', same(h.inText('write to bob@gmail.com or jo.com@x.org'), []));
    check('sitesInText: dedupe, lowercase, no www', same(h.inText('YouTube.com, https://www.youtube.com/x and www.youtube.com'), ['youtube.com']));
    check('sitesInText: URL in parentheses and trailing dot', same(h.inText('(https://a.dev/x) then b.io.'), ['a.dev', 'b.io']));
    check('sitesInText: not a site', same(h.inText('index.js and 1.5 and hello.world'), []));
  }

  // 3. begin / lists.
  {
    const h = mk();
    const r = begin(h, { text: 'see youtube.com', allow: ['docs.dev'] });
    check('begin returns allow + tab + text sites', same(r.slice().sort(), ['docs.dev', 'start.com', 'youtube.com']), JSON.stringify(r));
    check('list() and windowId() after begin', same(h.g.list().slice().sort(), r.slice().sort()) && h.g.windowId() === 7);
    check('windowId() is null without a window', (begin(h, { id: 'm2', windowId: undefined }), h.g.windowId() === null));
  }
  {
    const h = mk();
    begin(h, { id: 'a' });
    const p = track(h.g.use('c.com', 'read', {})); await tick(); h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'chat'); await tick();
    const p2 = track(h.g.use('m.com', 'read', {})); await tick(); h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'message'); await tick();
    check('answers chat and message resolve', p.done && p.ok && p2.done && p2.ok);
    check('both scopes in the list', ['c.com', 'm.com'].every(s => h.g.list().includes(s)));
    h.g.end('a');
    check('end drops message entries, keeps chat entries', h.g.list().includes('c.com') && !h.g.list().includes('m.com') && !h.g.list().includes('start.com'), JSON.stringify(h.g.list()));
    begin(h, { id: 'b' });
    check('chat entries survive the next message', h.g.list().includes('c.com'));
    begin(h, { id: 'c', newChat: true });
    check('newChat clears chat entries', !h.g.list().includes('c.com'));
    begin(h, { id: 'd' }); h.g.end('zzz');
    check('end with another id is ignored', h.g.list().includes('start.com'));
  }

  // 4. use(): list, card, timers, answers.
  {
    const h = mk(); begin(h, { allow: ['ok.com'] });
    const p = track(h.g.use('sub.ok.com', 'read', {})); await tick();
    check('use() in list passes without a card', p.done && p.ok && h.sets.length === 0);
    const p2 = track(h.g.use('start.com', 'act', {})); await tick();
    check('use() on the tab site passes', p2.done && p2.ok);
    const p3 = track(h.g.use('x.com', 'open', { blocks: { 'x.com': 'allow' } })); await tick();
    check('use() with an allow entry in blocks passes', p3.done && p3.ok && h.sets.length === 0);
  }
  {
    const h = mk(); begin(h, {});
    const p = track(h.g.use('x.com', 'read', {})); await tick();
    check('outside the list: siteAsk kind site, still waiting',
      !p.done && h.ask && h.ask.site === 'x.com' && h.ask.action === 'read' && h.ask.kind === 'site' && typeof h.ask.id === 'string');
    check('exports the two durations', h.g.SHOWN_MS === 5000 && h.g.ANSWER_MS === 120000);
    await h.advance(4900);
    check('not refused before 5 s', !p.done);
    await h.advance(200);
    check('no shown in 5 s -> refused text, card cleared', p.done && !p.ok && msgOf(p) === refusedText('x.com') && h.ask === null, msgOf(p));
    const p2 = track(h.g.use('x.com', 'read', {})); await tick();
    check('a timeout is remembered for the message (no new card)', p2.done && !p2.ok && msgOf(p2) === refusedText('x.com'));
  }
  {
    const h = mk(); begin(h, {});
    const p = track(h.g.use('x.com', 'read', {})); await tick();
    h.g.shown(h.ask.id); await h.advance(5000);
    check('shown stops the 5 s timer', !p.done);
    await h.advance(114000);
    check('still waiting at 119 s', !p.done);
    await h.advance(2000);
    check('shown then no answer in 120 s -> refused', p.done && !p.ok && msgOf(p) === refusedText('x.com') && h.ask === null);
  }
  {
    const h = mk(); begin(h, {});
    const p = track(h.g.use('x.com', 'act', {})); await tick();
    check('answer with a wrong id is ignored', (h.g.shown('nope'), h.g.answer('nope', 'message'), !p.done));
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'allow'); await tick();
    check("kind site does not take 'allow'", !p.done && h.ask !== null);
    h.g.answer(h.ask.id, 'deny'); await tick();
    check('deny -> refused text, card cleared', p.done && !p.ok && msgOf(p) === refusedText('x.com') && h.ask === null);
    const n = h.sets.length;
    const p2 = track(h.g.use('x.com', 'read', {})); await tick();
    check('deny remembered: second call refused with no card', p2.done && !p2.ok && msgOf(p2) === refusedText('x.com') && h.sets.length === n);
    const p3 = track(h.g.use('y.com', 'read', {})); await tick();
    check('deny is per site (another site still asks)', !p3.done && h.ask && h.ask.site === 'y.com');
    h.g.end('m1');
    h.g.cancel(); await tick();
    begin(h, { id: 'm2' });
    const p4 = track(h.g.use('x.com', 'read', {})); await tick();
    check('denials go with the message', !p4.done && h.ask && h.ask.site === 'x.com');
  }
  {
    const h = mk(); begin(h, {});
    const a = track(h.g.use('x.com', 'read', {})), b = track(h.g.use('x.com', 'act', {})); await tick();
    const cards = h.sets.filter(s => s.siteAsk).length;
    check('two calls for the same site share one card', cards === 1 && !a.done && !b.done, `cards ${cards}`);
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'message'); await tick();
    check('one answer settles both', a.done && a.ok && b.done && b.ok);
  }
  {
    const h = mk(); begin(h, {});
    const a = track(h.g.use('x.com', 'read', {})), b = track(h.g.use('y.com', 'read', {})), c = track(h.g.use('z.com', 'read', {})); await tick();
    check('other site waits in the queue (one card at a time)', h.ask.site === 'x.com' && !b.done);
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'chat'); await tick();
    check('next queued card shows after the first ends', a.ok && h.ask && h.ask.site === 'y.com' && !b.done);
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'deny'); await tick();
    check('third card after the second; denial refused the second', b.done && !b.ok && h.ask && h.ask.site === 'z.com' && !c.done);
  }
  {
    const h = mk(); begin(h, {});
    const a = track(h.g.use('x.com', 'read', {})), b = track(h.g.use('sub.x.com', 'read', {})); await tick();
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'message'); await tick();
    check('queued call covered by the earlier Allow passes with no card of its own', a.ok && b.done && b.ok && h.ask === null);
  }

  // 5. Blocked, trusted, workers.
  {
    const h = mk(); begin(h, { allow: ['bad.com'] });
    const blocks = { 'bad.com': 'block' };
    const a = track(h.g.use('bad.com', 'read', { blocks, trusted: true }));
    const b = track(h.g.use('www2.bad.com', 'read', { blocks, trusted: true }));
    const c = track(h.g.use('bad.com', 'read', { blocks, army: { run: 'r', worker: 'w' } }));
    await tick();
    check('blocked site refused even when trusted and in the list', a.done && !a.ok && msgOf(a) === 'bad.com is blocked in your site list.', msgOf(a));
    check('subdomain of a blocked entry refused', b.done && !b.ok && msgOf(b) === 'www2.bad.com is blocked in your site list.', msgOf(b));
    check('blocked refused for a worker too', c.done && !c.ok && msgOf(c) === 'bad.com is blocked in your site list.');
    const r = track(h.g.risky('bad.com', 'post', { blocks, trusted: true })); await tick();
    check('risky: blocked refused even when trusted', r.done && !r.ok && msgOf(r) === 'bad.com is blocked in your site list.');
    check('no card for any of them', h.sets.length === 0);
  }
  {
    const h = mk(); begin(h, {});
    const p = track(h.g.use('x.com', 'act', { trusted: true })); await tick();
    check('trusted skips the card', p.done && p.ok && h.sets.length === 0);
  }
  {
    const h = mk(); begin(h, { allow: ['in.com'] });
    const army = { run: 'run1', worker: 'w1' };
    const a = track(h.g.use('in.com', 'read', { army })); await tick();
    check('worker inside the run list is allowed', a.done && a.ok);
    const b = track(h.g.use('out.com', 'read', { army })); await tick();
    check('worker outside the run list -> its text, no card', b.done && !b.ok && msgOf(b) === 'Outside the sites the lead may use: out.com.' && h.sets.length === 0, msgOf(b));
    // The lead adds a site later: the run list stays as it was at its first call.
    const c = track(h.g.use('late.com', 'read', {})); await tick(); h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'message'); await tick();
    const d = track(h.g.use('late.com', 'read', { army })); await tick();
    check('run list is frozen at the first call', c.ok && d.done && !d.ok && msgOf(d) === 'Outside the sites the lead may use: late.com.', msgOf(d));
    const e = track(h.g.use('late.com', 'read', { army: { run: 'run2', worker: 'w1' } })); await tick();
    check('a new run takes the list as it is then', e.done && e.ok);
  }

  // 6. Risky actions.
  {
    const h = mk(); begin(h, {});
    const a = track(h.g.risky('start.com', 'post', {})); await tick();
    check('risky: page not read -> allowed, no card', a.done && a.ok && h.sets.length === 0);
    check('isRead false at first', h.g.isRead() === false);
    h.g.markRead();
    check('markRead sets isRead', h.g.isRead() === true);
    const b = track(h.g.risky('start.com', 'post', {})); await tick();
    check('risky: after a read -> card kind risky', !b.done && h.ask && h.ask.kind === 'risky' && h.ask.action === 'post' && h.ask.site === 'start.com');
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'message'); await tick();
    check("risky takes only allow or deny ('message' ignored)", !b.done && h.ask !== null);
    h.g.answer(h.ask.id, 'allow'); await tick();
    check('risky allow passes the call and clears the card', b.done && b.ok && h.ask === null);
    const c = track(h.g.risky('start.com', 'post', {})); await tick();
    check('risky allow was for one call only (card again)', !c.done && h.ask && h.ask.kind === 'risky');
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'deny'); await tick();
    check('risky deny -> refused text', c.done && !c.ok && msgOf(c) === refusedText('start.com'));
    const d = track(h.g.risky('start.com', 'post', {})); await tick();
    check('risky deny remembered for the message, per action', d.done && !d.ok);
    const e = track(h.g.risky('other.com', 'leave', {})); await tick();
    check('another action+site asks again', !e.done && h.ask && h.ask.action === 'leave' && h.ask.site === 'other.com');
    h.g.end('m1');
    check('end clears the page-read flag', h.g.isRead() === false);
    h.g.cancel(); await tick();
  }
  {
    const h = mk(); begin(h, {}); h.g.markRead();
    const a = track(h.g.risky('start.com', 'leave', { army: { run: 'r', worker: 'w' } })); await tick();
    check('risky: worker -> its text', a.done && !a.ok && msgOf(a) === 'Workers cannot submit forms or leave the site; report back to the lead.' && h.sets.length === 0, msgOf(a));
    const b = track(h.g.risky('start.com', 'post', { trusted: true })); await tick();
    check('risky: trusted -> allowed', b.done && b.ok && h.sets.length === 0);
  }

  // 7. tabView.
  {
    const h = mk(); begin(h, { allow: ['ok.com'] });
    const tab = (id, url) => ({ id, windowId: 3, active: true, title: 'T' + id, url, audible: false, extra: 'x' });
    const inList = h.g.tabView(tab(1, 'https://ok.com/a'), {});
    check('tabView in list: full view', same(inList, { id: 1, windowId: 3, active: true, title: 'T1', url: 'https://ok.com/a', audible: false }), JSON.stringify(inList));
    const out = h.g.tabView(tab(2, 'https://secret.com/a?token=1'), {});
    check('tabView outside the list: id, site, active only', same(out, { id: 2, site: 'secret.com', active: true }), JSON.stringify(out));
    const tr = h.g.tabView(tab(3, 'https://secret.com/a'), { trusted: true });
    check('tabView trusted: full view', tr.url === 'https://secret.com/a' && tr.title === 'T3' && tr.windowId === 3);
    const bl = h.g.tabView(tab(4, 'https://ok.com/a'), { trusted: true, blocks: { 'ok.com': 'block' } });
    check('tabView blocked (even trusted, even in list): redacted', same(bl, { id: 4, site: 'ok.com', active: true }), JSON.stringify(bl));
    const al = h.g.tabView(tab(5, 'https://al.com/a'), { blocks: { 'al.com': 'allow' } });
    check('tabView allow entry in blocks: full view', al.url === 'https://al.com/a');
  }

  // 8. cancel and onChange.
  {
    const h = mk(); begin(h, {});
    const a = track(h.g.use('x.com', 'read', {})), b = track(h.g.use('y.com', 'read', {})); await tick();
    h.g.cancel(); await tick();
    check('cancel refuses the open card and the queued call', a.done && !a.ok && b.done && !b.ok && msgOf(a) === refusedText('x.com') && msgOf(b) === refusedText('y.com') && h.ask === null);
    await h.advance(200000);
    check('cancel leaves no timers behind', h.timers.length === 0);
  }
  {
    const h = mk(); begin(h, {});
    const seen = []; h.g.onChange = l => seen.push(l.slice());
    const p = track(h.g.use('x.com', 'read', {})); await tick();
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'message'); await tick();
    check('onChange called with the new list after an Allow', seen.length === 1 && seen[0].includes('x.com') && seen[0].includes('start.com'), JSON.stringify(seen));
    const q = track(h.g.use('y.com', 'read', {})); await tick();
    h.g.shown(h.ask.id); h.g.answer(h.ask.id, 'deny'); await tick();
    check('onChange not called after a Deny', seen.length === 1 && q.done);
  }

  console.log(failed ? `\n${failed} failed` : `\nAll ${passed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL test crashed: ' + (e && e.stack || e)); process.exit(1); });
