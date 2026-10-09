@echo off
rem Claude in Zen - installs the helper that links the add-on to Claude Code on this PC (no admin needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host\install.ps1" %*
echo.
echo  Done. In the Claude in Zen panel, open Settings and click "retry" next to Native host,
echo  or press Stop and then Start.
pause
