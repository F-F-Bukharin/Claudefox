@echo off
rem Claudefox menu: one window for every developer step. Recommended sets everything up;
rem Custom starts with nothing ticked. Nothing runs until you tick a step and press Run.
powershell -NoProfile -ExecutionPolicy Bypass -STA -File "%~dp0menu.ps1"
if errorlevel 1 pause
