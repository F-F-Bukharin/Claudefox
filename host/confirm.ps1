# Asks the user one question in a small window of its own, outside Zen, and prints "yes" when they press the yes
# button. Nothing in the add-on or the panel can reach this window, a mod included. The helper runs it with -STA.
# The question comes in environment variables (CFX_Q_TITLE, CFX_Q_TEXT, CFX_Q_YES, CFX_Q_NO), so no quoting can change
# it. The no button is the default: Enter, Esc and closing the window all say no.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Windows.Forms.Application]::EnableVisualStyles()

# An invisible owner first, as pick-folder.ps1 does: Windows applies the helper's hidden start to a process's first
# window, and the owner keeps the question in front of Zen.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()

$form = New-Object System.Windows.Forms.Form
$form.Text = if ($env:CFX_Q_TITLE) { $env:CFX_Q_TITLE } else { 'Claudefox' }
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.AutoSize = $true
$form.AutoSizeMode = 'GrowAndShrink'
$form.Padding = New-Object System.Windows.Forms.Padding(18, 16, 18, 14)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$layout = New-Object System.Windows.Forms.FlowLayoutPanel
$layout.FlowDirection = 'TopDown'
$layout.AutoSize = $true
$layout.WrapContents = $false

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ReadOnly = $true
$box.TabStop = $false
$box.ScrollBars = 'Vertical'
$box.Font = New-Object System.Drawing.Font('Consolas', 9)
$box.Width = 560
$box.Text = ($env:CFX_Q_TEXT -replace "`r?`n", "`r`n")
$box.Height = [Math]::Min(260, [System.Windows.Forms.TextRenderer]::MeasureText($box.Text, $box.Font, (New-Object System.Drawing.Size(540, 0)), [System.Windows.Forms.TextFormatFlags]::WordBreak).Height + 12)
$box.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 14)
$layout.Controls.Add($box)

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.FlowDirection = 'RightToLeft'
$buttons.AutoSize = $true
$buttons.WrapContents = $false
$buttons.Anchor = 'Right'
$buttons.Margin = New-Object System.Windows.Forms.Padding(0)

$no = New-Object System.Windows.Forms.Button
$no.Text = if ($env:CFX_Q_NO) { $env:CFX_Q_NO } else { 'No' }
$no.AutoSize = $true
$no.Padding = New-Object System.Windows.Forms.Padding(10, 3, 10, 3)
$no.DialogResult = [System.Windows.Forms.DialogResult]::No

$yes = New-Object System.Windows.Forms.Button
$yes.Text = if ($env:CFX_Q_YES) { $env:CFX_Q_YES } else { 'Yes' }
$yes.AutoSize = $true
$yes.Padding = New-Object System.Windows.Forms.Padding(10, 3, 10, 3)
$yes.DialogResult = [System.Windows.Forms.DialogResult]::Yes

$buttons.Controls.Add($no)
$buttons.Controls.Add($yes)
$layout.Controls.Add($buttons)
$form.Controls.Add($layout)
$form.AcceptButton = $no
$form.CancelButton = $no
$form.Add_Shown({ $form.Activate(); $no.Focus() | Out-Null })

$result = $form.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('yes') } else { [Console]::Out.Write('no') }
