# Claudefox: builds the zip for people outside this PC, build\friends\Claudefox-v<version>.zip. A staged copy is
# branded for Firefox (tools\brand.js turns the source's Zen into Firefox, since friends may use plain Firefox); this
# PC's own install and the source keep saying Zen. Uses a signed Claudefox .xpi from build\signed for this exact
# version if there is one, otherwise a fresh unsigned build.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'xpi-tools.ps1')
$v = Get-SourceVersion $root
$dist = Join-Path $root 'build\friends'
$stage = Join-Path $dist 'Claudefox'
New-ClaudefoxStage $root $stage

$xpi = Join-Path $stage 'claudefox.xpi'
$signed = Find-SignedXpi $root $v 'Claudefox'
if ($signed) {
  Copy-Item $signed $xpi
  # Set up Claudefox.bat then opens about:addons for a lasting install instead of about:debugging.
  Set-Content -Path (Join-Path $stage 'SIGNED') -Value "Signed by Mozilla: $(Split-Path $signed -Leaf)" -Encoding ASCII
  Write-Host "Using the signed add-on: $(Split-Path $signed -Leaf)"
} else {
  & (Join-Path $PSScriptRoot 'build-xpi.ps1') -Source (Join-Path $stage 'extension') -Out $xpi | Out-Host
  Write-Host "No signed Claudefox build for v$v in build\signed: the zip has an UNSIGNED add-on, which Firefox loads as a temporary add-on (about:debugging, START HERE.txt step 2)." -ForegroundColor Yellow
}
Remove-Item (Join-Path $stage 'extension') -Recurse -Force

$zip = Join-Path $dist "Claudefox-v$v.zip"
New-FolderZip $stage $zip
Remove-Item $stage -Recurse -Force
Write-Host "Built $zip"
