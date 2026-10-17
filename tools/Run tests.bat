@echo off
rem Claudefox - runs every test. The DOM tests need jsdom (npm i --no-save jsdom) and skip without it.
rem The chat test needs Linux or macOS and skips here.
node "%~dp0..\test\run-all.js"
echo.
pause
