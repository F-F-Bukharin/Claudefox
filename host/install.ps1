# Claudefox: registers the helper (native messaging host) with Zen for the current user.
# No admin rights needed. Run again after moving this folder.
#   Install:   powershell -NoProfile -ExecutionPolicy Bypass -File host\install.ps1
#   Uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File host\install.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$name         = 'claudefox'
$addonId      = 'claude-in-zen@f.local'
$base         = Join-Path $env:LOCALAPPDATA 'claudefox'
$regKey       = "HKCU:\Software\Mozilla\NativeMessagingHosts\$name"
$launcher     = Join-Path $base 'claudefox-host.bat'
$manifestPath = Join-Path $base "$name.json"

# The names before 0.11: the old registration, data folder, launcher and manifest.
$oldName         = 'claude_in_zen'
$oldBase         = Join-Path $env:LOCALAPPDATA 'claude-in-zen'
$oldRegKey       = "HKCU:\Software\Mozilla\NativeMessagingHosts\$oldName"
$oldLauncher     = Join-Path $oldBase 'claude-in-zen-host.bat'
$oldManifestPath = Join-Path $oldBase "$oldName.json"

if ($Uninstall) {
  foreach ($k in @($regKey, $oldRegKey)) { if (Test-Path $k) { Remove-Item $k -Force } }
  foreach ($f in @($launcher, $manifestPath, $oldLauncher, $oldManifestPath)) { if (Test-Path $f) { Remove-Item $f -Force } }
  Write-Host 'Claudefox helper removed.'
  exit 0
}

$hostScript = Join-Path $PSScriptRoot 'claudefox-host.js'
if (-not (Test-Path $hostScript)) { throw "Helper script not found: $hostScript" }

$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not $node) { throw 'Node.js was not found. Install it from https://nodejs.org, then run this again.' }

# Migration from %LOCALAPPDATA%\claude-in-zen. Files are moved, never opened or read.
#   Only the old folder exists: it is renamed to claudefox.
#   Both exist: each top-level item the new folder lacks is moved; the rest stays in the old folder, and this says so.
$left = @()
try {
  if ((Test-Path -LiteralPath $oldBase) -and -not (Test-Path -LiteralPath $base)) {
    Rename-Item -LiteralPath $oldBase -NewName 'claudefox'
    Write-Host "Moved your data from $oldBase to $base."
  } elseif (Test-Path -LiteralPath $oldBase) {
    foreach ($item in @(Get-ChildItem -LiteralPath $oldBase -Force)) {
      if (Test-Path -LiteralPath (Join-Path $base $item.Name)) { $left += $item.Name }
      else { Move-Item -LiteralPath $item.FullName -Destination (Join-Path $base $item.Name) }
    }
    if ($left.Count -gt 0) { Write-Host "Left in place in ${oldBase} (the new folder already has them): $($left -join ', ')" }
    else { Write-Host "Moved your data from $oldBase to $base." }
  }
} catch {
  throw "Could not move your data from $oldBase to $base ($($_.Exception.Message)). Close Zen (it keeps the old helper running), then run this again."
}

New-Item -ItemType Directory -Force $base | Out-Null

# Zen starts this launcher; it runs the helper with an absolute Node path.
[IO.File]::WriteAllText($launcher, "@echo off`r`n`"$node`" `"$hostScript`" %*`r`n", [Text.Encoding]::ASCII)

# Host manifest (UTF-8 without BOM, which Zen's JSON reader requires).
$esc = $launcher.Replace('\', '\\')
$json = @"
{
  "name": "$name",
  "description": "Claudefox helper",
  "path": "$esc",
  "type": "stdio",
  "allowed_extensions": ["$addonId"]
}
"@
[IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

# Registration: Zen looks the manifest up here (HKCU\Software\Mozilla\NativeMessagingHosts\<name>).
New-Item -Path $regKey -Force -Value $manifestPath | Out-Null

# The old registration goes now that the new one is in place, with the old launcher and manifest (the installer's own
# files, wherever the migration left them).
if (Test-Path $oldRegKey) { Remove-Item $oldRegKey -Force }
foreach ($dir in @($oldBase, $base)) {
  foreach ($file in @('claude-in-zen-host.bat', "$oldName.json")) {
    $p = Join-Path $dir $file
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
  }
}

Write-Host 'Claudefox helper installed.'
Write-Host "  manifest: $manifestPath"
Write-Host "  launcher: $launcher"
Write-Host "  node:     $node"
