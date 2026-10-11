# NOTICE: claude-video, trimmed for Claude in Zen

This folder is a trimmed copy of **claude-video** v0.3.2 by Bradley Bonanno, used under the MIT licence (the full text is in `LICENSE` beside this file). It is the upstream `skills/watch/scripts` folder, from the claude-video-main archive, with the changes listed below.

## Kept

- `watch.py`, `frames.py`, `transcribe.py`, `runtime.py`: the upstream logic. `frames.py`, `transcribe.py` and `runtime.py` are unchanged.
- `download.py`: captions and per-run media downloads through yt-dlp.

## Changed

- `download.py`: the cookie options are removed (`auth_args` and every cookie parameter). yt-dlp runs as `python -m yt_dlp --ignore-config`, from the same Python that runs `watch.py`, so the friends check and the run use one install. `resolve_local` no longer expands `~`. The sign-in hint no longer mentions cookies.
- `watch.py`: the Gemini engine, the Whisper and WhisperX transcription paths, and the `--engine`, `--whisper` and cookie options are removed. `--no-whisper` stays and leaves speech transcription off; this copy has no speech engine, so captions are the only transcript source. Messages no longer name `setup.py`.
- `config.py`: the settings file, the environment reads and the API key lookups are removed. Only the detail names, `frame_cap` and a fixed `get_config()` remain.

## Not included

`gemini.py`, `whisper.py`, `local_whisperx.py` and `setup.py`; the cookie options; API keys; the cloud engines; speech transcription; the Claude plugin files, hooks and SKILL.md of the upstream skill.
