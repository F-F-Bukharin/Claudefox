# Claude in Zen: shared helpers for the install and packaging scripts. Dot-source it: . .\xpi-tools.ps1
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

function Get-SourceVersion([string]$Root) {
  (Get-Content (Join-Path $Root 'extension\manifest.json') -Raw | ConvertFrom-Json).version
}

# The manifest inside an .xpi (Mozilla's signed files keep manifest.json at the root), or $null.
function Get-XpiManifest([string]$Path) {
  $zip = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $entry = $zip.GetEntry('manifest.json')
    if (-not $entry) { return $null }
    $reader = New-Object IO.StreamReader($entry.Open())
    try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
  } finally { $zip.Dispose() }
}

function Get-XpiVersion([string]$Path) { $m = Get-XpiManifest $Path; if ($m) { return $m.version } return $null }

# The newest signed .xpi in build\signed built from this exact version, or $null. With -Name, only one whose
# add-on name matches (Claude in Zen for this PC, Claudefox for friends), so the two builds never mix.
function Find-SignedXpi([string]$Root, [string]$Version, [string]$Name) {
  $dir = Join-Path $Root 'build\signed'
  if (-not (Test-Path $dir)) { return $null }
  foreach ($f in (Get-ChildItem $dir -Filter *.xpi | Sort-Object LastWriteTime -Descending)) {
    try {
      $m = Get-XpiManifest $f.FullName
      if ($m -and $m.version -eq $Version -and (-not $Name -or $m.name -eq $Name)) { return $f.FullName }
    } catch {}
  }
  return $null
}

# A clean copy for people outside this PC, branded Claudefox (tools\brand.js): the add-on (without this PC's own mods
# and saved files: of those two folders only the READMEs go), the helper, and the friends' setup and START HERE.
# Used by build-friends.ps1 (the zip) and sign-claudefox.ps1 (what Mozilla signs). Throws when branding fails.
function New-ClaudefoxStage([string]$Root, [string]$Stage) {
  if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
  New-Item -ItemType Directory -Force (Join-Path $Stage 'host\lib'), (Join-Path $Stage 'tools') | Out-Null
  Copy-Item (Join-Path $Root 'extension') (Join-Path $Stage 'extension') -Recurse
  Get-ChildItem (Join-Path $Stage 'extension\mods') -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  Get-ChildItem (Join-Path $Stage 'extension\output') -Exclude 'README.txt' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  foreach ($f in 'claude-in-zen-host.js', 'zen-mcp.js', 'install.ps1', 'pick-folder.ps1', 'confirm.ps1') { Copy-Item (Join-Path $Root "host\$f") (Join-Path $Stage "host\$f") }
  Copy-Item (Join-Path $Root 'host\lib\*.js') (Join-Path $Stage 'host\lib')
  # Friends get the Firefox setup and instructions (friends\); Zen's own profile settings stay out.
  foreach ($f in 'Set up Claudefox.bat', 'START HERE.txt') { Copy-Item (Join-Path $Root "friends\$f") (Join-Path $Stage $f) }
  Copy-Item (Join-Path $Root 'tools\Sign in Claude Code.bat') (Join-Path $Stage 'tools\Sign in Claude Code.bat')
  # Claudefox: the name, the file names and the texts friends read. A rule that no longer matches stops here.
  & node (Join-Path $Root 'tools\brand.js') $Stage
  if ($LASTEXITCODE -ne 0) { throw 'tools\brand.js could not brand the copy (see above).' }
}

# Zips a folder, with the folder itself as the top entry and forward-slash paths as the zip standard wants. Windows
# PowerShell's Compress-Archive writes backslashes, which other unzip tools and macOS turn into odd file names.
function New-FolderZip([string]$Folder, [string]$Zip) {
  $Folder = (Resolve-Path $Folder).Path.TrimEnd('\')
  $top = Split-Path $Folder -Leaf
  if (Test-Path $Zip) { Remove-Item $Zip -Force }
  $z = [IO.Compression.ZipFile]::Open($Zip, 'Create')
  try {
    Get-ChildItem $Folder -Recurse -File | ForEach-Object {
      $rel = $top + '/' + $_.FullName.Substring($Folder.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $rel, 'Optimal') | Out-Null
    }
  } finally { $z.Dispose() }
}

# True when a Zen profile loads the add-on straight from this folder (zen-profile\link.ps1).
function Test-Linked([string]$Root) {
  $want = (Resolve-Path (Join-Path $Root 'extension')).Path.TrimEnd('\', '/').ToLower()
  $zen = Join-Path $env:APPDATA 'zen'
  $ini = Join-Path $zen 'profiles.ini'
  if (-not (Test-Path $ini)) { return $false }
  foreach ($line in Get-Content $ini) {
    if ($line -match '^Path=(.+)$') {
      $p = $matches[1].Trim()
      $dir = if ([IO.Path]::IsPathRooted($p)) { $p } else { Join-Path $zen ($p -replace '/', '\') }
      $proxy = Join-Path $dir 'extensions\claude-in-zen@f.local'
      if (Test-Path $proxy) {
        if ((Get-Content $proxy -Raw).Trim().TrimEnd('\', '/').ToLower() -eq $want) { return $true }
      }
    }
  }
  return $false
}

function Find-Zen {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Zen Browser\zen.exe'),
    (Join-Path $env:LOCALAPPDATA 'Zen Browser\zen.exe')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Zen Browser\zen.exe') }
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  return $null
}
