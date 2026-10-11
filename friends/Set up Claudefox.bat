@echo off
rem Claudefox - one double-click setup. Safe to run again.
rem 1) installs the helper that links the add-on to Claude Code (no admin needed)
rem 2) signs the Claude Code profile the add-on uses into your Claude account
rem 3) copies the add-on's path and opens Firefox where it is loaded: about:debugging, or about:addons for a signed build
title Claudefox setup
cd /d "%~dp0"
echo.
echo  Claudefox setup
echo  ---------------
echo.
echo  [1/3] Installing the helper...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host\install.ps1"
if errorlevel 1 (
  echo.
  echo  The helper did not install. Read the message above, fix it, then run this file again.
  pause
  exit /b 1
)
echo.
echo  [2/3] Signing Claude Code in. A browser opens: sign in, then click Authorize.
call "%~dp0tools\Sign in Claude Code.bat" /quiet
if errorlevel 1 (
  echo.
  echo  Claude Code did not sign in. If Claude Code is missing, install it from code.claude.com/docs/en/setup
  echo  and run this file again.
  pause
  exit /b 1
)
echo.
if not exist "%~dp0claudefox.xpi" (
  echo  [3/3] There is no add-on file next to this file, so nothing to load in Firefox.
  goto finish
)
for %%I in ("%~dp0claudefox.xpi") do (<nul set /p="%%~fI") | clip
echo  [3/3] The add-on's path is copied.
set "PAGE=about:debugging#/runtime/this-firefox"
set "HOW=click Load Temporary Add-on..., paste the path with Ctrl+V and press Enter. Load it again after each Firefox restart."
if exist "%~dp0SIGNED" set "PAGE=about:addons"
if exist "%~dp0SIGNED" set "HOW=gear icon, Install Add-on From File, paste the path with Ctrl+V and press Enter."
set "FF=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if not exist "%FF%" set "FF=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"
if not exist "%FF%" set "FF=%LOCALAPPDATA%\Mozilla Firefox\firefox.exe"
if not exist "%FF%" goto noff
start "" "%FF%" "%PAGE%"
echo  In Firefox, on %PAGE%: %HOW%
goto finish
:noff
echo  Firefox was not found where it usually is. Open Firefox and type %PAGE% in the address bar.
echo  Then: %HOW%
:finish
echo  Video watching (optional), checking what it needs:
py -3 --version >nul 2>&1 || echo    - Python 3.10 or newer is missing: see "Video watching" in START HERE.txt.
py -3 -m yt_dlp --version >nul 2>&1 || echo    - yt-dlp is missing: run  py -3 -m pip install -U yt-dlp
ffmpeg -version >nul 2>&1 || echo    - ffmpeg is missing: run  winget install Gyan.FFmpeg
echo.
echo  Setup finished. START HERE.txt has the last steps.
pause
exit /b 0
