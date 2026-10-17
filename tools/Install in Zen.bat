@echo off
rem Claudefox - builds the add-on and opens it in Zen for a permanent install (survives restarts).
rem Uses a signed build of this PC's own add-on (one without the friends' update address) when build\signed has one for this version;
rem otherwise needs xpinstall.signatures.required = false. Friends-signed builds are never used here.
rem If Zen is linked to this folder (Link add-on to Zen.bat), use "update" in the panel Settings instead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-xpi.ps1"
echo.
pause
