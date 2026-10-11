@echo off
rem Claude in Zen - builds the zip to send to friends (build\friends\Claudefox-v<version>.zip, the add-on named Claudefox).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-friends.ps1"
echo.
pause
