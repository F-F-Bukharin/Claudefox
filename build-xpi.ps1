# Claude in Zen: packs extension\ into claude-in-zen.xpi (zip with forward-slash paths, manifest at the root).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = $PSScriptRoot
$src  = Join-Path $root 'extension'
$out  = Join-Path $root 'claude-in-zen.xpi'
if (Test-Path $out) { Remove-Item $out -Force }
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
try {
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }
$v = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host "Built claude-in-zen.xpi (v$v)"
