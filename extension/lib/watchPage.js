'use strict';
// Claudefox: the video watcher's side inside the video's tab. lib/bg-watch.js joins the source of cfxWatchPage (and of
// the watchCore.js functions it names) into the script it injects, so this function may use only the page's own
// globals and those functions, never anything else from the add-on. It runs in the add-on's isolated content-script
// world: the page cannot see or change it. In Firefox, wrappedJSObject reaches YouTube's own player for its captions.
//
// Operations: probe (find the video), captions, grab (play and catch frames), seekshow (one frame on screen, for the
// screenshot fallback), stop, restore (sound, speed and captions back as they were).

function cfxWatchPage(op, args) {
  const a = args || {};
  const st = window.__cfxWatchSt || (window.__cfxWatchSt = { abort: false, v: null, orig: null, capsOn: false, capsWas: null });
  const host = location.hostname.replace(/^www\.|^m\./, '');
  const yt = host === 'youtube.com' || host.endsWith('.youtube.com');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const player = () => (yt ? document.getElementById('movie_player') : null);
  const playerApi = () => { const p = player(); return p ? (p.wrappedJSObject || p) : null; };
  const adShowing = () => { const p = player(); return !!(p && p.classList.contains('ad-showing')); };
  // An object from the page's own world, as plain data (Firefox: through the page's JSON; elsewhere it is already plain).
  const plain = o => {
    if (o == null) return null;
    try { const J = window.wrappedJSObject && window.wrappedJSObject.JSON; return JSON.parse(J ? J.stringify(o) : JSON.stringify(o)); } catch { return null; }
  };

  function length(v) {
    if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
    try { if (v.seekable && v.seekable.length) return v.seekable.end(v.seekable.length - 1); } catch {}
    return NaN;
  }
  function pick() {
    const list = Array.from(document.querySelectorAll(yt ? '#movie_player video, video' : 'video'));
    let best = null, score = -1;
    for (const v of list) {
      const r = v.getBoundingClientRect();
      const s = Math.max(0, r.width) * Math.max(0, r.height) + (length(v) > 0 ? 1e8 : 0) + (v.readyState > 0 ? 1e7 : 0);
      if (s > score) { best = v; score = s; }
    }
    return best;
  }
  function video() {
    const v = st.v && st.v.isConnected ? st.v : pick();
    if (v && v !== st.v) {
      st.v = v;
      st.orig = { muted: v.muted, volume: v.volume, rate: v.playbackRate };
    }
    return v;
  }
  function title() {
    const t = String(document.title || '').replace(/\s+-\s+YouTube$/, '').trim();
    return t || location.hostname;
  }
  function seekTo(v, t) {
    return new Promise(resolve => {
      let to = null;
      const done = () => { v.removeEventListener('seeked', done); clearTimeout(to); resolve(); };
      to = setTimeout(done, 8000);
      v.addEventListener('seeked', done);
      const api = playerApi();
      try { if (api && typeof api.seekTo === 'function') api.seekTo(t, true); else v.currentTime = t; } catch { v.currentTime = t; }
    });
  }
  function onScreenCaptions() {
    return Array.from(document.querySelectorAll('.ytp-caption-segment')).map(e => e.textContent).join(' ');
  }

  if (op === 'stop') { st.abort = true; return { stopped: true }; }

  if (op === 'probe') {
    const v = video();
    if (!v) {
      const embeds = Array.from(document.querySelectorAll('iframe[src]')).map(f => f.src)
        .filter(s => /youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|dailymotion\.com\/embed|player\.twitch\.tv|streamable\.com|wistia|brightcove|jwplayer/i.test(s)).slice(0, 3);
      return { found: false, embeds, title: title(), hidden: document.visibilityState === 'hidden' };
    }
    return {
      found: true, title: title(), duration: length(v), live: v.duration === Infinity, protected: !!v.mediaKeys,
      width: v.videoWidth, height: v.videoHeight, ready: v.readyState, ad: adShowing(), yt,
      rvfc: typeof v.requestVideoFrameCallback === 'function', hidden: document.visibilityState === 'hidden',
    };
  }

  if (op === 'restore') {
    const v = st.v;
    if (v) {
      try { v.pause(); } catch {}
      if (st.orig) { v.muted = st.orig.muted; v.volume = st.orig.volume; try { v.playbackRate = st.orig.rate; } catch {} }
    }
    const api = playerApi();
    if (st.capsOn && api && st.capsWas === false) { try { api.setOption('captions', 'track', {}); } catch {} }
    st.capsOn = false;
    return { restored: true };
  }

  if (op === 'captions') {
    return (async () => {
      const fetchy = (typeof content === 'object' && content && typeof content.fetch === 'function') ? content.fetch.bind(content) : window.fetch.bind(window);
      async function get(url) {
        try {
          const r = await fetchy(url, { credentials: 'include' });
          if (!r.ok) return null;
          const txt = await r.text();
          return txt.trim() ? cfxWatchJson3(JSON.parse(txt)) : null;
        } catch { return null; }
      }
      const MAX = 6000;
      if (yt) {
        const api = playerApi();
        let resp = null;
        try { if (api && typeof api.getPlayerResponse === 'function') resp = plain(api.getPlayerResponse()); } catch {}
        if (!resp) resp = plain(window.wrappedJSObject && window.wrappedJSObject.ytInitialPlayerResponse);
        const list = resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer;
        const raw = (list && list.captionTracks) || [];
        if (!raw.length) return { source: 'none', note: 'This YouTube video has no captions.' };
        const name = n => (n && (n.simpleText || (n.runs || []).map(r => r.text).join(''))) || '';
        const def = list.audioTracks && list.audioTracks[0] && list.audioTracks[0].defaultCaptionTrackIndex;
        const tracks = raw.map((t, i) => ({ lang: t.languageCode, name: name(t.name), auto: t.kind === 'asr', isDefault: i === def }));
        const choice = cfxWatchPickTrack(tracks, a.lang, !!(list.translationLanguages && list.translationLanguages.length));
        const tr = tracks[choice.index];
        const translate = choice.translate && raw[choice.index].isTranslatable !== false ? choice.translate : '';
        const label = (tr.name || tr.lang) + (tr.auto ? ' (auto-generated)' : '') + (translate ? `, translated to ${translate} by YouTube` : '');
        const address = (base) => { const u = new URL(base, location.href); u.searchParams.set('fmt', 'json3'); if (translate) u.searchParams.set('tlang', translate); else u.searchParams.delete('tlang'); return u.href; };
        let cues = await get(address(raw[choice.index].baseUrl));
        if (!cues || !cues.length) {
          // The player's own caption request carries a token this address lacks: turn its captions on and use its address.
          try {
            if (st.capsWas === null) { const cur = plain(api.getOption('captions', 'track')); st.capsWas = !!(cur && cur.languageCode); }
            api.loadModule('captions');
            api.setOption('captions', 'track', { languageCode: tr.lang });
            st.capsOn = true;
          } catch {}
          for (let k = 0; k < 24 && !(cues && cues.length); k++) {
            await sleep(250);
            const seen = performance.getEntriesByType('resource').map(e => e.name).filter(n => /\/api\/timedtext/.test(n)).pop();
            if (seen) { cues = await get(address(seen)); if (!cues || !cues.length) break; }
          }
        }
        if (cues && cues.length) return { source: 'youtube', label, lang: translate || tr.lang, auto: tr.auto, translated: !!translate, cues: cues.slice(0, MAX) };
        return { source: 'screen', label, lang: tr.lang, auto: tr.auto, cues: [], note: 'YouTube did not hand out its caption file, so the captions are read off the screen while the video plays.' };
      }
      const v = video();
      const list = v && v.textTracks ? Array.from(v.textTracks).filter(t => t.kind === 'subtitles' || t.kind === 'captions') : [];
      if (!list.length) return { source: 'none', note: 'This video has no caption track.' };
      const tracks = list.map(t => ({ lang: t.language, name: t.label, auto: false, isDefault: t.mode === 'showing' }));
      const choice = cfxWatchPickTrack(tracks, a.lang, false);
      const t = list[choice.index];
      const was = t.mode;
      if (t.mode === 'disabled') t.mode = 'hidden';
      for (let k = 0; k < 30 && !(t.cues && t.cues.length); k++) await sleep(100);
      const cues = Array.from(t.cues || []).slice(0, MAX).map(c => ({ start: c.startTime, end: c.endTime, text: String(c.text || '').replace(/<[^>]+>/g, '') }));
      t.mode = was;
      return { source: 'track', label: t.label || t.language || 'captions', lang: t.language || '', auto: false, cues };
    })();
  }

  if (op === 'seekshow') {
    return (async () => {
      const v = video();
      if (!v) throw new Error('The video is gone from the page.');
      v.muted = true;
      try { v.pause(); } catch {}
      await seekTo(v, Number(a.t) || 0);
      if (typeof v.requestVideoFrameCallback === 'function') {
        await Promise.race([new Promise(r => v.requestVideoFrameCallback(() => r())), sleep(700)]);
      } else await sleep(200);
      v.scrollIntoView({ block: 'center', inline: 'center' });
      const r = v.getBoundingClientRect();
      return { t: v.currentTime, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, ad: adShowing(),
        caption: a.seenCaps ? onScreenCaptions() : '', hidden: document.visibilityState === 'hidden' };
    })();
  }

  if (op === 'grab') {
    return (async () => {
      const v = video();
      if (!v) throw new Error('The video is gone from the page.');
      st.abort = false;
      v.muted = true;
      const t0 = Number(a.t0) || 0, t1 = Number(a.t1), step = Number(a.step) || 1;
      const maxWall = Number(a.maxWallMs) || 20000, maxFrames = Number(a.maxFrames) || 120;
      if (adShowing()) {   // a YouTube ad plays in the same video element: wait it out, muted, before seeking
        const until = Date.now() + Math.min(maxWall, 15000);
        while (adShowing() && Date.now() < until && !st.abort) await sleep(250);
        if (adShowing()) return { frames: [], seen: [], next: t0, reached: t0, ad: true, waitingAd: true };
      }
      if (Math.abs(v.currentTime - t0) > 0.35) await seekTo(v, t0);
      try { v.playbackRate = Number(a.rate) || 1; } catch {}
      const W = 320, H = 180;
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const small = document.createElement('canvas'); small.width = 16; small.height = 9;
      const sctx = small.getContext('2d', { willReadFrequently: true });
      const sam = cfxWatchSampler(t0, t1, step);
      const frames = [], seen = [];
      let tainted = false, ended = false, stalled = false, adMs = 0, playErr = '';
      let lastT = v.currentTime, lastMove = Date.now();
      const began = Date.now();
      function catchOne(t) {
        const vw = v.videoWidth || 16, vh = v.videoHeight || 9, s = Math.min(W / vw, H / vh), dw = vw * s, dh = vh * s;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
        let px;
        try { sctx.drawImage(canvas, 0, 0, 16, 9); px = sctx.getImageData(0, 0, 16, 9).data; } catch { tainted = true; return false; }
        const gray = new Array(144);
        for (let i = 0; i < 144; i++) gray[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
        frames.push({ t: Math.round(t * 1000) / 1000, jpeg: canvas.toDataURL('image/jpeg', 0.8), gray });
        if (a.seenCaps) seen.push({ t, text: onScreenCaptions() });
        return true;
      }
      const rvfc = typeof v.requestVideoFrameCallback === 'function';
      await new Promise(resolve => {
        let over = false;
        const finish = () => { if (!over) { over = true; clearInterval(dog); resolve(); } };
        const at = t => {
          if (over) return;
          if (st.abort) return finish();
          if (adShowing()) return;
          if (t > lastT + 1e-3) { lastT = t; lastMove = Date.now(); }
          if (sam.want(t) && !catchOne(t)) return finish();
          if (sam.done(t) || frames.length >= maxFrames || Date.now() - began > maxWall) return finish();
        };
        const onFrame = (now, meta) => {
          if (over) return;
          at(meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : v.currentTime);
          if (!over) v.requestVideoFrameCallback(onFrame);
        };
        const dog = setInterval(() => {   // the watchdog, and the clock when rVFC is missing
          if (!rvfc) at(v.currentTime);
          if (over) return;
          if (st.abort || Date.now() - began > maxWall) return finish();
          if (adShowing()) { adMs += 50; lastMove = Date.now(); return; }
          if (v.ended) { at(v.currentTime); ended = true; return finish(); }
          const idle = Date.now() - lastMove;
          if (idle > 3000 && v.paused && !v.seeking) v.play().catch(() => {});
          if (idle > 9000) { stalled = true; finish(); }
        }, 50);
        if (rvfc) v.requestVideoFrameCallback(onFrame);
        v.play().catch(e => { playErr = (e && e.name) || 'play failed'; });
      });
      try { v.pause(); } catch {}
      return { frames, seen, next: sam.next(), reached: lastT, ended, stalled, tainted, rate: v.playbackRate,
        ad: adMs > 0, hidden: document.visibilityState === 'hidden', playErr };
    })();
  }

  throw new Error('Unknown watch operation: ' + op);
}
