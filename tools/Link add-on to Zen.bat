@echo off
rem Claudefox - links Zen to this folder so updates are one click in Settings (no .xpi, no restart).
rem Close Zen first. Undo: ..\zen-profile\link.ps1 -Unlink, then Install in Zen.bat.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\zen-profile\link.ps1"
if not errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\zen-profile\apply.ps1"
echo.
pause
