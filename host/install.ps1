# Claude in Zen: registers the helper (native messaging host) with Zen for the current user.
# No admin rights needed. Run again after moving this folder.
#   Install:   powershell -NoProfile -ExecutionPolicy Bypass -File host\install.ps1
#   Uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File host\install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$name         = 'claude_in_zen'
$addonId      = 'claude-in-zen@f.local'
$base         = Join-Path $env:LOCALAPPDATA 'claude-in-zen'
$regKey       = "HKCU:\Software\Mozilla\NativeMessagingHosts\$name"
$launcher     = Join-Path $base 'claude-in-zen-host.bat'
$manifestPath = Join-Path $base "$name.json"

if ($Uninstall) {
  if (Test-Path $regKey) { Remove-Item $regKey -Force }
  foreach ($f in @($launcher, $manifestPath)) { if (Test-Path $f) { Remove-Item $f -Force } }
  Write-Host 'Claude in Zen helper removed.'
  exit 0
}

$hostScript = Join-Path $PSScriptRoot 'claude-in-zen-host.js'
if (-not (Test-Path $hostScript)) { throw "Helper script not found: $hostScript" }

$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not $node) { throw 'Node.js was not found. Install it from https://nodejs.org, then run this again.' }

New-Item -ItemType Directory -Force $base | Out-Null

# Zen starts this launcher; it runs the helper with an absolute Node path.
[IO.File]::WriteAllText($launcher, "@echo off`r`n`"$node`" `"$hostScript`" %*`r`n", [Text.Encoding]::ASCII)

# Host manifest (UTF-8 without BOM, which Zen's JSON reader requires).
$esc = $launcher.Replace('\', '\\')
$json = @"
{
  "name": "$name",
  "description": "Claude in Zen helper",
  "path": "$esc",
  "type": "stdio",
  "allowed_extensions": ["$addonId"]
}
"@
[IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# Zen looks the manifest up here (HKCU\Software\Mozilla\NativeMessagingHosts\<name>).
New-Item -Path $regKey -Force -Value $manifestPath | Out-Null

Write-Host 'Claude in Zen helper installed.'
Write-Host "  manifest: $manifestPath"
Write-Host "  launcher: $launcher"
Write-Host "  node:     $node"
