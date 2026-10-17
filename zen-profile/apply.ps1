# Claudefox: puts zen-profile\user.js and userChrome.css into your Zen profile(s), merging with what is there.
# Our lines sit between "Claude in Zen BEGIN/END" markers (kept from before the rename: they are already in profile files), so running it again just updates them.
#   Apply:  powershell -NoProfile -ExecutionPolicy Bypass -File zen-profile\apply.ps1
#   Undo:   powershell -NoProfile -ExecutionPolicy Bypass -File zen-profile\apply.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$zen = Join-Path $env:APPDATA 'zen'
$ini = Join-Path $zen 'profiles.ini'
if (-not (Test-Path $ini)) { throw "No Zen profiles found ($ini). Open Zen once, close it, then run this again." }

# Profiles from profiles.ini (Path=..., IsRelative=1 means under %APPDATA%\zen).
$profiles = @(); $cur = @{}
foreach ($line in (Get-Content $ini) + '[end]') {
  if ($line -match '^\[') { if ($cur.Path) { $profiles += $cur }; $cur = @{} }
  elseif ($line -match '^(Path|IsRelative)=(.*)$') { $cur[$matches[1]] = $matches[2].Trim() }
}
$dirs = $profiles | ForEach-Object { if ($_.IsRelative -eq '1') { Join-Path $zen ($_.Path -replace '/', '\') } else { $_.Path } } |
  Where-Object { Test-Path $_ } | Select-Object -Unique
if (-not $dirs) { throw 'No Zen profile folder found.' }

if (Get-Process zen -ErrorAction SilentlyContinue) { Write-Host 'Zen is running: close it first, or the changes only apply after the next restart.' -ForegroundColor Yellow }

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Merge($file, $block, $comment) {
  $close = if ($comment -eq '/*') { ' */' } else { '' }
  $begin = "$comment Claude in Zen BEGIN$close"; $end = "$comment Claude in Zen END$close"   # kept: profile files already carry these lines
  $text = if (Test-Path $file) { [IO.File]::ReadAllText($file) } else { '' }
  $pattern = '(?s)\r?\n?' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end) + '\r?\n?'
  $text = [regex]::Replace($text, $pattern, "`r`n").TrimEnd()
  if (-not $Remove) { $text = ($text + "`r`n`r`n$begin`r`n" + $block.Trim() + "`r`n$end`r`n").TrimStart() }
  elseif ($text) { $text += "`r`n" }
  New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
  [IO.File]::WriteAllText($file, $text, $utf8)
}

$prefs = Get-Content (Join-Path $PSScriptRoot 'user.js') -Raw
$css   = Get-Content (Join-Path $PSScriptRoot 'userChrome.css') -Raw
foreach ($d in $dirs) {
  Merge (Join-Path $d 'user.js') $prefs '//'
  Merge (Join-Path $d 'chrome\userChrome.css') $css '/*'
  Write-Host ($(if ($Remove) { 'Removed from ' } else { 'Applied to ' }) + $d)
}
Write-Host 'Start Zen to see it.'
