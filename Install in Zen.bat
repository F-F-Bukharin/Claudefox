@echo off
rem Claude in Zen - builds the add-on and asks Zen to install it permanently (survives restarts).
rem Needs about:config -> xpinstall.signatures.required = false once, unless you install a signed build.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-xpi.ps1"
if errorlevel 1 ( echo Build failed. & pause & exit /b 1 )
set "XPI=%~dp0claude-in-zen.xpi"
if exist "%~dp0signed\*.xpi" for /f "delims=" %%F in ('dir /b /o-d "%~dp0signed\*.xpi"') do ( set "XPI=%~dp0signed\%%F" & goto :have )
:have
echo Installing: %XPI%
start "" "C:\Program Files\Zen Browser\zen.exe" "%XPI%"
echo.
echo  Zen opens an install prompt: click Add, then Okay.
echo  If it says the add-on could not be verified, set xpinstall.signatures.required to false in about:config first.
echo  To update later, run this file again.
timeout /t 20
