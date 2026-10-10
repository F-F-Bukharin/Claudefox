# Claude in Zen: builds dist\claude-in-zen-friends-v<version>.zip for friends.
# Uses the signed .xpi from signed\ for this exact version if there is one, otherwise a fresh unsigned build.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'xpi-tools.ps1')
$v = Get-SourceVersion $root
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist 'Claude in Zen'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'host\lib'), (Join-Path $stage 'zen-profile') | Out-Null

$signed = Find-SignedXpi $root $v
if ($signed) {
  Copy-Item $signed (Join-Path $stage 'claude-in-zen.xpi')
  Write-Host "Using the signed add-on: $(Split-Path $signed -Leaf)"
} else {
  & (Join-Path $root 'build-xpi.ps1') | Out-Host
  Copy-Item (Join-Path $root 'claude-in-zen.xpi') (Join-Path $stage 'claude-in-zen.xpi')
  Write-Host "No signed build for v$v in signed\: the zip has an UNSIGNED add-on, so friends need xpinstall.signatures.required = false (see START HERE.txt)." -ForegroundColor Yellow
}
foreach ($f in 'claude-in-zen-host.js', 'zen-mcp.js', 'install.ps1', 'pick-folder.ps1') { Copy-Item (Join-Path $root "host\$f") (Join-Path $stage "host\$f") }
Copy-Item (Join-Path $root 'host\lib\*.js') (Join-Path $stage 'host\lib')
Copy-Item (Join-Path $root 'zen-profile\*') (Join-Path $stage 'zen-profile')
foreach ($f in 'Install helper.bat', 'Sign in Claude Code.bat', 'Apply Zen settings.bat', 'START HERE.txt') { Copy-Item (Join-Path $root $f) (Join-Path $stage $f) }

$zip = Join-Path $dist "claude-in-zen-friends-v$v.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Host "Built $zip"
