param(
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir "..")
$StatusDir = Join-Path $env:USERPROFILE ".codex-usage-wrapper"
$CodexStatusPath = Join-Path $StatusDir "status.json"
$ClaudeStatusPath = Join-Path $StatusDir "claude-status.json"
$HistoryDir = Join-Path $StatusDir "history"
$CodexPidPath = Join-Path $StatusDir "poller.pid"
$ClaudePidPath = Join-Path $StatusDir "claude-poller.pid"
$DashboardUrl = "http://127.0.0.1:8767"
$PollIntervalMs = 180000
$DashboardProcess = $null
$CodexPollerProcess = $null
$ClaudePollerProcess = $null

function U {
  param([string]$Hex)

  return (($Hex -split " ") | Where-Object { $_ } | ForEach-Object { [char][Convert]::ToInt32($_, 16) }) -join ""
}

function Read-JsonSafe {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  try {
    return Get-Content -LiteralPath $Path -Encoding UTF8 -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-StatusAgeText {
  param($Status)

  if ($null -eq $Status -or [string]::IsNullOrWhiteSpace($Status.captured_at)) {
    return U "AC31 C2E0 0020 AE30 B85D 0020 C5C6 C74C"
  }
  try {
    $captured = [DateTimeOffset]::Parse([string]$Status.captured_at)
    $age = [DateTimeOffset]::Now - $captured
  } catch {
    return U "AC31 C2E0 0020 AE30 B85D 0020 C5C6 C74C"
  }
  if ($age.TotalMinutes -lt 1) {
    return U "BC29 AE08 0020 AC31 C2E0"
  }
  if ($age.TotalHours -lt 1) {
    return "{0}{1}" -f [Math]::Floor($age.TotalMinutes), (U "BD84 0020 C804 0020 AC31 C2E0")
  }
  return "{0}{1} {2}{3}" -f [Math]::Floor($age.TotalHours), (U "C2DC AC04"), $age.Minutes, (U "BD84 0020 C804 0020 AC31 C2E0")
}

function Get-Limit {
  param($Status, [string]$Type)

  if ($null -eq $Status -or $null -eq $Status.limits) {
    return $null
  }
  return @($Status.limits | Where-Object { $_.type -eq $Type } | Select-Object -First 1)[0]
}

function Get-PercentText {
  param($Limit)

  if ($null -eq $Limit -or $null -eq $Limit.remaining_percent) {
    return "--"
  }
  return "{0}%" -f [int]$Limit.remaining_percent
}

function Get-ResetText {
  param($Limit)

  if ($null -eq $Limit -or [string]::IsNullOrWhiteSpace($Limit.reset_text)) {
    return U "0072 0065 0073 0065 0074 0020 C815 BCF4 0020 C5C6 C74C"
  }
  return [string]$Limit.reset_text
}

function Start-HiddenProcess {
  param([string]$FilePath, [string[]]$ArgumentList)

  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $FilePath
  $info.Arguments = ($ArgumentList | ForEach-Object {
    if ($_ -match '[\s"]') {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join " "
  $info.WorkingDirectory = [string]$Root
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  return [System.Diagnostics.Process]::Start($info)
}

function Test-KnownPollerPid {
  param([int]$ProcessId)

  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
    if ($null -eq $process -or [string]::IsNullOrWhiteSpace($process.CommandLine)) {
      return $false
    }
    return $process.CommandLine -like "*codex-status-poller.js*" -or
      $process.CommandLine -like "*claude-usage-poller.js*"
  } catch {
    return $false
  }
}

function Stop-PidFileProcess {
  param([string]$PidPath)

  if (-not (Test-Path -LiteralPath $PidPath)) {
    return
  }
  $pidText = Get-Content -LiteralPath $PidPath -Encoding UTF8 -Raw
  $oldPid = 0
  if (-not [int]::TryParse($pidText.Trim(), [ref]$oldPid)) {
    return
  }
  if ($oldPid -gt 0 -and (Test-KnownPollerPid -ProcessId $oldPid)) {
    try {
      Stop-Process -Id $oldPid -Force -ErrorAction Stop
    } catch {
    }
  }
}

function Start-Collectors {
  New-Item -ItemType Directory -Path $StatusDir -Force | Out-Null
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Stop-PidFileProcess -PidPath $CodexPidPath
  Stop-PidFileProcess -PidPath $ClaudePidPath

  $codexScript = Join-Path $Root "src\node\codex-status-poller.js"
  $claudeScript = Join-Path $Root "src\node\claude-usage-poller.js"

  $script:CodexPollerProcess = Start-HiddenProcess $node @(
    $codexScript,
    "--status-path", $CodexStatusPath,
    "--history-dir", $HistoryDir,
    "--poll-interval-ms", "$PollIntervalMs",
    "--codex-command", "codex.exe"
  )
  Set-Content -LiteralPath $CodexPidPath -Value $script:CodexPollerProcess.Id -Encoding UTF8

  $script:ClaudePollerProcess = Start-HiddenProcess $node @(
    $claudeScript,
    "--status-path", $ClaudeStatusPath,
    "--poll-interval-ms", "$PollIntervalMs",
    "--claude-command", "claude.exe"
  )
  Set-Content -LiteralPath $ClaudePidPath -Value $script:ClaudePollerProcess.Id -Encoding UTF8
}

function Stop-Collectors {
  foreach ($process in @($script:CodexPollerProcess, $script:ClaudePollerProcess)) {
    if ($null -ne $process -and -not $process.HasExited) {
      try {
        $process.Kill()
      } catch {
      }
    }
  }
  if ($null -ne $script:DashboardProcess -and -not $script:DashboardProcess.HasExited) {
    try {
      $script:DashboardProcess.Kill()
    } catch {
    }
  }
}

function Start-Dashboard {
  if ($null -eq $script:DashboardProcess -or $script:DashboardProcess.HasExited) {
    $pythonPath = Join-Path $Root "src\python"
    $script:DashboardProcess = Start-HiddenProcess "uvicorn.exe" @(
      "--app-dir", $pythonPath,
      "codex_dashboard_fastapi:app",
      "--host", "127.0.0.1",
      "--port", "8767"
    )
  }
  Start-Process $DashboardUrl | Out-Null
}

function Set-StartupRegistration {
  param([bool]$Enabled)

  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $name = "Codex Claude Usage Lite"
  if ($Enabled) {
    $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{0}"' -f $MyInvocation.MyCommand.Path
    New-ItemProperty -Path $runKey -Name $name -Value $command -PropertyType String -Force | Out-Null
  } else {
    Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
  }
}

function Test-StartupRegistration {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $value = Get-ItemProperty -Path $runKey -Name "Codex Claude Usage Lite" -ErrorAction SilentlyContinue
  return $null -ne $value
}

if ($SelfTest) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [void](Get-Command node.exe -ErrorAction Stop)
  Write-Output "native tray self-test passed"
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Start-Collectors

$font = New-Object System.Drawing.Font("Segoe UI", 9)
$smallFont = New-Object System.Drawing.Font("Segoe UI", 8)
$titleFont = New-Object System.Drawing.Font("Segoe UI Semibold", 12, [System.Drawing.FontStyle]::Bold)
$valueFont = New-Object System.Drawing.Font("Segoe UI Semibold", 20, [System.Drawing.FontStyle]::Bold)
$buttonFont = New-Object System.Drawing.Font("Segoe UI Semibold", 9, [System.Drawing.FontStyle]::Bold)
$bgColor = [System.Drawing.Color]::FromArgb(14, 18, 24)
$cardColor = [System.Drawing.Color]::FromArgb(27, 33, 43)
$mutedColor = [System.Drawing.Color]::FromArgb(156, 166, 181)
$lineColor = [System.Drawing.Color]::FromArgb(50, 60, 76)
$goodColor = [System.Drawing.Color]::FromArgb(108, 211, 148)
$warnColor = [System.Drawing.Color]::FromArgb(228, 179, 99)
$badColor = [System.Drawing.Color]::FromArgb(231, 111, 111)
$buttonColor = [System.Drawing.Color]::FromArgb(36, 44, 56)
$buttonHotColor = [System.Drawing.Color]::FromArgb(45, 56, 72)
$whiteColor = [System.Drawing.Color]::White

$form = New-Object System.Windows.Forms.Form
$form.Text = "Codex Claude Usage"
$form.Size = New-Object System.Drawing.Size(390, 456)
$form.MinimumSize = New-Object System.Drawing.Size(360, 420)
$form.StartPosition = "CenterScreen"
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.BackColor = $bgColor
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = $font

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock = "Fill"
$layout.Padding = New-Object System.Windows.Forms.Padding(16)
$layout.RowCount = 4
$layout.ColumnCount = 1
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 48))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 74))) | Out-Null
$form.Controls.Add($layout)

function New-Label {
  param(
    [string]$Text,
    [System.Drawing.Font]$UseFont = $font,
    $Color = ([System.Drawing.Color]::White)
  )
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.AutoSize = $true
  $label.Margin = New-Object System.Windows.Forms.Padding(0, 2, 0, 2)
  $label.ForeColor = $Color
  $label.Font = $UseFont
  return $label
}

function Get-ToneColor {
  param($Percent)

  if ($null -eq $Percent) {
    return $lineColor
  }
  if ([int]$Percent -le 10) {
    return $badColor
  }
  if ([int]$Percent -le 50) {
    return $warnColor
  }
  return $goodColor
}

function Get-RemainingValue {
  param($Limit)

  if ($null -eq $Limit -or $null -eq $Limit.remaining_percent) {
    return $null
  }
  return [int]$Limit.remaining_percent
}

function Set-Meter {
  param($Card, $Percent)

  $tone = Get-ToneColor $Percent
  $Card.MeterFill.BackColor = $tone
  $Card.Remaining.ForeColor = $tone
  $width = 0
  if ($null -ne $Percent -and $Card.MeterBack.Width -gt 0) {
    $width = [Math]::Max(2, [Math]::Floor($Card.MeterBack.Width * ([int]$Percent / 100)))
  }
  $Card.MeterFill.Width = $width
}

function New-Card {
  param([string]$Title, [System.Drawing.Color]$Accent)

  $panel = New-Object System.Windows.Forms.Panel
  $panel.Dock = "Fill"
  $panel.Margin = New-Object System.Windows.Forms.Padding(0, 5, 0, 8)
  $panel.Padding = New-Object System.Windows.Forms.Padding(14)
  $panel.BackColor = $cardColor

  $accentBar = New-Object System.Windows.Forms.Panel
  $accentBar.Dock = "Top"
  $accentBar.Height = 3
  $accentBar.BackColor = $Accent
  $panel.Controls.Add($accentBar)

  $cardLayout = New-Object System.Windows.Forms.TableLayoutPanel
  $cardLayout.Dock = "Fill"
  $cardLayout.ColumnCount = 2
  $cardLayout.RowCount = 6
  $cardLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 54))) | Out-Null
  $cardLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 46))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 28))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 48))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 14))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 26))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 24))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $panel.Controls.Add($cardLayout)

  $titleLabel = New-Label $Title $titleFont $Accent
  $remainingValue = New-Label "--" $valueFont $whiteColor
  $usedLabel = New-Label ((U "C0AC C6A9") + " --") $font $mutedColor
  $subLabel = New-Label "--" $font $mutedColor
  $resetLabel = New-Label (U "0072 0065 0073 0065 0074 0020 C815 BCF4 0020 C5C6 C74C") $smallFont $mutedColor
  $ageLabel = New-Label (U "AC31 C2E0 0020 AE30 B85D 0020 C5C6 C74C") $smallFont $mutedColor
  $meterBack = New-Object System.Windows.Forms.Panel
  $meterBack.Dock = "Fill"
  $meterBack.Height = 8
  $meterBack.Margin = New-Object System.Windows.Forms.Padding(0, 3, 0, 3)
  $meterBack.BackColor = [System.Drawing.Color]::FromArgb(40, 49, 63)
  $meterFill = New-Object System.Windows.Forms.Panel
  $meterFill.Dock = "Left"
  $meterFill.Width = 0
  $meterFill.BackColor = $Accent
  $meterBack.Controls.Add($meterFill)

  $cardLayout.Controls.Add($titleLabel, 0, 0)
  $cardLayout.SetColumnSpan($titleLabel, 2)
  $cardLayout.Controls.Add($remainingValue, 0, 1)
  $cardLayout.Controls.Add($usedLabel, 1, 1)
  $cardLayout.Controls.Add($meterBack, 0, 2)
  $cardLayout.SetColumnSpan($meterBack, 2)
  $cardLayout.Controls.Add($subLabel, 0, 3)
  $cardLayout.SetColumnSpan($subLabel, 2)
  $cardLayout.Controls.Add($resetLabel, 0, 4)
  $cardLayout.SetColumnSpan($resetLabel, 2)
  $cardLayout.Controls.Add($ageLabel, 0, 5)
  $cardLayout.SetColumnSpan($ageLabel, 2)

  return @{
    Panel = $panel
    Remaining = $remainingValue
    Used = $usedLabel
    Sub = $subLabel
    Reset = $resetLabel
    Age = $ageLabel
    MeterBack = $meterBack
    MeterFill = $meterFill
  }
}

$header = New-Object System.Windows.Forms.TableLayoutPanel
$header.Dock = "Fill"
$header.ColumnCount = 2
$header.RowCount = 2
$header.BackColor = $bgColor
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 62))) | Out-Null
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 38))) | Out-Null
$headerTitle = New-Label "Codex Claude Usage" $titleFont $whiteColor
$headerSub = New-Label (U "0033 BD84 B9C8 B2E4 0020 C790 B3D9 0020 AC31 C2E0") $smallFont $mutedColor
$serverBadge = New-Label (U "C11C BC84 0020 AEBC C9D0") $smallFont $goodColor
$serverBadge.TextAlign = "MiddleRight"
$serverBadge.Dock = "Fill"
$header.Controls.Add($headerTitle, 0, 0)
$header.Controls.Add($headerSub, 0, 1)
$header.Controls.Add($serverBadge, 1, 0)
$header.SetRowSpan($serverBadge, 2)
$layout.Controls.Add($header, 0, 0)

$codexCard = New-Card "Codex" $goodColor
$claudeCard = New-Card "Claude" $warnColor
$layout.Controls.Add($codexCard.Panel, 0, 1)
$layout.Controls.Add($claudeCard.Panel, 0, 2)

$controls = New-Object System.Windows.Forms.TableLayoutPanel
$controls.Dock = "Fill"
$controls.ColumnCount = 2
$controls.RowCount = 2
$controls.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$controls.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$controls.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 28))) | Out-Null
$controls.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 38))) | Out-Null
$controls.BackColor = $bgColor
$layout.Controls.Add($controls, 0, 3)

$topMost = New-Object System.Windows.Forms.CheckBox
$topMost.Text = U "D56D C0C1 0020 C704"
$topMost.Checked = $true
$topMost.ForeColor = [System.Drawing.Color]::White
$topMost.BackColor = $bgColor
$topMost.AutoSize = $true
$topMost.Add_CheckedChanged({ $form.TopMost = $topMost.Checked })
$controls.Controls.Add($topMost, 0, 0)

$startup = New-Object System.Windows.Forms.CheckBox
$startup.Text = U "C2DC C791 0020 C2DC 0020 C2E4 D589"
$startup.Checked = Test-StartupRegistration
$startup.ForeColor = [System.Drawing.Color]::White
$startup.BackColor = $bgColor
$startup.AutoSize = $true
$startup.Add_CheckedChanged({ Set-StartupRegistration -Enabled $startup.Checked })
$controls.Controls.Add($startup, 1, 0)

function New-Button {
  param([string]$Text)
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Dock = "Fill"
  $button.Margin = New-Object System.Windows.Forms.Padding(0, 5, 8, 0)
  $button.BackColor = $buttonColor
  $button.ForeColor = $whiteColor
  $button.FlatStyle = "Flat"
  $button.Font = $buttonFont
  $button.FlatAppearance.BorderColor = $lineColor
  $button.Add_MouseEnter({ param($sender, $event) $sender.BackColor = $buttonHotColor })
  $button.Add_MouseLeave({ param($sender, $event) $sender.BackColor = $buttonColor })
  return $button
}

$refreshButton = New-Button (U "C0C8 B85C ACE0 CE68")
$dashboardButton = New-Button (U "C804 CCB4 0020 BCF4 AE30")
$controls.Controls.Add($refreshButton, 0, 1)
$controls.Controls.Add($dashboardButton, 1, 1)

function Update-Ui {
  $codex = Read-JsonSafe $CodexStatusPath
  $claude = Read-JsonSafe $ClaudeStatusPath
  $codexFiveHour = Get-Limit $codex "five_hour"
  $codexWeekly = Get-Limit $codex "weekly"
  $claudeFiveHour = Get-Limit $claude "five_hour"
  $claudeSevenDay = Get-Limit $claude "seven_day"

  $codexMain = if ($codexFiveHour) { $codexFiveHour } else { $codexWeekly }
  $claudeMain = if ($claudeFiveHour) { $claudeFiveHour } else { $claudeSevenDay }

  $codexRemaining = Get-PercentText $codexMain
  $claudeRemaining = Get-PercentText $claudeMain
  $codexRemainingValue = Get-RemainingValue $codexMain
  $claudeRemainingValue = Get-RemainingValue $claudeMain
  $codexUsed = if ($codexMain -and $null -ne $codexMain.remaining_percent) { "{0}%" -f (100 - [int]$codexMain.remaining_percent) } else { "--" }
  $claudeUsed = if ($claudeMain -and $null -ne $claudeMain.used_percent) { "{0}%" -f [int]$claudeMain.used_percent } elseif ($claudeMain -and $null -ne $claudeMain.remaining_percent) { "{0}%" -f (100 - [int]$claudeMain.remaining_percent) } else { "--" }

  $codexCard.Remaining.Text = $codexRemaining
  $codexCard.Used.Text = "{0} {1}" -f (U "C0AC C6A9"), $codexUsed
  $codexCard.Sub.Text = "{0} {1}  /  {2} {3}" -f (U "0035 C2DC AC04"), (Get-PercentText $codexFiveHour), (U "C8FC AC04"), (Get-PercentText $codexWeekly)
  $codexCard.Reset.Text = "{0}  {1}" -f (U "B9AC C14B"), (Get-ResetText $codexMain)
  $codexCard.Age.Text = "{0}  {1}" -f (U "AC31 C2E0"), (Get-StatusAgeText $codex)
  Set-Meter $codexCard $codexRemainingValue

  $claudeCard.Remaining.Text = $claudeRemaining
  $claudeCard.Used.Text = "{0} {1}" -f (U "C0AC C6A9"), $claudeUsed
  $claudeCard.Sub.Text = "{0} {1}  /  {2} {3}" -f (U "C138 C158"), (Get-PercentText $claudeFiveHour), (U "C8FC AC04"), (Get-PercentText $claudeSevenDay)
  $claudeCard.Reset.Text = "{0}  {1}" -f (U "B9AC C14B"), (Get-ResetText $claudeMain)
  $claudeCard.Age.Text = "{0}  {1}" -f (U "AC31 C2E0"), (Get-StatusAgeText $claude)
  Set-Meter $claudeCard $claudeRemainingValue
}

$refreshButton.Add_Click({ Update-Ui })
$dashboardButton.Add_Click({ Start-Dashboard })

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "Codex Claude Usage"
$notify.Visible = $true
$notify.Icon = [System.Drawing.SystemIcons]::Application
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add((U "C5F4 AE30"), $null, { $form.Show(); $form.WindowState = "Normal"; $form.Activate() })
[void]$menu.Items.Add((U "B300 C2DC BCF4 B4DC"), $null, { Start-Dashboard })
[void]$menu.Items.Add((U "C885 B8CC"), $null, { $form.Close() })
$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-Ui })
$timer.Start()

$form.Add_FormClosing({
  $timer.Stop()
  $notify.Visible = $false
  Stop-Collectors
})

Update-Ui
[System.Windows.Forms.Application]::Run($form)
