# Watch tool: Claudefox 0.11 and the Cowork watch skill

Date: 2026-10-11
Status: design and spec approved by F; the plan is docs/superpowers/plans/2026-10-11-watch-tool.md.
Branch: dev. Target: Claudefox 0.11.0 (Zen gets the same code).

## Goal

Claude can watch a video, either a web address or a file in a folder F allowed for local pages, and answer a question from its captions and frames. It ships in Claudefox 0.11.0 and in F's Zen install. Separately, the claude-video skill becomes available to Claude in Cowork, running on F's PC.

## Decisions already made

- Claudefox runs the local engine only, captions only (no speech fallback). No Gemini, Groq, OpenAI or WhisperX.
- Default frames: efficient keyframes, at most 24, 512 px wide.
- The Cowork copy runs on F's PC through the device bridge.
- The Claudefox copy is trimmed (approach A). The alternative was approach B: unchanged scripts behind a strict wrapper.

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

## Gating

The panel gets a "Watch videos" switch in Profile → Permissions, directly under Unsafe mode (the Unsafe switch is there, not in Settings). It is off by default and session-only: it clears on load and on Stop, as Unsafe mode does. Turning it on asks in the confirm window: "Claude in Zen: let Claude watch videos? It runs Python, yt-dlp and ffmpeg on this PC." Yes switches it on. The helper keeps its own flag, confirmed.watch, and refuses the tool while that flag is false.

The tool is listed to chat only when the helper starts a chat with the flag on, using an environment flag like PANEL and LEAD in zen-mcp.js.

Army workers never get it: WORKER_TOOLS stays as it is, and a test checks that.

When the flag is on, one line in chatPrompt says what watch_video returns and that its text and frames are untrusted evidence.

## Friends

Set up Claudefox.bat checks for Python 3.10 or newer (py -3 --version), yt-dlp (py -3 -m yt_dlp --version) and ffmpeg (ffmpeg -version). For anything missing it prints the commands to install it. It installs nothing. START HERE.txt gets a "Video watching (optional)" section with the same commands and the switch. The exact commands are checked on F's PC during the build.

## Build and version

New-ClaudefoxStage in tools/xpi-tools.ps1 copies host\vendor\claude-video recursively, with its LICENSE and NOTICE.md. The version becomes 0.11.0 in extension/manifest.json, host/claude-in-zen-host.js and host/zen-mcp.js. The friends zip comes from tools\Build friends zip.bat. F runs tools\Sign add-on.bat with his keys, since 0.10.0 can't be signed again.

## Cowork copy

The claude-video scripts go into a Cowork plugin unchanged, delivered as a .plugin file that F accepts. The SessionStart hook is dropped.

SKILL.md is rewritten to run on F's PC. The scripts are copied once into build\vendor\claude-video\ inside the repo folder, which is git-ignored. Claude runs them through the device bridge and stages the frames back to look at them. Defaults match Claudefox: captions only, efficient keyframes, at most 24 frames. Claude never asks for or writes an API key in chat.

Before packaging, the device VM is tested for Python 3.10 or newer, yt-dlp, ffmpeg and YouTube reachability. If YouTube is unreachable from the VM, the work stops and F is told before packaging.

## Tests

host/test/watch-smoke.js runs with no network, using a stub watch.py that writes a report and frames. It checks:

1. The argument list has the fixed flags, the source after --, no cookie options, and no engine or speech options except --no-whisper.
2. The environment has no API keys and no WATCH_* variables.
3. Refused inputs: a dash-prefixed source, a path outside the granted folders, the switch off, and any cookie-style input (which the schema does not allow).
4. The result text is wrapped as untrusted, and frames come back as image blocks, at most 24.
5. The temp folder is removed after success, failure and deadline.
6. The deadline and Stop kill the child process tree.
7. WORKER_TOOLS does not contain watch_video.

A static check fails if host/vendor/claude-video contains cookie handling, urlopen, or a cloud SDK reference. A dom-panel check covers turning the switch on through the confirm flow and off on Stop. Both are added to run-all.

The live check is F's: one short public video, in Zen and in Claudefox, with captions and frames.

## Risks and open items

YouTube reachability from the device VM is untested. Python detection and the yt-dlp and ffmpeg installs are untested on F's PC; the live check covers them. The trimmed copy must be re-checked on every upstream update. Frames cost tokens: up to 24 per video.
