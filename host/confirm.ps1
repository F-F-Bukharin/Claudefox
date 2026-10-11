# Asks the user one question in a small window of its own, outside Zen, and prints "yes" when they press the yes
# button. Nothing in the add-on or the panel can reach this window, a mod included. The helper runs it with -STA.
# The question comes in environment variables (CIZ_Q_TITLE, CIZ_Q_TEXT, CIZ_Q_YES, CIZ_Q_NO), so no quoting can change
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
$form.Text = if ($env:CIZ_Q_TITLE) { $env:CIZ_Q_TITLE } else { 'Claude in Zen' }
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

$label = New-Object System.Windows.Forms.Label
$label.Text = ($env:CIZ_Q_TEXT -replace "`r?`n", "`r`n")
$label.AutoSize = $true
$label.MaximumSize = New-Object System.Drawing.Size(560, 0)
$label.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 14)
$layout.Controls.Add($label)

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.FlowDirection = 'RightToLeft'
$buttons.AutoSize = $true
$buttons.WrapContents = $false
$buttons.Anchor = 'Right'
$buttons.Margin = New-Object System.Windows.Forms.Padding(0)

$no = New-Object System.Windows.Forms.Button
$no.Text = if ($env:CIZ_Q_NO) { $env:CIZ_Q_NO } else { 'No' }
$no.AutoSize = $true
$no.Padding = New-Object System.Windows.Forms.Padding(10, 3, 10, 3)
$no.DialogResult = [System.Windows.Forms.DialogResult]::No

$yes = New-Object System.Windows.Forms.Button
$yes.Text = if ($env:CIZ_Q_YES) { $env:CIZ_Q_YES } else { 'Yes' }
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
