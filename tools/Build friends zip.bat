@echo off
rem Claude in Zen - builds the zip to send to friends (build\friends\claude-in-zen-friends-v<version>.zip).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-friends.ps1"
echo.
pause
