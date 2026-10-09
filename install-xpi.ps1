# Claude in Zen: builds the add-on and opens it in Zen for a permanent install (Zen shows its install prompt).
# Uses a signed .xpi from signed\ when its version matches extension\manifest.json, otherwise the fresh
# unsigned build (needs about:config -> xpinstall.signatures.required = false).
# Does nothing while Zen is linked to this folder: then "update" in Settings is a reload.
#   Exit codes: 0 handed to Zen, 2 linked (nothing to do), 1 error.
param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
. (Join-Path $root 'xpi-tools.ps1')

if (Test-Linked $root) {
  Write-Host 'Zen loads Claude in Zen straight from this folder (linked), so there is nothing to install.'
  Write-Host 'Use "update" in the panel Settings to load changes. For a normal install, run zen-profile\link.ps1 -Unlink first.'
  exit 2
}
try {
  $version = Get-SourceVersion $root
  & (Join-Path $root 'build-xpi.ps1') | Out-Host
  $xpi = Find-SignedXpi $root $version
  if ($xpi) { Write-Host "Using the signed build for v${version}: $(Split-Path $xpi -Leaf)" }
  else {
    $xpi = Join-Path $root 'claude-in-zen.xpi'
    Write-Host "No signed build for v$version in signed\, so using the unsigned one (needs xpinstall.signatures.required = false)."
  }
  $zen = Find-Zen
  if (-not $zen) { throw 'Could not find zen.exe. Install the .xpi yourself: about:addons, gear icon, Install Add-on From File.' }
  # Start Zen the way a double-click does, without the variables Zen hands its own child processes
  # (the helper runs this script, and Zen started the helper).
  Get-ChildItem env: | Where-Object { $_.Name -match '^(MOZ_|XRE_|XUL_|MOZILLA_)' } |
    ForEach-Object { Remove-Item "env:$($_.Name)" -ErrorAction SilentlyContinue }
  Start-Process -FilePath $zen -ArgumentList ('"{0}"' -f $xpi)
  Write-Host 'Zen is showing the install prompt: click Add, then Okay.'
  exit 0
} catch {
  Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
