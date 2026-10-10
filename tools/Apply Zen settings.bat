@echo off
rem Claude in Zen - docks the sidebar on the right and opens the Claude panel about 660 px wide.
rem Close Zen first. Undo: run ..\zen-profile\apply.ps1 -Remove.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\zen-profile\apply.ps1"
echo.
pause
