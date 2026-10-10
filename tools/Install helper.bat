@echo off
rem Claude in Zen - installs only the helper that links the add-on to Claude Code (no admin needed).
rem "Set up Claude in Zen.bat" does this too, and signs Claude Code in.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\host\install.ps1" %*
echo.
echo  Done. In the Claude in Zen panel, open Settings and click "retry" next to Native host,
echo  or press Stop and then Start.
pause
