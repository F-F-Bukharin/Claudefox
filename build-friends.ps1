# Claude in Zen: builds dist\claude-in-zen-friends-v<version>.zip for friends.
# Uses the newest signed .xpi in signed\ if there is one, otherwise a fresh unsigned build.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$v = (Get-Content (Join-Path $root 'extension\manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'Claude in Zen'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'host\lib'), (Join-Path $stage 'zen-profile') | Out-Null

$signed = Get-ChildItem (Join-Path $root 'signed') -Filter *.xpi -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($signed) {
  Copy-Item $signed.FullName (Join-Path $stage 'claude-in-zen.xpi')
  Write-Host "Using signed add-on: $($signed.Name)"
} else {
  & (Join-Path $root 'build-xpi.ps1')
  Copy-Item (Join-Path $root 'claude-in-zen.xpi') (Join-Path $stage 'claude-in-zen.xpi')
  Write-Host 'Using an UNSIGNED add-on: friends need xpinstall.signatures.required = false (see START HERE.txt).'
}
foreach ($f in 'claude-in-zen-host.js', 'zen-mcp.js', 'install.ps1') { Copy-Item (Join-Path $root "host\$f") (Join-Path $stage "host\$f") }
Copy-Item (Join-Path $root 'host\lib\*.js') (Join-Path $stage 'host\lib')
Copy-Item (Join-Path $root 'zen-profile\*') (Join-Path $stage 'zen-profile')
foreach ($f in 'Install helper.bat', 'Sign in Claude Code.bat', 'Apply Zen settings.bat', 'START HERE.txt') { Copy-Item (Join-Path $root $f) (Join-Path $stage $f) }

$zip = Join-Path $dist "claude-in-zen-friends-v$v.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Host "Built $zip"
