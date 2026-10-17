@echo off
rem Claudefox - one double-click setup. Safe to run again.
rem 1) installs the helper that links the add-on to Claude Code (no admin needed)
rem 2) signs the Claude Code profile the add-on uses into your Claude account
rem 3) opens Zen on its add-ons page with the add-on file path copied (only where claudefox.xpi sits next to this file)
title Claudefox setup
cd /d "%~dp0"
echo.
echo  Claudefox setup
echo  -------------------
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
  echo  [3/3] There is no add-on file next to this file, so nothing to install in Zen.
  goto finish
)
echo  [3/3] Opening Zen on its add-ons page...
set "ZEN=%ProgramFiles%\Zen Browser\zen.exe"
if not exist "%ZEN%" set "ZEN=%LOCALAPPDATA%\Zen Browser\zen.exe"
if not exist "%ZEN%" (
  echo  Zen Browser was not found. Install it, then do step 2 in START HERE.txt.
  goto finish
)
for %%I in ("%~dp0claudefox.xpi") do (<nul set /p="%%~fI") | clip
start "" "%ZEN%" "about:addons"
echo  In Zen: gear icon, Install Add-on From File, then paste the path (Ctrl+V) and press Enter.
echo  The path is already copied. If Zen says the add-on is not signed, see step 2a in START HERE.txt.
:finish
echo.
echo  Setup finished. START HERE.txt has the last steps.
pause
exit /b 0
