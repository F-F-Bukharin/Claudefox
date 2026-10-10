# Claude in Zen: packs extension\ into build\claude-in-zen.xpi (zip with forward-slash paths, manifest at the root).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'extension'
$out  = Join-Path $root 'build\claude-in-zen.xpi'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }
$v = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host "Built build\claude-in-zen.xpi (v$v)"
