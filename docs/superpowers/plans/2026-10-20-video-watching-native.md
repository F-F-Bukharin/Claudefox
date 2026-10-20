# Claudefox 0.12: native video watching (plan)

Branch: `video-watching-native` (from dev 8953173). Status: plan, not built. Written 20 Oct 2026 from F's answers.

## Goal
Replace the Python watcher (vendored claude-video + yt-dlp + ffmpeg + Python) with a watcher built into the add-on.
It catches frames from the video playing in a browser tab, packs them into timestamped grid sheets with the captions
drawn in, and sends the caption text with them. The user installs nothing, and the friends zip loses the Python,
yt-dlp and ffmpeg steps.

## Decisions (F, 20 Oct)
- Built into the signed add-on. Mozilla's signing rules don't allow an add-on to download code and run it, so the
  watcher can't be a separate download.
- **Base pass at 1 fps** over the whole video (or the asked part).
- **Attention mode:** after the base pass Claude can zoom into short stretches at **4 fps**.
- **Sheets:** a 5×4 grid of 320×180 frames (20 frames per sheet). Each frame has its timestamp drawn in, and each row
  has a caption strip with the line spoken during that row. The full captions also go to Claude as plain text, keyed by
  timestamp, so quotes stay exact.
- **Audio comes later.** There's no transcription in 0.12.
- **yt-dlp becomes a secondary resource:** an optional third-party Claude Skill, offered only when the native watcher
  can't do the job, with a clear notice that it's third-party and not made by Claudefox.
- **Budget:** about 100k tokens for a full 10-minute video is acceptable. Target typical about 70k, worst case under
  100k (see Budget).

## How it works

### The tool Claude sees
- `watch_video(source, question?, start?, end?)`: the base pass. `source` is an https link, the full path of a video
  file in an allowed folder, or `tab:<id>` for a video already open in a tab. It returns a `watch_id`, the caption text,
  a short summary (duration, frames kept, sheets, caption source and language), then the sheets as images.
- `watch_zoom(watch_id, start, end)`: a 4 fps burst over at most 30 seconds, at most 10 bursts per `watch_id`, and only
  while that video's tab is still held (10 minutes after the last call). It returns sheets plus the captions of that
  stretch.
- Both are `watchOnly`, behind the same gate as today: the permission card in the panel, the confirm window, Stop, and
  the "every time the panel opens" answer (host/lib/watchgate.js and watchwiring.js stay). The tool descriptions keep
  the untrusted-content warning.

### Where it runs
- The **host** keeps the gate and forwards the call to the add-on, like the other page tools (it goes in
  PAGE_READ_TOOLS). watchvideo.js and watchrun.js lose the child process.
- The **add-on** gets `extension/lib/bg-watch.js` (background: the tab, timing, limits and sheet building) and
  `extension/lib/watch-frame.js` (injected into the video's tab: it finds the video, drives it and grabs frames).
- **Tab:** an https link opens in a new inactive tab owned by the watcher. A file path opens as `file:///…`, checked
  against the allowed folders the same way local pages are. `tab:<id>` uses that tab without taking focus, and puts
  the time position and playback speed back afterwards. The watcher closes the tabs it opened when done, on Stop, or
  when its hold times out.

### Catching frames
1. Pick the largest playing or playable `<video>` in the tab, including same-origin iframes. Mute it while watching
   and restore the volume afterwards.
2. Report protected video (`video.mediaKeys` set, or EME in use) as "this video is protected; frames would be black",
   instead of sending black frames.
3. Play from `start` with `playbackRate` set as high as the site keeps (try 4, then 2, then 1; some players reset it).
   Use `requestVideoFrameCallback` to grab the first frame at or after each sample time (1 s apart for the base pass,
   0.25 s for a zoom), using the video's own `mediaTime` for the timestamps. Without rVFC, fall back to polling
   `currentTime` every 50 ms.
4. Grab with `drawImage(video)` onto a 320×180 canvas, letterboxed to keep the aspect ratio. If the canvas is tainted
   (cross-origin video without CORS), fall back to `tabs.captureTab` of the video's on-screen box, scaled to 320×180.
   A spike in Task 1 checks which sites need the fallback.
5. **Drop near-duplicates** in the base pass: compare a 16×9 grey thumbnail with the last kept frame. Keep a frame when
   the change is above the threshold, or when 10 s have passed since the last kept one (a heartbeat). Zoom bursts keep
   every frame. The summary says how many frames were dropped.
6. Stop at `end`, at the end of the video, on Stop, or at the run's deadline (the video's length divided by the reached
   speed, plus 2 minutes, at most 30 minutes).

### Sheets
- 1600 px wide: 5 columns × 320 px. Each row is 180 px of frames plus a 28 px caption strip, so 4 rows make 832 px.
  Encoded as JPEG at quality 0.75 (about 100–150 KB per sheet).
- Each frame has its time (`12:41.25` on zoom sheets, `12:41` on base sheets) drawn in a corner with an outlined font.
- Each caption strip holds the caption text spoken during that row's time span, clipped to one line with an ellipsis.
  The full text is in the plain-text captions.
- A sheet's text line goes before its image: `Sheet 3: 1:40–2:20, frames 41–60 (12 kept)`.

### Captions
- **YouTube:** read the caption tracks from the player's own data (`ytInitialPlayerResponse` /
  `movie_player.getPlayerResponse()`, reached through `wrappedJSObject` in Firefox), then fetch the chosen track as
  json3 from the same origin, which the page is allowed to fetch.
- **Other sites:** `video.textTracks`, and `<track src>` files fetched and parsed as WebVTT or SRT.
- **Choice:** manual tracks before auto-generated; the question's language, then the user's add-on language, then the
  video's original language. The summary names the track.
- **No captions:** say so, so Claude knows there's no speech text. If the question needs speech, offer the secondary
  resource (below).
- Caption text goes out as `[mm:ss] text` lines, merged into lines of about 10 s, and marked as untrusted page content.

### Secondary resource: the third-party watch skill
- Offered only when the native watcher reports no captions and the question needs speech, or a site blocks both the
  frame grab and the tab capture.
- The notice: "This uses yt-dlp and ffmpeg through a Claude Skill made by another developer. It is third-party
  software, not made by Claudefox. Install it?" It installs through the existing plugin install flow, which already
  asks first.
- **Open (F):** which skill and repo, its author line for the notice, and its license.

### Budget (10-minute video)
| Part | Frames | Sheets | Tokens (about) |
|---|---|---|---|
| Base pass, 1 fps, before dropping duplicates | 600 | 30 | 45k |
| Base pass, talk or tutorial, after dropping | about 250 | about 13 | 20k |
| 5 zoom bursts of 15 s at 4 fps | 300 | 15 | 22k |
| Captions | – | – | 2–3k |
| **Typical total** | | | **about 45–70k** |
| Worst case: 10 bursts of 30 s | | | about 95k |

The image token cost is about the same on Haiku, Sonnet and Opus. The model changes how much of the plan it uses and
how much it thinks. The sheets stay in the chat's context, so follow-up questions re-read them, cached.

## Tasks
1. **Spike (no commit to dev):** a throwaway `watch-frame.js` in Zen on YouTube, Vimeo, a news site video and a local
   .mp4. Record which ones allow `drawImage` without tainting, whether rVFC exists in Zen's Gecko, the speeds each
   player keeps, and how the YouTube caption track is reached. Result: a table in this plan.
2. **Pure parts with tests first (Node, no browser):** the sample clock (1 fps or 4 fps, start/end, rVFC frame times),
   duplicate dropping (thumbnail difference, heartbeat), sheet layout (positions, row spans, caption strip text per
   row, clipping), caption parsers (YouTube json3, WebVTT, SRT, merging into about 10 s lines), track choice, and
   time parsing (`90`, `1:30`, `1:02:03`). New `test/watch-native.js`.
3. **watch-frame.js:** find the video, protected-video check, mute and restore, speed, rVFC or polling, the canvas grab
   with the taint fallback signal, and cleanup on every exit. DOM test with jsdom fakes for `<video>` and canvas
   (extend test/dom-watch.js).
4. **bg-watch.js:** the tab (open, reuse `tab:<id>`, file: with folder grants), running watch-frame.js, captureTab
   fallback, the sheet canvas (OffscreenCanvas), the hold for zooms, limits (30 s per burst, 10 bursts, deadline),
   Stop, and closing its tabs. Tests with faked `browser.tabs`.
5. **Tool contract:** `watch_video` keeps its name with the new description, plus `watch_zoom` (toolSchemas.js), host
   forwarding to the add-on, results as text then images (claudefox-mcp.js), and the gate unchanged. Update
   watch-smoke.js, scope-smoke.js and dom-watch.js, and add `watch_zoom` to every place that lists `watch_video`.
6. **Remove the Python route:** `host/vendor/claude-video`, the child process in watchvideo.js and watchrun.js,
   watch-engine-smoke.js, the Python/yt-dlp/ffmpeg checks in `Set up Claudefox.bat`, START HERE.txt (friends),
   README, the menu and brand.js rules. Rewrite test/watch-static.js for the new files. Note: F's uncommitted "cowork"
   checks in watch-static.js on the PC expect a Cowork watch skill; tell F they change.
7. **Secondary resource:** the notice and offer path (needs F's answer on the skill), en and pt_BR texts.
8. **Panel and texts:** "Watch videos" in Profile → Permissions says it works with no installs. Status while watching:
   speed, time and frames kept. All new user texts in en and pt_BR (i18n tests).
9. **Version 0.12.0,** full suite, friends build check (brand.js finds no "Zen" and no Python steps), and F's live
   checks: a YouTube talk (base pass plus 2 zooms), a fast clip, a local .mp4 in an allowed folder, a protected video
   (clean refusal), Stop during a run, and closing the tab during a run.

## Out of scope for 0.12
- Audio recording and transcription (`mozCaptureStream` + MediaRecorder in the tab, Whisper in the helper, model
  downloaded after asking).
- Dropping the sheets from the chat after an answer.
- Streams with captions only inside HLS/DASH manifests.

## Risks
- **Sites that taint the canvas:** the captureTab fallback costs a bit of quality, and needs the video on screen in its
  tab (an inactive tab still renders in Firefox; the spike checks this).
- **Players that reset `playbackRate`:** the run is slower, but the deadline still holds.
- **YouTube changes where it keeps caption data:** there are two lookup paths, and a clear "no captions found" when
  both fail.
- **An inactive tab may be throttled:** the spike checks frame delivery in a background tab. If it's throttled, the
  watcher uses a separate small window that the user can minimise.
