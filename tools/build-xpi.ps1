# Claudefox: packs extension\ into build\claudefox.xpi (zip with forward-slash paths, manifest at the root).
# -Source and -Out pack another copy instead (build-friends.ps1 packs its branded Claudefox copy).
param([string]$Source, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$src  = if ($Source) { (Resolve-Path $Source).Path.TrimEnd('\') } else { Join-Path $root 'extension' }
$out  = if ($Out) { $Out } else { Join-Path $root 'build\claudefox.xpi' }
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
if (Test-Path $out) { Remove-Item $out -Force }
# Mods made on this PC (extension\mods\<id>\) and files Claude saved (extension\output\) stay on this PC: of those two
# folders only the README goes in.
$private = { param($rel) ($rel -like 'mods/*' -and $rel -ne 'mods/README.txt') -or ($rel -like 'output/*' -and $rel -ne 'output/README.txt') }
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
$left = 0
try {
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1).Replace('\', '/')
    if (& $private $rel) { $left++; return }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }
if ($left) { Write-Host "Left out $left file(s) of local mods and saved output." }
$v = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host "Built $out (v$v)"
