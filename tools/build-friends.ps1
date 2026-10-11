# Claude in Zen: builds the zip for people outside this PC, build\friends\Claudefox-v<version>.zip. There the add-on is
# called Claudefox (tools\brand.js renames a staged copy, since friends may use plain Firefox); this PC's own install
# and the source stay Claude in Zen. Uses a signed Claudefox .xpi from build\signed for this exact version if there
# is one, otherwise a fresh unsigned build.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'xpi-tools.ps1')
$v = Get-SourceVersion $root
$dist = Join-Path $root 'build\friends'
$stage = Join-Path $dist 'Claudefox'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $stage 'host\lib'), (Join-Path $stage 'tools') | Out-Null

# A copy of the add-on to brand. Mods made on this PC and files Claude saved stay here: of those two folders only
# the READMEs go.
Copy-Item (Join-Path $root 'extension') (Join-Path $stage 'extension') -Recurse
Get-ChildItem (Join-Path $stage 'extension\mods') -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
Get-ChildItem (Join-Path $stage 'extension\output') -Exclude 'README.txt' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
foreach ($f in 'claude-in-zen-host.js', 'zen-mcp.js', 'install.ps1', 'pick-folder.ps1', 'confirm.ps1') { Copy-Item (Join-Path $root "host\$f") (Join-Path $stage "host\$f") }
Copy-Item (Join-Path $root 'host\lib\*.js') (Join-Path $stage 'host\lib')
# Friends get the Firefox setup and instructions (friends\); Zen's own profile settings stay out.
foreach ($f in 'Set up Claudefox.bat', 'START HERE.txt') { Copy-Item (Join-Path $root "friends\$f") (Join-Path $stage $f) }
Copy-Item (Join-Path $PSScriptRoot 'Sign in Claude Code.bat') (Join-Path $stage 'tools\Sign in Claude Code.bat')

# Claudefox: the name, the file names and the texts friends read. A rule that no longer matches stops the build.
& node (Join-Path $PSScriptRoot 'brand.js') $stage
if ($LASTEXITCODE -ne 0) { throw 'tools\brand.js could not brand the copy (see above), so no zip was built.' }

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
