# Claude in Zen: links Zen straight to this project's extension\ folder (developer install).
# Zen then loads the add-on from the folder, so "update" in Settings is just a reload: no .xpi, no install prompt,
# no restart. Needs xpinstall.signatures.required = false. Close Zen first.
#   Link:    powershell -NoProfile -ExecutionPolicy Bypass -File zen-profile\link.ps1
#   Unlink:  powershell -NoProfile -ExecutionPolicy Bypass -File zen-profile\link.ps1 -Unlink   (then install the .xpi again)
param([switch]$Unlink)
$ErrorActionPreference = 'Stop'
$id  = 'claude-in-zen@f.local'
$src = (Resolve-Path (Join-Path $PSScriptRoot '..\extension')).Path.TrimEnd('\') + '\'
if (-not (Test-Path (Join-Path $src 'manifest.json'))) { throw "No manifest.json in $src" }

if (Get-Process zen -ErrorAction SilentlyContinue) {
  Write-Host 'Zen is running. Close it completely (all windows), then run this again.' -ForegroundColor Yellow
  exit 1
}
$zen = Join-Path $env:APPDATA 'zen'
$ini = Join-Path $zen 'profiles.ini'
if (-not (Test-Path $ini)) { throw "No Zen profiles found ($ini)." }
$profiles = @(); $cur = @{}
foreach ($line in (Get-Content $ini) + '[end]') {
  if ($line -match '^\[') { if ($cur.Path) { $profiles += $cur }; $cur = @{} }
  elseif ($line -match '^(Path|IsRelative)=(.*)$') { $cur[$matches[1]] = $matches[2].Trim() }
}
$dirs = $profiles | ForEach-Object { if ($_.IsRelative -eq '1') { Join-Path $zen ($_.Path -replace '/', '\') } else { $_.Path } } |
  Where-Object { Test-Path $_ } | Select-Object -Unique

foreach ($d in $dirs) {
  $ext = Join-Path $d 'extensions'
  $proxy = Join-Path $ext $id
  $xpi = Join-Path $ext "$id.xpi"
  if ($Unlink) {
    if (Test-Path $proxy) { Remove-Item $proxy -Force; Write-Host "Unlinked in $d" }
    continue
  }
  New-Item -ItemType Directory -Force $ext | Out-Null
  if (Test-Path $xpi) { Remove-Item $xpi -Force }   # the packed copy; the link replaces it
  [IO.File]::WriteAllText($proxy, $src, (New-Object System.Text.ASCIIEncoding))
  Write-Host "Linked in $d"
  Write-Host "  -> $src"
}
if (-not $Unlink) {
  Write-Host ''
  Write-Host 'Start Zen. If it says a new add-on was added, enable it (or about:addons -> Claude in Zen -> Enable).'
  Write-Host 'After that, use "update" in the panel Settings to load changes.'
}
