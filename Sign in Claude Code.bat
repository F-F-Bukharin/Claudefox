@echo off
rem Claude in Zen - signs the Claude Code profile used by the add-on in with your Claude account (Pro plan).
rem This profile is separate from the Claude desktop app, so the panel Claude loads none of its plugins or settings.
set "CLAUDE_CONFIG_DIR=%LOCALAPPDATA%\claude-in-zen\claude"
set "ANTHROPIC_API_KEY="
set "ANTHROPIC_AUTH_TOKEN="
if not exist "%CLAUDE_CONFIG_DIR%" mkdir "%CLAUDE_CONFIG_DIR%"
set "CLAUDE_EXE=%USERPROFILE%\.local\bin\claude.exe"
if not exist "%CLAUDE_EXE%" ( echo Claude Code is not installed. Install it first: https://code.claude.com/docs/en/setup & pause & exit /b 1 )
echo A browser window opens. Sign in with your Claude account and click Authorize.
echo.
"%CLAUDE_EXE%" auth login
echo.
"%CLAUDE_EXE%" auth status --text
pause
