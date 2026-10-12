@echo off
rem Claude in Zen - signs the Claude Code profile used by the add-on in with your Claude account (Pro plan).
rem This profile is separate from the Claude desktop app, so the panel Claude loads none of its plugins or settings.
rem "Set up Claude in Zen.bat" runs this with /quiet, which skips the pauses.
set "CLAUDE_CONFIG_DIR=%LOCALAPPDATA%\claude-in-zen\claude"
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_AUTH_TOKEN="
if not exist "%CLAUDE_CONFIG_DIR%" mkdir "%CLAUDE_CONFIG_DIR%"
set "CLAUDE_EXE=%USERPROFILE%\.local\bin\claude.exe"
if not exist "%CLAUDE_EXE%" set "CLAUDE_EXE="
if not defined CLAUDE_EXE for /f "delims=" %%i in ('where claude.exe 2^>nul') do if not defined CLAUDE_EXE set "CLAUDE_EXE=%%i"
if not defined CLAUDE_EXE if exist "%APPDATA%\npm\claude.cmd" set "CLAUDE_EXE=%APPDATA%\npm\claude.cmd"
if not defined CLAUDE_EXE ( echo Claude Code is not installed. Install it first: https://code.claude.com/docs/en/setup & if /i not "%~1"=="/quiet" pause & exit /b 1 )
echo A browser window opens. Sign in with your Claude account and click Authorize.
echo.
"%CLAUDE_EXE%" auth login
echo.
"%CLAUDE_EXE%" auth status --text
if errorlevel 1 (
  echo.
  echo Claude Code is not signed in yet. Run this file again and click Authorize.
  if /i not "%~1"=="/quiet" pause
  exit /b 1
)
if /i "%~1"=="/quiet" exit /b 0
pause
