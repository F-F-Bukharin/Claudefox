@echo off
rem Claude in Zen - builds the add-on and opens it in Zen for a permanent install (survives restarts).
rem Uses build\signed when it has a build for this version; otherwise needs xpinstall.signatures.required = false.
rem If Zen is linked to this folder (Link add-on to Zen.bat), use "update" in the panel Settings instead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-xpi.ps1"
echo.
pause
