@echo off
rem Claude in Zen - signs the add-on with Mozilla (unlisted, personal use).
rem Reads your keys from the WEB_EXT_API_KEY and WEB_EXT_API_SECRET user environment variables.
rem The keys never appear in this file or in the chat.
if "%WEB_EXT_API_KEY%"=="" goto nokeys
if "%WEB_EXT_API_SECRET%"=="" goto nokeys
cd /d "%~dp0extension"
echo Signing... this usually takes 1 to 5 minutes.
call npx --yes web-ext@8 sign --channel=unlisted --artifacts-dir "%~dp0signed"
echo.
echo Done if no errors above. The signed .xpi is in the "signed" folder.
echo Install it in Zen: about:addons, gear icon, Install Add-on From File.
pause
exit /b 0
:nokeys
echo The API key variables are not set. See README.md, section "Make it permanent".
pause
exit /b 1
