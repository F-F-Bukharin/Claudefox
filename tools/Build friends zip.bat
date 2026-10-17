@echo off
rem Claudefox - builds the zip to send to friends (build\friends\Claudefox-v<version>.zip).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-friends.ps1"
echo.
pause
