# Claude in Zen: signs Claudefox (the friends build) with Mozilla, unlisted: for sharing, not listed on the add-ons
# store. It signs a clean, branded copy (New-ClaudefoxStage), so this PC's mods and saved files never leave it. The
# keys come from the WEB_EXT_API_KEY and WEB_EXT_API_SECRET user environment variables and are never printed. The
# signed .xpi lands in build\signed, where build-friends.ps1 picks it up for this version.
# -DryRun stages the copy and says what would be signed, without uploading anything.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'xpi-tools.ps1')
$v = Get-SourceVersion $root
$work = Join-Path $root 'build\sign'
$stage = Join-Path $work 'Claudefox'
New-ClaudefoxStage $root $stage
$src = Join-Path $stage 'extension'
$out = Join-Path $root 'build\signed'
$count = @(Get-ChildItem $src -Recurse -File).Count
if ($DryRun) {
  Write-Host "Dry run: would sign Claudefox v$v ($count files from $src), unlisted, into $out."
  Remove-Item $work -Recurse -Force
  exit 0
}
if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) {
  Remove-Item $work -Recurse -Force
  throw 'The API key variables are not set. See README.md, section "Mozilla API keys".'
}
New-Item -ItemType Directory -Force $out | Out-Null
Write-Host "Signing Claudefox v$v ($count files)... this usually takes 1 to 5 minutes."
Push-Location $src
try {
  & npx --yes web-ext@8 sign --channel=unlisted --artifacts-dir $out
  if ($LASTEXITCODE -ne 0) { throw "web-ext sign stopped with exit code $LASTEXITCODE (see above)." }
} finally { Pop-Location; Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host 'Signed. build\signed has the Claudefox .xpi. Run "Build friends zip.bat" to put it in the zip.'
