# Claudefox: gets a signed friends build ready for a GitHub release. It needs the signed .xpi of this version
# (Sign add-on.bat) and writes build\release\v<version>\ with claudefox-<version>.xpi and the updates.json Firefox
# checks. With the public clone in .\Claudefox, it also copies the branded build there, for review and a push.
# It uploads nothing: the release goes on GitHub by hand or through the browser, and you push.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'xpi-tools.ps1')
$v = Get-SourceVersion $root
$repo = (Get-Content (Join-Path $PSScriptRoot 'release.json') -Raw | ConvertFrom-Json).repo
$updates = "https://github.com/$repo/releases/latest/download/updates.json"
$xpi = Find-SignedXpi $root $v 'Claudefox' 'friends'
if (-not $xpi) { throw "No signed Claudefox $v in build\signed. Run Sign add-on.bat first." }
$m = Get-XpiManifest $xpi
if ($m.browser_specific_settings.gecko.update_url -ne $updates) {
  throw "The signed Claudefox $v has no update address for $repo (it was signed before the GitHub link). Raise the version and sign again."
}
$out = Join-Path $root "build\release\v$v"
New-Item -ItemType Directory -Force $out | Out-Null
$name = "claudefox-$v.xpi"
Copy-Item $xpi (Join-Path $out $name) -Force
$hash = (Get-FileHash (Join-Path $out $name) -Algorithm SHA256).Hash.ToLower()
$json = @"
{
  "addons": {
    "claude-in-zen@f.local": {
      "updates": [
        {
          "version": "$v",
          "update_link": "https://github.com/$repo/releases/download/v$v/$name",
          "update_hash": "sha256:$hash"
        }
      ]
    }
  }
}
"@
[IO.File]::WriteAllText((Join-Path $out 'updates.json'), $json.Replace("`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
# The public clone: the same branded build, keeping the clone's own README, LICENSE, .gitattributes and .git.
$pub = Join-Path $root 'Claudefox'
if (Test-Path (Join-Path $pub '.git')) {
  $stage = Join-Path $root 'build\release\stage'
  New-ClaudefoxStage $root $stage
  robocopy $stage $pub /MIR /XD .git /XF README.md LICENSE .gitattributes /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Copying the build into $pub failed (robocopy $LASTEXITCODE)." }
  Remove-Item $stage -Recurse -Force
  Write-Host "The public clone in Claudefox\ has the $v build: review it there, commit and push."
}
Write-Host "Ready: build\release\v$v has $name and updates.json for the GitHub release v$v."
