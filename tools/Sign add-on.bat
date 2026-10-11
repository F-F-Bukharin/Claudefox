@echo off
rem Claude in Zen - signs Claudefox (the friends build) with Mozilla (unlisted, for sharing).
rem It signs a clean, branded copy, so this PC's own mods and saved files never leave it (tools\sign-claudefox.ps1).
rem Reads your keys from the WEB_EXT_API_KEY and WEB_EXT_API_SECRET user environment variables.
rem The keys never appear in this file or in the chat.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sign-claudefox.ps1"
if errorlevel 1 goto failed
echo.
echo Done. Run "Build friends zip.bat" to put the signed add-on in the zip.
pause
exit /b 0
:failed
echo.
echo Signing did not finish. Read the message above.
pause
exit /b 1
