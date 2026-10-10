# Claude in Zen menu: one window for every developer step.
# Recommended ticks the steps most people need. Custom starts with nothing ticked.
# Nothing runs until you press Run. Then only the ticked steps run, one after another, in list order.
# Start it with "Claude in Zen menu.bat". It needs Windows PowerShell 5.1, which comes with Windows.
# Steps that run hidden write their output to the log. Steps that wait for you open their own window.

if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File $PSCommandPath
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$tools = $PSScriptRoot
$root  = Split-Path -Parent $PSScriptRoot

# ---- checks and helpers (nothing here changes anything) ---------------------

function Place($Control, [int]$X, [int]$Y, [int]$W, [int]$H) {
  $Control.Location = New-Object System.Drawing.Point($X, $Y)
  $Control.Size = New-Object System.Drawing.Size($W, $H)
  [void]$script:form.Controls.Add($Control)
}

function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  return $null
}

function Test-ZenOpen {
  return [bool](Get-Process -Name 'zen' -ErrorAction SilentlyContinue)
}

# Is Claude Code signed in for the add-on's own profile? Returns 'yes', 'no' or 'missing' (not installed).
function Test-ClaudeSignedIn {
  $exe = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (-not (Test-Path -LiteralPath $exe)) { return 'missing' }
  $keep = @{}
  foreach ($name in 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN') {
    $keep[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  try {
    $env:CLAUDE_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'claude-in-zen\claude'
    Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
    & $exe auth status --text *> $null
    if ($LASTEXITCODE -eq 0) { return 'yes' }
    return 'no'
  } catch {
    return 'no'
  } finally {
    foreach ($name in $keep.Keys) { [Environment]::SetEnvironmentVariable($name, $keep[$name], 'Process') }
  }
}

# Zen profile folders listed in profiles.ini, with the same rules as zen-profile\link.ps1. Read only.
function Get-ZenProfileDirs {
  $zen = Join-Path $env:APPDATA 'zen'
  $ini = Join-Path $zen 'profiles.ini'
  $dirs = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $ini)) { return ,@() }
  $cur = @{}
  foreach ($line in ((Get-Content -LiteralPath $ini) + '[end]')) {
    if ($line -match '^\[') {
      if ($cur.ContainsKey('Path')) {
        if ($cur['IsRelative'] -eq '1') { $dir = Join-Path $zen ($cur['Path'] -replace '/', '\') } else { $dir = $cur['Path'] }
        if (Test-Path -LiteralPath $dir) { [void]$dirs.Add($dir) }
      }
      $cur = @{}
    } elseif ($line -match '^(Path|IsRelative)=(.*)$') {
      $cur[$matches[1]] = $matches[2].Trim()
    }
  }
  return ,@($dirs | Select-Object -Unique)
}

# Does every Zen profile accept the unsigned add-on? Reads prefs.js and user.js only; changes nothing.
function Test-XpiPref {
  $dirs = @(Get-ZenProfileDirs)
  if ($dirs.Count -eq 0) {
    return @{ Status = 'needs you'; Note = 'No Zen profile was found. Open Zen once, close it, then run this step again.' }
  }
  $pattern = 'user_pref\("xpinstall\.signatures\.required",\s*false\)'
  $unset = @()
  foreach ($d in $dirs) {
    $text = ''
    foreach ($f in 'prefs.js', 'user.js') {
      $p = Join-Path $d $f
      if (Test-Path -LiteralPath $p) { $text += [System.IO.File]::ReadAllText($p) }
    }
    if ($text -notmatch $pattern) { $unset += $d }
  }
  if ($unset.Count -eq 0) {
    return @{ Status = 'done'; Note = 'Zen accepts the unsigned add-on in every profile.' }
  }
  $note = 'Not set in: ' + ($unset -join ', ') + "`r`n" +
    'Open Zen, type about:config in the address bar and accept the warning. Search for xpinstall.signatures.required and double-click it until it says false. Close Zen completely so it saves, then run this step again. This step only reads your profile.'
  return @{ Status = 'needs you'; Note = $note }
}

# Waits while Zen is open. Returns $false when the user skips the step.
function Wait-ZenClosed {
  while (Test-ZenOpen) {
    $answer = [System.Windows.Forms.MessageBox]::Show($script:form, 'Zen is open. Close every Zen window, then press OK. Cancel skips this step.', 'Claude in Zen', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Warning)
    if ($answer -ne [System.Windows.Forms.DialogResult]::OK) { return $false }
  }
  return $true
}

# A job that runs a PowerShell script hidden. Ok lists the exit codes that count as success.
function New-PsJob([string]$File, [string]$Extra, [int[]]$Ok) {
  $line = '-NoProfile -ExecutionPolicy Bypass -File "' + $File + '"'
  if ($Extra) { $line += ' ' + $Extra }
  return @{ Exe = 'powershell.exe'; Args = $line; Visible = $false; Dir = $root; Ok = $Ok }
}

# A job that runs a .bat in its own window, for sign-ins and anything that waits for a key.
function New-BatJob([string]$File, [string]$Extra) {
  return @{ Exe = $File; Args = $Extra; Visible = $true; Dir = (Split-Path -Parent $File); Ok = @(0) }
}

# A job that runs node on a script, hidden.
function New-NodeJob([string]$File) {
  $exe = Find-Node
  if (-not $exe) { $exe = 'node.exe' }
  return @{ Exe = $exe; Args = '"' + $File + '"'; Visible = $false; Dir = $root; Ok = @(0) }
}

# ---- the steps. Recommended ticks the first five. ---------------------------

$script:steps = @(
  @{
    Title = 'Install the helper'
    Recommended = $true
    NeedsZen = $false
    Detail = 'Registers the helper that lets the add-on start Claude Code, for this Windows user only (no admin). Makes: %LOCALAPPDATA%\claude-in-zen (the launcher and the manifest). Needs Node.js.'
    Jobs = @( (New-PsJob (Join-Path $root 'host\install.ps1') '' @(0)) )
  },
  @{
    Title = 'Sign in to Claude Code'
    Recommended = $true
    NeedsZen = $false
    Detail = 'Checks first, and skips when you are already signed in. Otherwise a window opens: sign in with your Claude account (Pro plan) and click Authorize. Makes: %LOCALAPPDATA%\claude-in-zen\claude, the add-on''s own Claude Code profile.'
    Before = {
      $r = Test-ClaudeSignedIn
      if ($r -eq 'yes') { return @{ Status = 'done'; Note = 'Already signed in.' } }
      if ($r -eq 'missing') { return @{ Status = 'failed'; Note = 'Claude Code is not installed (code.claude.com/docs/en/setup). Install it, then run this step again.' } }
      return $null
    }
    Jobs = @( (New-BatJob (Join-Path $tools 'Sign in Claude Code.bat') '/quiet') )
  },
  @{
    Title = 'Check that Zen accepts the add-on'
    Recommended = $true
    NeedsZen = $false
    Detail = 'Reads your Zen profile and changes nothing. The add-on is not signed while you develop, so Zen needs xpinstall.signatures.required set to false. This step says whether it is, and how to set it.'
    Sync = { Test-XpiPref }
    Jobs = @()
  },
  @{
    Title = 'Link the add-on to Zen, and apply the Zen settings'
    Recommended = $true
    NeedsZen = $true
    Detail = 'Zen loads the add-on from this folder, so Update in Settings just reloads it. Also docks the sidebar on the right and sets the panel width. Makes: an extensions link in each Zen profile. Zen must be closed.'
    Jobs = @(
      (New-PsJob (Join-Path $root 'zen-profile\link.ps1') '' @(0)),
      (New-PsJob (Join-Path $root 'zen-profile\apply.ps1') '' @(0))
    )
  },
  @{
    Title = 'Run the tests'
    Recommended = $true
    NeedsZen = $false
    Detail = 'Runs every test file. The two DOM tests need jsdom and skip without it. The output goes to the log. Needs Node.js.'
    Before = {
      if (Find-Node) { return $null }
      return @{ Status = 'failed'; Note = 'Node.js was not found. Install it from nodejs.org, then run this step again.' }
    }
    Jobs = @( (New-NodeJob (Join-Path $root 'test\run-all.js')) )
  },
  @{
    Title = 'Apply the Zen settings only'
    Recommended = $false
    NeedsZen = $true
    Detail = 'The sidebar on the right and the panel width, through user.js and userChrome.css in each Zen profile, without linking the add-on. Step 4 already does this. Zen must be closed.'
    Jobs = @( (New-PsJob (Join-Path $root 'zen-profile\apply.ps1') '' @(0)) )
  },
  @{
    Title = 'Build the add-on file (.xpi)'
    Recommended = $false
    NeedsZen = $false
    Detail = 'Packs extension\ into build\claude-in-zen.xpi. Makes: the build folder.'
    Jobs = @( (New-PsJob (Join-Path $tools 'build-xpi.ps1') '' @(0)) )
  },
  @{
    Title = 'Install the add-on in Zen (not linked)'
    Recommended = $false
    NeedsZen = $false
    Detail = 'Builds the file and opens Zen''s install prompt: click Add, then Okay. Does nothing while Zen is linked to this folder (step 4). Uses the signed build for this version when there is one. Makes: the build folder.'
    Jobs = @( (New-PsJob (Join-Path $tools 'install-xpi.ps1') '' @(0, 2)) )
  },
  @{
    Title = 'Sign the add-on with Mozilla'
    Recommended = $false
    NeedsZen = $false
    Detail = 'Needs the WEB_EXT_API_KEY and WEB_EXT_API_SECRET variables (README, Mozilla API keys). Opens its own window: press a key there when it says done. Takes 1 to 5 minutes. Makes: build\signed.'
    Before = {
      if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) {
        return @{ Status = 'skipped'; Note = 'The API key variables are not set in this session. Set them (README, Mozilla API keys), then open this menu again.' }
      }
      return $null
    }
    Jobs = @( (New-BatJob (Join-Path $tools 'Sign add-on.bat') '') )
  },
  @{
    Title = 'Build the zip for friends'
    Recommended = $false
    NeedsZen = $false
    Detail = 'Writes build\friends\claude-in-zen-friends-v<version>.zip, with the signed build for this version when there is one (otherwise an unsigned one, and the log says so). Friends get the setup file, not this menu.'
    Jobs = @( (New-PsJob (Join-Path $tools 'build-friends.ps1') '' @(0)) )
  },
  @{
    Title = 'Load the add-on in Zen for testing'
    Recommended = $false
    NeedsZen = $false
    Detail = 'Builds the file and opens Zen''s loader. Temporary: the add-on is gone when Zen restarts. Opens its own window, which closes by itself after 15 seconds.'
    Jobs = @( (New-BatJob (Join-Path $tools 'Load in Zen.bat') '') )
  },
  @{
    Title = 'Unlink Zen from this folder'
    Recommended = $false
    NeedsZen = $true
    Detail = 'Undoes step 4 in each Zen profile. Zen must be closed. Install the file again with the install step if you want the add-on back.'
    Jobs = @( (New-PsJob (Join-Path $root 'zen-profile\link.ps1') '-Unlink' @(0)) )
  },
  @{
    Title = 'Remove the Zen settings'
    Recommended = $false
    NeedsZen = $true
    Detail = 'Takes out the lines the menu added to user.js and userChrome.css in each Zen profile, and keeps everything else. Zen must be closed.'
    Jobs = @( (New-PsJob (Join-Path $root 'zen-profile\apply.ps1') '-Remove' @(0)) )
  },
  @{
    Title = 'Remove the helper'
    Recommended = $false
    NeedsZen = $false
    Detail = 'Removes the helper registration and its launcher from %LOCALAPPDATA%\claude-in-zen. Claude Code keeps its sign-in.'
    Jobs = @( (New-PsJob (Join-Path $root 'host\install.ps1') '-Uninstall' @(0)) )
  }
)

# ---- running the ticked steps: a timer watches each process, so the window keeps working -----

$script:running = $false
$script:stopAsked = $false
$script:queue = New-Object System.Collections.ArrayList
$script:qi = 0
$script:cur = $null
$script:results = New-Object System.Collections.ArrayList
$script:proc = $null
$script:outFile = ''
$script:errFile = ''
$script:outPos = [long]0
$script:errPos = [long]0

function Set-Status([string]$Text) {
  $script:statusLabel.Text = $Text
}

function Add-Log([string]$Text) {
  $script:log.AppendText(($Text -replace "\r?\n", "`r`n"))
  $script:log.SelectionStart = $script:log.TextLength
  $script:log.ScrollToCaret()
}

function Write-Log([string]$Text) {
  Add-Log ($Text + "`r`n")
}

function Set-Busy([bool]$Busy) {
  $script:running = $Busy
  $script:runButton.Enabled = (-not $Busy)
  $script:stopButton.Enabled = $Busy
  $script:list.Enabled = (-not $Busy)
  $script:rbRec.Enabled = (-not $Busy)
  $script:rbCus.Enabled = (-not $Busy)
}

function Set-Preset([bool]$Recommended) {
  for ($i = 0; $i -lt $script:steps.Count; $i++) {
    $on = $Recommended -and [bool]$script:steps[$i].Recommended
    $script:list.SetItemChecked($i, $on)
  }
}

function Show-Detail {
  $i = $script:list.SelectedIndex
  if ($i -ge 0) { $script:detail.Text = [string]$script:steps[$i].Detail }
}

function Show-ZenState {
  if (Test-ZenOpen) {
    $script:zenLabel.Text = 'Zen is open. Steps marked "close Zen first" wait until it is closed.'
  } else {
    $script:zenLabel.Text = 'Zen is closed.'
  }
}

function Start-Run {
  if ($script:running) { return }
  $script:queue = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $script:steps.Count; $i++) {
    if ($script:list.GetItemChecked($i)) {
      $def = $script:steps[$i]
      [void]$script:queue.Add(@{ Def = $def; Title = $def.Title; Jobs = @($def.Jobs); Ji = 0; Failed = $false; Status = $null })
    }
  }
  if ($script:queue.Count -eq 0) {
    Set-Status 'Nothing is ticked. Tick a step, then press Run.'
    return
  }
  $script:qi = 0
  $script:cur = $null
  $script:stopAsked = $false
  $script:results = New-Object System.Collections.ArrayList
  Set-Busy $true
  Write-Log ''
  Write-Log ('Run started at ' + (Get-Date -Format 'HH:mm:ss') + ': ' + $script:queue.Count + ' step(s).')
  Set-Status 'Running...'
  try {
    Continue-Run
  } catch {
    Write-Log ('Unexpected error: ' + $_.Exception.Message)
    Finish-Run
  }
}

# Moves forward: starts the next job of the current step, or closes it and begins the next step.
function Continue-Run {
  while ($true) {
    if ($null -ne $script:cur -and -not $script:cur.Failed -and $script:cur.Ji -lt $script:cur.Jobs.Count) {
      $job = $script:cur.Jobs[$script:cur.Ji]
      if (Start-JobProcess $job) { return }
      $script:cur.Failed = $true
    }
    if ($null -ne $script:cur) {
      Close-Step
      $script:cur = $null
    }
    if ($script:stopAsked -and $script:qi -lt $script:queue.Count) {
      Write-Log ('Stopped. ' + ($script:queue.Count - $script:qi) + ' step(s) were not started.')
      Finish-Run
      return
    }
    if ($script:qi -ge $script:queue.Count) {
      Finish-Run
      return
    }
    $script:cur = $script:queue[$script:qi]
    $script:qi = $script:qi + 1
    Begin-Step
  }
}

# Starts a step: runs its checks and its Sync part, or leaves its jobs to run.
function Begin-Step {
  $s = $script:cur
  Write-Log ''
  Write-Log ('== ' + $s.Title)
  if ($s.Def.NeedsZen -and -not (Wait-ZenClosed)) {
    $s.Status = 'skipped'
    $s.Jobs = @()
    Write-Log '   Zen is still open, so this step was skipped.'
    return
  }
  if ($s.Def.Sync) {
    $r = & $s.Def.Sync
    $s.Status = $r.Status
    $s.Jobs = @()
    Write-Log ('   ' + $r.Note)
    return
  }
  if ($s.Def.Before) {
    $r = & $s.Def.Before
    if ($r) {
      $s.Status = $r.Status
      $s.Jobs = @()
      Write-Log ('   ' + $r.Note)
    }
  }
}

function Start-JobProcess($job) {
  $script:outFile = ''
  $script:errFile = ''
  $script:outPos = [long]0
  $script:errPos = [long]0
  try {
    $sp = @{ FilePath = $job.Exe; WorkingDirectory = $job.Dir; PassThru = $true }
    if ($job.Args) { $sp['ArgumentList'] = $job.Args }
    if (-not $job.Visible) {
      $id = [guid]::NewGuid().ToString('N')
      $script:outFile = Join-Path $env:TEMP ('claude-in-zen-menu-' + $id + '.out.txt')
      $script:errFile = Join-Path $env:TEMP ('claude-in-zen-menu-' + $id + '.err.txt')
      $sp['WindowStyle'] = 'Hidden'
      $sp['RedirectStandardOutput'] = $script:outFile
      $sp['RedirectStandardError'] = $script:errFile
    }
    $script:proc = Start-Process @sp
  } catch {
    Write-Log ('   Could not start it: ' + $_.Exception.Message)
    return $false
  }
  $script:timer.Start()
  return $true
}

function Watch-Job {
  $script:timer.Stop()
  try {
    Copy-JobOutput
    if (-not $script:proc.HasExited) { $script:timer.Start(); return }
    Copy-JobOutput
    $code = $script:proc.ExitCode
    $job = $script:cur.Jobs[$script:cur.Ji]
    if ($job.Ok -contains $code) {
      Write-Log ('   finished (exit code ' + $code + ')')
      $script:cur.Ji = $script:cur.Ji + 1
    } else {
      Write-Log ('   failed (exit code ' + $code + ')')
      $script:cur.Failed = $true
    }
    Remove-JobFiles
    $script:proc = $null
    Continue-Run
  } catch {
    Write-Log ('Unexpected error: ' + $_.Exception.Message)
    Remove-JobFiles
    $script:proc = $null
    if ($null -ne $script:cur) { Close-Step; $script:cur = $null }
    Finish-Run
  }
}

function Copy-JobOutput {
  if ($script:outFile) {
    $r = Get-NewText $script:outFile $script:outPos
    $script:outPos = $r.Pos
    $t = $r.Text -replace '(\r?\n)+$', ''
    if ($t) { Write-Log $t }
  }
  if ($script:errFile) {
    $r = Get-NewText $script:errFile $script:errPos
    $script:errPos = $r.Pos
    $t = $r.Text -replace '(\r?\n)+$', ''
    if ($t) { Write-Log $t }
  }
}

# The text a file gained since byte $From; reads while the process still writes to it.
function Get-NewText([string]$Path, [long]$From) {
  $result = @{ Text = ''; Pos = $From }
  try {
    $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $len = $fs.Length
      if ($len -gt $From) {
        [void]$fs.Seek($From, [System.IO.SeekOrigin]::Begin)
        $buf = [byte[]]::new([int]($len - $From))
        $n = $fs.Read($buf, 0, $buf.Length)
        $result = @{ Text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $n); Pos = $From + $n }
      }
    } finally {
      $fs.Dispose()
    }
  } catch {
    $result = @{ Text = ''; Pos = $From }
  }
  return $result
}

function Remove-JobFiles {
  foreach ($f in @($script:outFile, $script:errFile)) {
    if ($f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  }
  $script:outFile = ''
  $script:errFile = ''
}

function Close-Step {
  $s = $script:cur
  $status = $s.Status
  if (-not $status) {
    if ($s.Failed) { $status = 'failed' } else { $status = 'done' }
  }
  $s.Status = $status
  [void]$script:results.Add($s)
  Write-Log ('   result: ' + $status)
}

function Finish-Run {
  if ($null -ne $script:cur) { Close-Step; $script:cur = $null }
  Write-Log ''
  Write-Log 'Summary:'
  $counts = @{}
  foreach ($r in $script:results) {
    Write-Log ('   ' + $r.Status.PadRight(10) + $r.Title)
    if ($counts.ContainsKey($r.Status)) { $counts[$r.Status] = $counts[$r.Status] + 1 } else { $counts[$r.Status] = 1 }
  }
  $parts = @()
  foreach ($k in 'done', 'needs you', 'skipped', 'failed') {
    if ($counts.ContainsKey($k)) { $parts += ($k + ': ' + $counts[$k]) }
  }
  $summary = 'nothing ran'
  if ($parts.Count -gt 0) { $summary = $parts -join ', ' }
  Set-Busy $false
  $script:stopAsked = $false
  Set-Status ('Finished. ' + $summary + '.')
}

# ---- the window -------------------------------------------------------------------

$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'Claude in Zen'
$script:form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$script:form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$script:form.MaximizeBox = $false
$script:form.ClientSize = New-Object System.Drawing.Size(600, 700)
$script:form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Claude in Zen setup'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
Place $title 16 12 568 30

$intro = New-Object System.Windows.Forms.Label
$intro.Text = 'Recommended ticks the steps most people need. Custom starts with nothing ticked, so nothing is installed, changed or created until you tick a step and press Run. Ticked steps run in list order. Click a step to read what it does and what it makes.'
Place $intro 16 46 568 48

$script:rbRec = New-Object System.Windows.Forms.RadioButton
$script:rbRec.Text = 'Recommended: set everything up'
Place $script:rbRec 16 100 270 24

$script:rbCus = New-Object System.Windows.Forms.RadioButton
$script:rbCus.Text = 'Custom: I pick each step'
Place $script:rbCus 290 100 270 24

$script:list = New-Object System.Windows.Forms.CheckedListBox
$script:list.CheckOnClick = $true
$script:list.IntegralHeight = $false
Place $script:list 16 128 568 252
foreach ($step in $script:steps) {
  $label = [string]$step.Title
  if ($step.NeedsZen) { $label += '   (close Zen first)' }
  [void]$script:list.Items.Add($label)
}

$script:detail = New-Object System.Windows.Forms.Label
$script:detail.Text = 'Click a step to read what it does.'
Place $script:detail 16 388 568 46

$script:runButton = New-Object System.Windows.Forms.Button
$script:runButton.Text = 'Run the ticked steps'
Place $script:runButton 16 442 200 32

$script:stopButton = New-Object System.Windows.Forms.Button
$script:stopButton.Text = 'Stop after this step'
$script:stopButton.Enabled = $false
Place $script:stopButton 224 442 160 32

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = 'Close'
Place $closeButton 452 442 132 32

$script:zenLabel = New-Object System.Windows.Forms.Label
Place $script:zenLabel 16 484 568 20

$script:statusLabel = New-Object System.Windows.Forms.Label
$script:statusLabel.Text = 'Ready. Nothing has run yet.'
Place $script:statusLabel 16 506 568 20

$script:log = New-Object System.Windows.Forms.TextBox
$script:log.Multiline = $true
$script:log.ReadOnly = $true
$script:log.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
$script:log.Font = New-Object System.Drawing.Font('Consolas', 9)
Place $script:log 16 530 568 150

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 400
$script:timer.Add_Tick({ Watch-Job })

$script:zenTimer = New-Object System.Windows.Forms.Timer
$script:zenTimer.Interval = 3000
$script:zenTimer.Add_Tick({ Show-ZenState })

$script:list.Add_SelectedIndexChanged({ Show-Detail })
$script:rbRec.Add_CheckedChanged({ if ($script:rbRec.Checked) { Set-Preset $true } })
$script:rbCus.Add_CheckedChanged({ if ($script:rbCus.Checked) { Set-Preset $false } })
$script:runButton.Add_Click({ Start-Run })
$script:stopButton.Add_Click({ $script:stopAsked = $true; Set-Status 'Stopping after the step that is running...' })
$closeButton.Add_Click({ $script:form.Close() })

$script:form.Add_Shown({
  $script:rbRec.Checked = $true
  Set-Preset $true
  Show-ZenState
  $script:zenTimer.Start()
})

$script:form.Add_FormClosing({
  param($sender, $e)
  if ($script:running) {
    $e.Cancel = $true
    Set-Status 'A step is running. Press Stop and wait for it to finish before you close this window.'
  }
})

$script:form.Add_FormClosed({ $script:timer.Stop(); $script:zenTimer.Stop() })

[void][System.Windows.Forms.Application]::Run($script:form)
