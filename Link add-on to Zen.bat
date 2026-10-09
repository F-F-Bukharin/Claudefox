@echo off
rem Claude in Zen - links Zen to this folder so updates are one click in Settings (no .xpi, no restart).
rem Close Zen first. Undo: zen-profile\link.ps1 -Unlink, then Install in Zen.bat.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0zen-profile\link.ps1"
echo.
pause
