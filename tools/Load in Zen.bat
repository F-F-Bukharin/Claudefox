@echo off
rem Claudefox - rebuilds the .xpi and opens the loader in Zen (temporary install).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-xpi.ps1"
if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )
for %%I in ("%~dp0..\build\claudefox.xpi") do (<nul set /p="%%~fI") | clip
start "" "C:\Program Files\Zen Browser\zen.exe" "about:debugging#/runtime/this-firefox"
echo.
echo  Zen is opening the add-on loader.
echo  1. Click "Load Temporary Add-on..."
echo  2. Pick claudefox.xpi from the build folder (the path is already copied: Ctrl+V, Enter)
echo.
echo  After a code change, just run this file again and click Reload in Zen.
timeout /t 15
