# Claude in Zen: shared helpers for the install and packaging scripts. Dot-source it: . .\xpi-tools.ps1
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

function Get-SourceVersion([string]$Root) {
  (Get-Content (Join-Path $Root 'extension\manifest.json') -Raw | ConvertFrom-Json).version
}

# The version in the manifest inside an .xpi (Mozilla's signed files keep manifest.json at the root).
function Get-XpiVersion([string]$Path) {
  $zip = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $entry = $zip.GetEntry('manifest.json')
    if (-not $entry) { return $null }
    $reader = New-Object IO.StreamReader($entry.Open())
    try { return ($reader.ReadToEnd() | ConvertFrom-Json).version } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
}

# The newest signed .xpi in build\signed built from this exact version, or $null.
function Find-SignedXpi([string]$Root, [string]$Version) {
  $dir = Join-Path $Root 'build\signed'
  if (-not (Test-Path $dir)) { return $null }
  foreach ($f in (Get-ChildItem $dir -Filter *.xpi | Sort-Object LastWriteTime -Descending)) {
    try { if ((Get-XpiVersion $f.FullName) -eq $Version) { return $f.FullName } } catch {}
  }
  return $null
}

# True when a Zen profile loads the add-on straight from this folder (zen-profile\link.ps1).
function Test-Linked([string]$Root) {
  $want = (Resolve-Path (Join-Path $Root 'extension')).Path.TrimEnd('\', '/').ToLower()
  $zen = Join-Path $env:APPDATA 'zen'
  $ini = Join-Path $zen 'profiles.ini'
  if (-not (Test-Path $ini)) { return $false }
  foreach ($line in Get-Content $ini) {
    if ($line -match '^Path=(.+)$') {
      $p = $matches[1].Trim()
      $dir = if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $zen ($p -replace '/', '\') }
      $proxy = Join-Path $dir 'extensions\claude-in-zen@f.local'
      if (Test-Path $proxy) {
        if ((Get-Content $proxy -Raw).Trim().TrimEnd('\', '/').ToLower() -eq $want) { return $true }
      }
    }
  }
  return $false
}

function Find-Zen {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Zen Browser\zen.exe'),
    (Join-Path $env:LOCALAPPDATA 'Zen Browser\zen.exe')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Zen Browser\zen.exe') }
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}
