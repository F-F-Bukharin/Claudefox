@echo off
rem Claudefox - gets the signed friends build ready for a GitHub release (tools\prepare-release.ps1).
rem Run Sign add-on.bat first. Nothing is uploaded: the release goes on GitHub by hand, and you push.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0prepare-release.ps1"
if errorlevel 1 goto failed
echo.
pause
exit /b 0
:failed
echo.
echo  The release files were not made (see above).
pause
exit /b 1
