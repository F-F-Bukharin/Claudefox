@echo off
rem Claudefox - installs only the helper that links the add-on to Claude Code (no admin needed).
rem "Set up Claudefox.bat" does this too, and signs Claude Code in.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\host\install.ps1" %*
echo.
echo  Done. In the Claudefox panel, open Settings and click "retry" next to Native host,
echo  or press Stop and then Start.
pause
