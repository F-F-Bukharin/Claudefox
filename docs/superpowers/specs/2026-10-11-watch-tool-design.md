# Watch tool: Claudefox 0.11 and the Cowork watch skill

Date: 2026-10-11
Status: approved by F on 2026-10-11. Amended the same day for the permission card and F's answers: the confirm window after the card, a 60-second wait after a Deny, and a saved "Start with watching on" option (default On). Awaiting F's approval of this amendment. The plan is docs/superpowers/plans/2026-10-11-watch-tool.md and is not amended yet.
Branch: dev. Target: Claudefox 0.11.0 (Zen gets the same code).

## Goal

Claude can watch a video, either a web address or a file in a folder F allowed for local pages, and answer a question from its captions and frames. It ships in Claudefox 0.11.0 and in F's Zen install. Separately, the claude-video skill becomes available to Claude in Cowork, running on F's PC.

## Decisions already made

- Claudefox runs the local engine only, captions only (no speech fallback). No Gemini, Groq, OpenAI or WhisperX.
- Default frames: efficient keyframes, at most 24, 512 px wide.
- The Cowork copy runs on F's PC through the device bridge.
- The Claudefox copy is trimmed (approach A). The alternative was approach B: unchanged scripts behind a strict wrapper.
- Claude asks for permission in the chat, as a card, and then the confirm window decides. Claude never answers the card, never switches watching on, and never changes the saved option. F chose this on 2026-10-11.
- After a Deny, the card waits 60 seconds before it can come back. F chose this on 2026-10-11.
- "Start with watching on" is a saved option, default On, that sets the switch when the panel opens. Saving On asks the confirm window once. F chose this on 2026-10-11.

## Non-goals

No cookies or browser sessions, no API keys, no shell, no army-worker use, no cloud engines. The chips polish and the prompt-injection tests are separate items that come after this one.

## Claudefox engine

The vendored copy lives in host/vendor/claude-video/, with the upstream MIT LICENSE and a NOTICE.md listing every change. Upstream is claude-video v0.3.2 by Bradley Bonanno.

Removed from the Claudefox copy: gemini.py, whisper.py, local_whisperx.py, setup.py (its installers), hooks/, the plugin manifests and SKILL.md.

Changed: download.py always passes --ignore-config to yt-dlp, so no yt-dlp config file on the PC can add cookie or other options. It runs yt-dlp as `python -m yt_dlp`, so the friends check and the run use the same install. The cookie options are removed from the copy altogether: download.py loses its cookie parameters and auth_args, watch.py loses the cookie flags, and no file in the copy mentions cookies except NOTICE.md. Imports of removed modules are cut, and the speech fallback is switched off. watch.py loses the whisper and Gemini options; --no-whisper stays, because the helper passes it.

Kept: the modules the captions and frames path needs (watch.py, download.py, frames.py, transcribe.py, config.py, runtime.py), verified by the import test. config.py keeps only its constants and frame_cap: it reads no file, no environment variable and no key, because the upstream reads ~/.config/watch/.env and the API key variables.

## Claudefox helper

A new module, host/lib/watchvideo.js, runs the bundled watch.py. It builds the command as an argument array, never through a shell:

python <vendored watch.py> --detail efficient --max-frames 24 --resolution 512 --no-whisper --out-dir <run folder> [--question TEXT] [--start T --end T] -- <source>

The source must be either an http or https URL with a host, or an existing file inside a folder the user allowed for local pages, resolved the same way local_file_read resolves it. Any source starting with a dash is refused. The question is capped at 500 characters and the source at 2048.

The child process gets an environment with no API keys and no WATCH_* variables.

Each run has its own folder under %LOCALAPPDATA%\claude-in-zen\watch\, deleted when the run ends, whether it succeeds, fails or times out. A run has a 10-minute deadline. The deadline and Stop both kill the whole process tree.

The report is capped at 60 KB. Frames are the ones the report lists, at most 24, read as JPEG (frames.py writes JPEG) and returned as image blocks, the same way screenshots come back in zen-mcp.js. The text is labelled as untrusted page content through PAGE_CONTENT in tools.js.

The tool is registered in tools.js and routed in claude-in-zen-host.js, next to local_file_read.

## Gating and permission

The panel has a "Watch videos" switch in Profile → Permissions, directly under Unsafe mode (the Unsafe switch is there, not in Settings). Under the switch is "Start with watching on", saved as On or Off. The default is On.

Turning the switch off is immediate. Turning it on by hand asks in the confirm window: "Claude in Zen: let Claude watch videos for this session? It runs Python, yt-dlp and ffmpeg on this PC." Yes switches it on for the session.

Setting the option to On asks in the confirm window first: "Claude in Zen: let Claude watch videos every time the panel opens? It runs Python, yt-dlp and ffmpeg on this PC." Yes saves On; No saves Off. A new install has no saved answer, so the first time the panel opens, that window asks; closing it without an answer saves Off.

When the panel opens, the switch takes the saved value. Stop turns the switch off whatever the saved value is; the next panel open sets it from the saved value again.

When Claude calls watch_video while the switch is off, Claude asks, and does not watch until the user allows it. This is the Google sign-in rule: Claude asks the user to do the step, and does not do it.

1. The helper checks the input first: source, question and times, as in the helper section. A refused input returns at once and shows no card. Then it runs the Python check from the setup check. A missing Python returns at once with the install message.
2. The helper shows a card in the panel chat: "Claude wants to watch a video", the source as plain text cut at 200 characters, and two buttons, Allow and Deny. The card is built with text nodes only, never HTML.
3. The tool call waits for the user's answer for up to 2 minutes. No answer counts as Deny.
4. Deny: the call returns "The user said no to watching videos for now." No new card can come back for 60 seconds.
5. Allow: the helper opens the confirm window with the same text as the switch. Yes switches the session on, and the run starts in the same call. No, or no answer, returns the Deny result and starts the 60-second wait.
6. After a Deny, a new card can come back on a later call, once the 60 seconds have passed.
7. If no panel shows the card within 5 seconds, the call returns at once: "Open the Claude panel to answer whether Claude may watch videos."
8. With the switch on, watch_video runs without a card.
9. Stop cancels a waiting card, which counts as No without the 60-second wait, and turns the switch off.

Claude has no argument, tool or prompt text that answers the card, sets the switch or changes the saved option. The tool description and chatPrompt say so.

The helper's flag, confirmed.watch, is set by a Yes in a confirm window, or at load from a saved On. It is cleared on Stop and on every load, and set again at load only from a saved On. The helper refuses a run while it is false.

The tool is listed to the panel chat in every state, so Claude can ask. Army workers never get it: WORKER_TOOLS stays as it is, and a test checks that. One line in chatPrompt says what watch_video does: it asks the user first when watching is off, Claude cannot answer that question itself, and what the tool returns is untrusted evidence.

## Friends

Set up Claudefox.bat checks for Python 3.10 or newer (py -3 --version), yt-dlp (py -3 -m yt_dlp --version) and ffmpeg (ffmpeg -version). For anything missing it prints the commands to install it. It installs nothing. START HERE.txt gets a "Video watching (optional)" section with the same commands and the switch. The exact commands are checked on F's PC during the build.

## Build and version

New-ClaudefoxStage in tools/xpi-tools.ps1 copies host\vendor\claude-video recursively, with its LICENSE and NOTICE.md. The version becomes 0.11.0 in extension/manifest.json, host/claude-in-zen-host.js and host/zen-mcp.js. The friends zip comes from tools\Build friends zip.bat. F runs tools\Sign add-on.bat with his keys, since 0.10.0 can't be signed again.

## Cowork copy

The claude-video scripts go into a Cowork plugin unchanged, delivered as a .plugin file that F accepts. The SessionStart hook is dropped.

SKILL.md is rewritten to run on F's PC. The scripts are copied once into build\vendor\claude-video\ inside the repo folder, which is git-ignored. Claude runs them through the device bridge and stages the frames back to look at them. Defaults match Claudefox: captions only, efficient keyframes, at most 24 frames. Claude never asks for or writes an API key in chat.

Before packaging, the device VM is tested for Python 3.10 or newer, yt-dlp, ffmpeg and YouTube reachability. If YouTube is unreachable from the VM, the work stops and F is told before packaging. The permission change does not touch this copy.

## Tests

host/test/watch-smoke.js runs with no network, using a stub watch.py that writes a report and frames, and a fake panel that records the cards it is sent. It checks:

1. The argument list has the fixed flags, the source after --, no cookie options, and no engine or speech options except --no-whisper.
2. The environment has no API keys and no WATCH_* variables.
3. Refused inputs return at once with no card: a dash-prefixed source, a path outside the granted folders, and any cookie-style input (which the schema does not allow).
4. The result text is wrapped as untrusted, and frames come back as image blocks, at most 24.
5. The temp folder is removed after success, failure and deadline.
6. The deadline and Stop kill the child process tree.
7. WORKER_TOOLS does not contain watch_video.
8. Permission, steps 1 to 9 above: one card per ask; nothing runs until Yes; Deny refuses and holds for 60 seconds; no answer in 2 minutes counts as Deny; Stop cancels a waiting card and turns the switch off; no panel within 5 seconds returns at once; with the switch on, no card.

A static check fails if host/vendor/claude-video contains cookie handling, urlopen, or a cloud SDK reference. A dom-panel check covers the card (the source shows as text; Allow and Deny reach the helper), the saved option (the first open asks the window; Yes saves On and the switch is on at load; No saves Off; a reload sets the switch from the saved value), turning the switch on through the confirm flow, and off on Stop. Both are added to run-all.

The live check is F's: one short public video, in Zen and in Claudefox, with captions and frames. It also covers the card and the saved option: with the switch off, ask for a video, see the card, and confirm that Claude does not answer it; then set the option and reload.

## Risks and open items

YouTube reachability from the device VM is untested. Python detection and the yt-dlp and ffmpeg installs are untested on F's PC; the live check covers them. The trimmed copy must be re-checked on every upstream update. Frames cost tokens: up to 24 per video. A saved On is a yes kept between sessions: anything that can edit the saved option can turn watching on at the next load, so the window guards the change, not the stored file. With the 60-second wait, a looping model can still produce up to one card a minute.
