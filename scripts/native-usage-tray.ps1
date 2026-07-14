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
$AppIconPath = Join-Path $Root "assets\codex-claude-usage.ico"
$DefaultPollIntervalMs = 60000
function Get-PollIntervalMs {
  param([string]$SpecificValue, [string]$FallbackValue)

  foreach ($candidate in @($SpecificValue, $FallbackValue)) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    $parsedPollIntervalMs = 0
    if ([int]::TryParse($candidate, [ref]$parsedPollIntervalMs) -and $parsedPollIntervalMs -gt 0) {
      return $parsedPollIntervalMs
    }
  }
  return $DefaultPollIntervalMs
}
$CodexPollIntervalMs = Get-PollIntervalMs $env:CODEX_USAGE_CODEX_POLL_INTERVAL_MS $env:CODEX_USAGE_POLL_INTERVAL_MS
$ClaudePollIntervalMs = Get-PollIntervalMs $env:CODEX_USAGE_CLAUDE_POLL_INTERVAL_MS $env:CODEX_USAGE_POLL_INTERVAL_MS
$DashboardProcess = $null
$CodexPollerProcess = $null
$ClaudePollerProcess = $null
$ExitRequested = $false
$AppScriptPath = if (-not [string]::IsNullOrWhiteSpace($PSCommandPath)) {
  [string](Resolve-Path -LiteralPath $PSCommandPath)
} else {
  [string](Resolve-Path -LiteralPath $MyInvocation.MyCommand.Path)
}

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

function Get-UsageWindow {
  param($Status, [string]$Window)

  if ($null -eq $Status -or $null -eq $Status.usage_windows) {
    return $null
  }
  return @($Status.usage_windows | Where-Object { $_.window -eq $Window } | Select-Object -First 1)[0]
}

function Get-UsageWindowText {
  param($UsageWindow)

  if ($null -eq $UsageWindow -or $null -eq $UsageWindow.requests) {
    return "--"
  }
  return "{0} req" -f [int]$UsageWindow.requests
}

function Get-ResetText {
  param($Limit)

  if ($null -eq $Limit -or [string]::IsNullOrWhiteSpace($Limit.reset_text)) {
    return U "0072 0065 0073 0065 0074 0020 C815 BCF4 0020 C5C6 C74C"
  }
  return [string]$Limit.reset_text
}

function Get-FirstResetText {
  param($Limits)

  foreach ($limit in @($Limits)) {
    if ($null -ne $limit -and -not [string]::IsNullOrWhiteSpace($limit.reset_text)) {
      return [string]$limit.reset_text
    }
  }
  return U "0072 0065 0073 0065 0074 0020 C815 BCF4 0020 C5C6 C74C"
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

function Test-DashboardReady {
  try {
    $response = Invoke-WebRequest -Uri "$DashboardUrl/status.json" -UseBasicParsing -TimeoutSec 1
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-DashboardReady {
  param([int]$TimeoutMs = 8000)

  $deadline = [DateTimeOffset]::Now.AddMilliseconds($TimeoutMs)
  while ([DateTimeOffset]::Now -lt $deadline) {
    if (Test-DashboardReady) {
      return $true
    }
    if ($null -ne $script:DashboardProcess -and $script:DashboardProcess.HasExited) {
      return $false
    }
    Start-Sleep -Milliseconds 250
  }
  return Test-DashboardReady
}

function Show-DashboardError {
  param([string]$Message)

  [System.Windows.Forms.MessageBox]::Show(
    $form,
    $Message,
    "Dashboard",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  ) | Out-Null
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
  param([switch]$Immediate)

  New-Item -ItemType Directory -Path $StatusDir -Force | Out-Null
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Stop-PidFileProcess -PidPath $CodexPidPath
  Stop-PidFileProcess -PidPath $ClaudePidPath

  $codexScript = Join-Path $Root "src\node\codex-status-poller.js"
  $claudeScript = Join-Path $Root "src\node\claude-usage-poller.js"

  $codexArgs = @(
    $codexScript,
    "--status-path", $CodexStatusPath,
    "--history-dir", $HistoryDir,
    "--poll-interval-ms", "$CodexPollIntervalMs",
    "--codex-command", "codex.exe"
  )
  if ($Immediate) {
    $codexArgs += @("--startup-delay-ms", "0")
  }
  $script:CodexPollerProcess = Start-HiddenProcess $node $codexArgs
  Set-Content -LiteralPath $CodexPidPath -Value $script:CodexPollerProcess.Id -Encoding UTF8

  $claudeArgs = @(
    $claudeScript,
    "--status-path", $ClaudeStatusPath,
    "--poll-interval-ms", "$ClaudePollIntervalMs",
    "--claude-command", "claude.exe"
  )
  if ($Immediate) {
    $claudeArgs += @("--startup-delay-ms", "0")
  }
  $script:ClaudePollerProcess = Start-HiddenProcess $node $claudeArgs
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
  try {
    if (-not (Test-DashboardReady)) {
      if ($null -eq $script:DashboardProcess -or $script:DashboardProcess.HasExited) {
        $pythonPath = Join-Path $Root "src\python"
        $script:DashboardProcess = Start-HiddenProcess "uvicorn.exe" @(
          "--app-dir", $pythonPath,
          "codex_dashboard_fastapi:app",
          "--host", "127.0.0.1",
          "--port", "8767"
        )
      }
      if (-not (Wait-DashboardReady)) {
        Show-DashboardError "Dashboard server did not start. Check that uvicorn is installed and port 8767 is available."
        return
      }
    }
    Start-Process $DashboardUrl | Out-Null
  } catch {
    Show-DashboardError ("Dashboard could not be opened. {0}" -f $_.Exception.Message)
  }
}

function Start-VisibleCommand {
  param([string]$Command)

  Start-Process "powershell.exe" -ArgumentList @("-NoExit", "-Command", $Command) | Out-Null
}

function Test-CommandAvailable {
  param([string]$Command)

  return $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Get-ClaudeSettingsPath {
  return Join-Path $env:USERPROFILE ".claude\settings.json"
}

function Get-ClaudeHookPath {
  return Join-Path $Root "src\node\claude-status-hook.js"
}

function Test-ClaudeHookInstalled {
  $settingsPath = Get-ClaudeSettingsPath
  $hookPath = Get-ClaudeHookPath
  $settings = Read-JsonSafe $settingsPath
  if ($null -eq $settings -or $null -eq $settings.statusLine -or [string]::IsNullOrWhiteSpace($settings.statusLine.command)) {
    return $false
  }
  $normalizedCommand = ([string]$settings.statusLine.command).Replace("/", "\").ToLowerInvariant()
  return $normalizedCommand.Contains("claude-status-hook.js") -or $normalizedCommand.Contains($hookPath.ToLowerInvariant())
}

function Install-ClaudeHook {
  try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $hookPath = Get-ClaudeHookPath
    $settingsPath = Get-ClaudeSettingsPath
    $process = Start-HiddenProcess $node @(
      $hookPath,
      "--install",
      "--settings-path", $settingsPath
    )
    $process.WaitForExit(5000) | Out-Null
    if ($process.ExitCode -eq 0) {
      [System.Windows.Forms.MessageBox]::Show((U "0043 006C 0061 0075 0064 0065 0020 0068 006F 006F 006B 0020 C124 CE58 AC00 0020 C644 B8CC B418 C5C8 C2B5 B2C8 002E"), "Codex Claude Usage") | Out-Null
    } else {
      [System.Windows.Forms.MessageBox]::Show((U "0043 006C 0061 0075 0064 0065 0020 0068 006F 006F 006B 0020 C124 CE58 C5D0 0020 C2E4 D328 D588 C2B5 B2C8 002E"), "Codex Claude Usage") | Out-Null
    }
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Codex Claude Usage") | Out-Null
  }
}

function New-StatusRow {
  param(
    [System.Windows.Forms.TableLayoutPanel]$Parent,
    [int]$Row,
    [string]$Label,
    [bool]$Ok
  )

  $name = New-Label $Label $font $whiteColor
  $name.AutoSize = $false
  $name.Dock = "Fill"
  $valueText = if ($Ok) { U "C815 C0C1" } else { U "D655 C778 0020 D544 C694" }
  $valueColor = if ($Ok) { $goodColor } else { $warnColor }
  $value = New-Label $valueText $monoFont $valueColor
  $value.AutoSize = $false
  $value.Dock = "Fill"
  $value.TextAlign = "MiddleRight"
  $Parent.Controls.Add($name, 0, $Row)
  $Parent.Controls.Add($value, 1, $Row)
}

function Show-SetupWindow {
  $setup = New-Object System.Windows.Forms.Form
  $setup.Text = "Setup"
  $setup.Size = New-Object System.Drawing.Size(456, 372)
  $setup.MinimumSize = New-Object System.Drawing.Size(440, 352)
  $setup.StartPosition = "CenterParent"
  $setup.FormBorderStyle = "None"
  $setup.BackColor = $bgColor
  $setup.ForeColor = $whiteColor
  $setup.Font = $font
  $setup.Icon = $AppIcon

  $setupRoot = New-Object System.Windows.Forms.TableLayoutPanel
  $setupRoot.Dock = "Fill"
  $setupRoot.RowCount = 2
  $setupRoot.ColumnCount = 1
  $setupRoot.Padding = New-Object System.Windows.Forms.Padding(1)
  $setupRoot.BackColor = $lineColor
  $setupRoot.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 34))) | Out-Null
  $setupRoot.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $setup.Controls.Add($setupRoot)

  $setupChrome = New-Object System.Windows.Forms.TableLayoutPanel
  $setupChrome.Dock = "Fill"
  $setupChrome.ColumnCount = 3
  $setupChrome.RowCount = 1
  $setupChrome.BackColor = $chromeColor
  $setupChrome.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 104))) | Out-Null
  $setupChrome.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $setupChrome.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 44))) | Out-Null
  $setupRoot.Controls.Add($setupChrome, 0, 0)

  $setupMark = New-Object System.Windows.Forms.Label
  $setupMark.Dock = "Fill"
  $setupMark.Margin = New-Object System.Windows.Forms.Padding(10, 0, 0, 0)
  $setupMark.BackColor = $chromeColor
  $setupMark.Text = "SETUP"
  $setupMark.TextAlign = "MiddleLeft"
  $setupMark.ForeColor = $codexColor
  $setupMark.Font = New-Object System.Drawing.Font("Cascadia Mono", 8, [System.Drawing.FontStyle]::Bold)

  $setupTitle = New-Object System.Windows.Forms.Label
  $setupTitle.Dock = "Fill"
  $setupTitle.Text = "Connections and startup"
  $setupTitle.TextAlign = "MiddleLeft"
  $setupTitle.ForeColor = $mutedColor
  $setupTitle.Font = New-Object System.Drawing.Font("Segoe UI", 8.2)

  $setupClose = New-WindowCloseControl
  $setupClose.Add_Click({ $setup.Close() })
  foreach ($dragControl in @($setupChrome, $setupMark, $setupTitle)) {
    $dragControl.Add_MouseDown({
      param($sender, $event)
      if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        [NativeWindowDrag]::ReleaseCapture() | Out-Null
        [NativeWindowDrag]::SendMessage($setup.Handle, 0xA1, 0x2, 0) | Out-Null
      }
    })
  }
  $setupChrome.Controls.Add($setupMark, 0, 0)
  $setupChrome.Controls.Add($setupTitle, 1, 0)
  $setupChrome.Controls.Add($setupClose, 2, 0)

  $setupLayout = New-Object System.Windows.Forms.TableLayoutPanel
  $setupLayout.Dock = "Fill"
  $setupLayout.Padding = New-Object System.Windows.Forms.Padding(18, 14, 18, 16)
  $setupLayout.ColumnCount = 1
  $setupLayout.RowCount = 4
  $setupLayout.BackColor = $bgColor
  $setupLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 44))) | Out-Null
  $setupLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 118))) | Out-Null
  $setupLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $setupLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 44))) | Out-Null
  $setupRoot.Controls.Add($setupLayout, 0, 1)

  $setupHeader = New-Label "Setup" $titleFont $whiteColor
  $setupHeader.AutoSize = $false
  $setupHeader.Dock = "Fill"
  $setupLayout.Controls.Add($setupHeader, 0, 0)

  $statusPanel = New-Object System.Windows.Forms.TableLayoutPanel
  $statusPanel.Dock = "Fill"
  $statusPanel.ColumnCount = 2
  $statusPanel.RowCount = 4
  $statusPanel.BackColor = $cardColor
  $statusPanel.Padding = New-Object System.Windows.Forms.Padding(12)
  $statusPanel.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 12)
  $statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 65))) | Out-Null
  $statusPanel.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 35))) | Out-Null
  for ($index = 0; $index -lt 4; $index += 1) {
    $statusPanel.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 22))) | Out-Null
  }
  New-StatusRow $statusPanel 0 "Codex CLI" (Test-CommandAvailable "codex.exe")
  New-StatusRow $statusPanel 1 "Claude Code" (Test-CommandAvailable "claude.exe")
  New-StatusRow $statusPanel 2 "Claude hook" (Test-ClaudeHookInstalled)
  New-StatusRow $statusPanel 3 "Dashboard runtime" (Test-CommandAvailable "uvicorn.exe")
  $setupLayout.Controls.Add($statusPanel, 0, 1)

  $buttonGrid = New-Object System.Windows.Forms.TableLayoutPanel
  $buttonGrid.Dock = "Top"
  $buttonGrid.ColumnCount = 2
  $buttonGrid.RowCount = 2
  $buttonGrid.BackColor = $bgColor
  $buttonGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
  $buttonGrid.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
  $buttonGrid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 42))) | Out-Null
  $buttonGrid.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 42))) | Out-Null
  $codexLoginButton = New-Button "codex login"
  $claudeAuthButton = New-Button "claude auth"
  $hookButton = New-Button "Install Claude hook"
  $openDashboardButton = New-Button "Open dashboard"
  $buttonGrid.Controls.Add($codexLoginButton, 0, 0)
  $buttonGrid.Controls.Add($claudeAuthButton, 1, 0)
  $buttonGrid.Controls.Add($hookButton, 0, 1)
  $buttonGrid.Controls.Add($openDashboardButton, 1, 1)
  $setupLayout.Controls.Add($buttonGrid, 0, 2)

  $closeButton = New-Button "Done"
  $setupLayout.Controls.Add($closeButton, 0, 3)

  $codexLoginButton.Add_Click({ Start-VisibleCommand "codex login" })
  $claudeAuthButton.Add_Click({ Start-VisibleCommand "claude auth" })
  $hookButton.Add_Click({ Install-ClaudeHook; $setup.Close(); Show-SetupWindow })
  $openDashboardButton.Add_Click({ Start-Dashboard; $setup.Close() })
  $closeButton.Add_Click({ $setup.Close() })
  $setup.ShowDialog($form) | Out-Null
}

function Set-StartupRegistration {
  param([bool]$Enabled)

  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $name = "Codex Claude Usage Lite"
  Remove-LegacyStartupRegistrations
  if ($Enabled) {
    $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{0}"' -f $script:AppScriptPath
    New-ItemProperty -Path $runKey -Name $name -Value $command -PropertyType String -Force | Out-Null
  } else {
    Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
  }
}

function Test-StartupRegistration {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  Remove-StaleStartupRegistration
  $value = Get-ItemProperty -Path $runKey -Name "Codex Claude Usage Lite" -ErrorAction SilentlyContinue
  if ($null -eq $value) {
    return $false
  }
  $command = [string]$value."Codex Claude Usage Lite"
  return -not [string]::IsNullOrWhiteSpace($command) -and
    $command.Contains("-File") -and
    $command.Contains($script:AppScriptPath)
}

function Remove-StaleStartupRegistration {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  $value = Get-ItemProperty -Path $runKey -Name "Codex Claude Usage Lite" -ErrorAction SilentlyContinue
  if ($null -eq $value) {
    return
  }
  $command = [string]$value."Codex Claude Usage Lite"
  if (-not [string]::IsNullOrWhiteSpace($command) -and -not $command.Contains($script:AppScriptPath)) {
    Remove-ItemProperty -Path $runKey -Name "Codex Claude Usage Lite" -ErrorAction SilentlyContinue
  }
}

function Remove-LegacyStartupRegistrations {
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  foreach ($name in @("local.codex-claude-usage", "electron.app.Electron")) {
    Remove-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue
  }
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
Remove-LegacyStartupRegistrations
Remove-StaleStartupRegistration
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeWindowDrag
{
    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
}
"@

$AppIcon = if (Test-Path -LiteralPath $AppIconPath) {
  New-Object System.Drawing.Icon($AppIconPath)
} else {
  [System.Drawing.SystemIcons]::Application
}

Start-Collectors

$font = New-Object System.Drawing.Font("Segoe UI", 8.8)
$smallFont = New-Object System.Drawing.Font("Segoe UI", 7.8)
$monoFont = New-Object System.Drawing.Font("Cascadia Mono", 8)
$titleFont = New-Object System.Drawing.Font("Segoe UI Semibold", 11, [System.Drawing.FontStyle]::Bold)
$valueFont = New-Object System.Drawing.Font("Cascadia Mono", 13, [System.Drawing.FontStyle]::Bold)
$buttonFont = New-Object System.Drawing.Font("Segoe UI Semibold", 8.5, [System.Drawing.FontStyle]::Bold)
$bgColor = [System.Drawing.Color]::FromArgb(14, 17, 22)
$chromeColor = [System.Drawing.Color]::FromArgb(20, 24, 31)
$cardColor = [System.Drawing.Color]::FromArgb(24, 29, 38)
$cardAltColor = [System.Drawing.Color]::FromArgb(35, 42, 54)
$mutedColor = [System.Drawing.Color]::FromArgb(156, 166, 180)
$dimColor = [System.Drawing.Color]::FromArgb(102, 113, 130)
$lineColor = [System.Drawing.Color]::FromArgb(42, 50, 64)
$codexColor = [System.Drawing.Color]::FromArgb(111, 191, 255)
$claudeColor = [System.Drawing.Color]::FromArgb(235, 184, 102)
$goodColor = [System.Drawing.Color]::FromArgb(110, 207, 154)
$warnColor = [System.Drawing.Color]::FromArgb(230, 189, 95)
$badColor = [System.Drawing.Color]::FromArgb(238, 106, 106)
$buttonColor = [System.Drawing.Color]::FromArgb(30, 36, 47)
$buttonHotColor = [System.Drawing.Color]::FromArgb(43, 51, 66)
$whiteColor = [System.Drawing.Color]::FromArgb(238, 242, 248)

function New-WindowCloseControl {
  $control = New-Object System.Windows.Forms.Label
  $control.Text = ""
  $control.Dock = "Fill"
  $control.TextAlign = "MiddleCenter"
  $control.BackColor = $chromeColor
  $control.Cursor = [System.Windows.Forms.Cursors]::Hand
  $control.Tag = @{ Hover = $false }
  $control.Add_Paint({
    param($sender, $event)
    $graphics = $event.Graphics
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $state = $sender.Tag
    $rect = New-Object System.Drawing.Rectangle(8, 6, ($sender.Width - 16), ($sender.Height - 12))
    $fill = if ($state.Hover) { [System.Drawing.Color]::FromArgb(70, 39, 47) } else { $chromeColor }
    $border = if ($state.Hover) { [System.Drawing.Color]::FromArgb(172, 83, 93) } else { [System.Drawing.Color]::FromArgb(72, 82, 98) }
    $text = if ($state.Hover) { $whiteColor } else { $mutedColor }
    $brush = New-Object System.Drawing.SolidBrush($fill)
    $pen = New-Object System.Drawing.Pen($border)
    $textBrush = New-Object System.Drawing.SolidBrush($text)
    $path = New-RoundedRectanglePath $rect 4
    $graphics.FillPath($brush, $path)
    $graphics.DrawPath($pen, $path)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textBounds = New-Object System.Drawing.RectangleF($rect.X, ($rect.Y - 1), $rect.Width, $rect.Height)
    $font = New-Object System.Drawing.Font("Segoe UI Semibold", 7.5, [System.Drawing.FontStyle]::Bold)
    $graphics.DrawString("X", $font, $textBrush, $textBounds, $format)
    $font.Dispose()
    $format.Dispose()
    $path.Dispose()
    $brush.Dispose()
    $pen.Dispose()
    $textBrush.Dispose()
  })
  $control.Add_MouseEnter({ param($sender, $event) $sender.Tag = @{ Hover = $true }; $sender.Invalidate() })
  $control.Add_MouseLeave({ param($sender, $event) $sender.Tag = @{ Hover = $false }; $sender.Invalidate() })
  return $control
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Codex Claude Usage"
$form.Size = New-Object System.Drawing.Size(410, 456)
$form.MinimumSize = New-Object System.Drawing.Size(400, 436)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "None"
$form.TopMost = $false
$form.ShowInTaskbar = $true
$form.BackColor = $bgColor
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = $font
$form.Icon = $AppIcon

$rootLayout = New-Object System.Windows.Forms.TableLayoutPanel
$rootLayout.Dock = "Fill"
$rootLayout.RowCount = 2
$rootLayout.ColumnCount = 1
$rootLayout.Padding = New-Object System.Windows.Forms.Padding(1)
$rootLayout.BackColor = $lineColor
$rootLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 34))) | Out-Null
$rootLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$form.Controls.Add($rootLayout)

$titleBar = New-Object System.Windows.Forms.TableLayoutPanel
$titleBar.Dock = "Fill"
$titleBar.ColumnCount = 3
$titleBar.RowCount = 1
$titleBar.BackColor = $chromeColor
$titleBar.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 118))) | Out-Null
$titleBar.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$titleBar.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 44))) | Out-Null
$rootLayout.Controls.Add($titleBar, 0, 0)

$brandMark = New-Object System.Windows.Forms.Label
$brandMark.Dock = "Fill"
$brandMark.Margin = New-Object System.Windows.Forms.Padding(10, 0, 0, 0)
$brandMark.BackColor = $chromeColor
$brandMark.Text = "LOCAL QUOTA"
$brandMark.TextAlign = "MiddleLeft"
$brandMark.ForeColor = $codexColor
$brandMark.Font = New-Object System.Drawing.Font("Cascadia Mono", 8, [System.Drawing.FontStyle]::Bold)
$titleText = New-Object System.Windows.Forms.Label
$titleText.Text = "Codex / Claude Usage"
$titleText.Dock = "Fill"
$titleText.TextAlign = "MiddleLeft"
$titleText.ForeColor = $mutedColor
$titleText.Font = New-Object System.Drawing.Font("Segoe UI", 8.2)
$closeButtonChrome = New-WindowCloseControl
foreach ($dragControl in @($titleBar, $titleText, $brandMark)) {
  $dragControl.Add_MouseDown({
    param($sender, $event)
    if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      [NativeWindowDrag]::ReleaseCapture() | Out-Null
      [NativeWindowDrag]::SendMessage($form.Handle, 0xA1, 0x2, 0) | Out-Null
    }
  })
}
$closeButtonChrome.Add_Click({ $form.Close() })
$titleBar.Controls.Add($brandMark, 0, 0)
$titleBar.Controls.Add($titleText, 1, 0)
$titleBar.Controls.Add($closeButtonChrome, 2, 0)

$layout = New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock = "Fill"
$layout.Padding = New-Object System.Windows.Forms.Padding(16, 12, 16, 14)
$layout.RowCount = 4
$layout.ColumnCount = 1
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 58))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 50))) | Out-Null
$layout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 76))) | Out-Null
$layout.BackColor = $bgColor
$rootLayout.Controls.Add($layout, 0, 1)

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

function New-RoundedRectanglePath {
  param(
    [System.Drawing.Rectangle]$Rect,
    [int]$Radius
  )

  $diameter = $Radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc(($Rect.Right - $diameter), $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc(($Rect.Right - $diameter), ($Rect.Bottom - $diameter), $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, ($Rect.Bottom - $diameter), $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
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

function Test-FreshStatus {
  param($Status)

  if ($null -eq $Status -or [string]::IsNullOrWhiteSpace($Status.captured_at)) {
    return $false
  }
  try {
    $captured = [DateTimeOffset]::Parse([string]$Status.captured_at)
    return (([DateTimeOffset]::Now - $captured).TotalMinutes -le 10)
  } catch {
    return $false
  }
}

function Get-StateText {
  param($Status)

  if ($null -eq $Status -or $Status.parse_status -ne "ok") {
    return U "D655 C778 0020 D544 C694"
  }
  if (Test-FreshStatus $Status) {
    return U "CD5C C2E0"
  }
  return U "C9C0 C5F0"
}

function Set-Dial {
  param($Card, $Percent)

  $tone = Get-ToneColor $Percent
  $text = if ($null -eq $Percent) { "--" } else { "{0}%" -f [int]$Percent }
  $Card.Dial.Tag = @{
    Percent = if ($null -eq $Percent) { 0 } else { [int]$Percent }
    Text = $text
    Tone = $tone
  }
  $Card.Dial.Invalidate()
}

function New-Card {
  param(
    [string]$Title,
    [string]$FirstLabel,
    [string]$SecondLabel
  )

  $panel = New-Object System.Windows.Forms.Panel
  $panel.Dock = "Fill"
  $panel.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
  $panel.Padding = New-Object System.Windows.Forms.Padding(12)
  $panel.BackColor = $cardColor
  $panel.BorderStyle = "None"
  $panel.Add_Paint({
    param($sender, $event)
    $graphics = $event.Graphics
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $rect = New-Object System.Drawing.Rectangle(0, 0, ($sender.Width - 1), ($sender.Height - 1))
    $brush = New-Object System.Drawing.SolidBrush($cardColor)
    $pen = New-Object System.Drawing.Pen($lineColor)
    $graphics.FillRectangle($brush, $rect)
    $graphics.DrawLine($pen, 0, 0, $sender.Width, 0)
    $graphics.DrawLine($pen, 0, $sender.Height - 1, $sender.Width, $sender.Height - 1)
    $brush.Dispose()
    $pen.Dispose()
  })

  $cardLayout = New-Object System.Windows.Forms.TableLayoutPanel
  $cardLayout.Dock = "Fill"
  $cardLayout.ColumnCount = 2
  $cardLayout.RowCount = 2
  $cardLayout.BackColor = $cardColor
  $cardLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 82))) | Out-Null
  $cardLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 28))) | Out-Null
  $cardLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $panel.Controls.Add($cardLayout)

  $titleLabel = New-Label $Title $font $whiteColor
  $titleLabel.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 9.5, [System.Drawing.FontStyle]::Bold)
  $stateLabel = New-Label (U "D655 C778 0020 C911") $monoFont $mutedColor
  $stateLabel.AutoSize = $false
  $stateLabel.TextAlign = "MiddleRight"
  $stateLabel.Dock = "Fill"

  $dial = New-Object System.Windows.Forms.Panel
  $dial.Width = 70
  $dial.Height = 70
  $dial.Margin = New-Object System.Windows.Forms.Padding(0, 4, 12, 0)
  $dial.BackColor = $cardColor
  $dial.Tag = @{
    Percent = 0
    Text = "--"
    Tone = $lineColor
  }
  $dial.Add_Paint({
    param($sender, $event)

    $graphics = $event.Graphics
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $bounds = New-Object System.Drawing.Rectangle(1, 1, 68, 68)
    $textBounds = New-Object System.Drawing.RectangleF(1, 1, 68, 68)
    $trackBrush = New-Object System.Drawing.SolidBrush($cardAltColor)
    $graphics.FillEllipse($trackBrush, $bounds)
    $trackBrush.Dispose()

    $state = $sender.Tag
    $percent = [Math]::Max(0, [Math]::Min(100, [int]$state.Percent))
    if ($percent -gt 0) {
      $toneBrush = New-Object System.Drawing.SolidBrush($state.Tone)
      $graphics.FillPie($toneBrush, $bounds, -90, [float](360 * $percent / 100))
      $toneBrush.Dispose()
    }

    $inner = New-Object System.Drawing.Rectangle(9, 9, 52, 52)
    $innerBrush = New-Object System.Drawing.SolidBrush($cardColor)
    $graphics.FillEllipse($innerBrush, $inner)
    $innerBrush.Dispose()

    $textBrush = New-Object System.Drawing.SolidBrush($whiteColor)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString([string]$state.Text, $valueFont, $textBrush, $textBounds, $format)
    $format.Dispose()
    $textBrush.Dispose()
  })

  $copyLayout = New-Object System.Windows.Forms.TableLayoutPanel
  $copyLayout.Dock = "Fill"
  $copyLayout.ColumnCount = 2
  $copyLayout.RowCount = 4
  $copyLayout.BackColor = $cardColor
  $copyLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 64))) | Out-Null
  $copyLayout.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
  $copyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 22))) | Out-Null
  $copyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 22))) | Out-Null
  $copyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 22))) | Out-Null
  $copyLayout.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null

  $firstName = New-Label $FirstLabel $monoFont $mutedColor
  $firstValue = New-Label "--" $valueFont $whiteColor
  $secondName = New-Label $SecondLabel $monoFont $mutedColor
  $secondValue = New-Label "--" $valueFont $whiteColor
  $resetLabel = New-Label (U "0072 0065 0073 0065 0074 0020 C815 BCF4 0020 C5C6 C74C") $monoFont $mutedColor
  $ageLabel = New-Label (U "AC31 C2E0 0020 AE30 B85D 0020 C5C6 C74C") $monoFont $dimColor
  foreach ($label in @($firstName, $firstValue, $secondName, $secondValue, $resetLabel, $ageLabel)) {
    $label.AutoSize = $false
    $label.Dock = "Fill"
    $label.AutoEllipsis = $true
  }
  $copyLayout.Controls.Add($firstName, 0, 0)
  $copyLayout.Controls.Add($firstValue, 1, 0)
  $copyLayout.Controls.Add($secondName, 0, 1)
  $copyLayout.Controls.Add($secondValue, 1, 1)
  $copyLayout.Controls.Add($resetLabel, 0, 2)
  $copyLayout.SetColumnSpan($resetLabel, 2)
  $copyLayout.Controls.Add($ageLabel, 0, 3)
  $copyLayout.SetColumnSpan($ageLabel, 2)

  $cardLayout.Controls.Add($titleLabel, 0, 0)
  $cardLayout.Controls.Add($stateLabel, 1, 0)
  $cardLayout.Controls.Add($dial, 0, 1)
  $cardLayout.Controls.Add($copyLayout, 1, 1)

  return @{
    Panel = $panel
    Dial = $dial
    State = $stateLabel
    First = $firstValue
    Second = $secondValue
    Reset = $resetLabel
    Age = $ageLabel
  }
}

$header = New-Object System.Windows.Forms.TableLayoutPanel
$header.Dock = "Fill"
$header.ColumnCount = 2
$header.RowCount = 2
$header.BackColor = $bgColor
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$header.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 78))) | Out-Null
$header.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 20))) | Out-Null
$header.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$headerSub = New-Label "STATUS MONITOR" $monoFont $mutedColor
$headerTitle = New-Label "Codex / Claude" $titleFont $whiteColor
$livePill = New-Object System.Windows.Forms.Label
$livePill.Text = "LIVE"
$livePill.Dock = "Top"
$livePill.Height = 22
$livePill.Margin = New-Object System.Windows.Forms.Padding(0, 4, 0, 0)
$livePill.TextAlign = "MiddleCenter"
$livePill.ForeColor = $goodColor
$livePill.BackColor = $cardColor
$livePill.Font = $monoFont
$header.Controls.Add($headerSub, 0, 0)
$header.Controls.Add($headerTitle, 0, 1)
$header.Controls.Add($livePill, 1, 0)
$header.SetRowSpan($livePill, 2)
$layout.Controls.Add($header, 0, 0)

$codexCard = New-Card "Codex" "5h" "Week"
$claudeCard = New-Card "Claude" "Session" "Week"
$layout.Controls.Add($codexCard.Panel, 0, 1)
$layout.Controls.Add($claudeCard.Panel, 0, 2)

$controls = New-Object System.Windows.Forms.TableLayoutPanel
$controls.Dock = "Fill"
$controls.ColumnCount = 3
$controls.RowCount = 2
$controls.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 33))) | Out-Null
$controls.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 34))) | Out-Null
$controls.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 33))) | Out-Null
$controls.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 34))) | Out-Null
$controls.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 42))) | Out-Null
$controls.BackColor = $bgColor
$layout.Controls.Add($controls, 0, 3)

$topMost = New-Object System.Windows.Forms.CheckBox
$topMost.Text = U "D56D C0C1 0020 C704"
$topMost.Checked = $false
$topMost.ForeColor = $mutedColor
$topMost.BackColor = $bgColor
$topMost.FlatStyle = "Flat"
$topMost.AutoSize = $true
$topMost.Add_CheckedChanged({ $form.TopMost = $topMost.Checked })
$controls.Controls.Add($topMost, 0, 0)

$startup = New-Object System.Windows.Forms.CheckBox
$startup.Text = U "C2DC C791 0020 C2DC 0020 C2E4 D589"
$startup.Checked = Test-StartupRegistration
$startup.ForeColor = $mutedColor
$startup.BackColor = $bgColor
$startup.FlatStyle = "Flat"
$startup.AutoSize = $true
$startup.Add_CheckedChanged({ Set-StartupRegistration -Enabled $startup.Checked })
$controls.Controls.Add($startup, 1, 0)
$controls.SetColumnSpan($startup, 2)

function New-Button {
  param([string]$Text)
  $button = New-Object System.Windows.Forms.Label
  $button.Text = ""
  $button.Dock = "Fill"
  $button.Margin = New-Object System.Windows.Forms.Padding(0, 6, 8, 0)
  $button.BackColor = $bgColor
  $button.ForeColor = $whiteColor
  $button.Font = $buttonFont
  $button.TextAlign = "MiddleCenter"
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  $button.BorderStyle = "None"
  $button.Tag = @{ Hover = $false; Text = $Text }
  $button.Add_Paint({
    param($sender, $event)
    $graphics = $event.Graphics
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $state = $sender.Tag
    $rect = New-Object System.Drawing.Rectangle(0, 0, ($sender.Width - 1), ($sender.Height - 1))
    $fill = if ($state.Hover) { $buttonHotColor } else { $buttonColor }
    $brush = New-Object System.Drawing.SolidBrush($fill)
    $pen = New-Object System.Drawing.Pen($lineColor)
    $textBrush = New-Object System.Drawing.SolidBrush($whiteColor)
    $path = New-RoundedRectanglePath $rect 5
    $graphics.FillPath($brush, $path)
    $graphics.DrawPath($pen, $path)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textBounds = New-Object System.Drawing.RectangleF(0, 0, $sender.Width, $sender.Height)
    $graphics.DrawString([string]$state.Text, $sender.Font, $textBrush, $textBounds, $format)
    $format.Dispose()
    $path.Dispose()
    $brush.Dispose()
    $pen.Dispose()
    $textBrush.Dispose()
  })
  $button.Add_MouseEnter({ param($sender, $event) $sender.Tag = @{ Hover = $true; Text = $sender.Tag.Text }; $sender.Invalidate() })
  $button.Add_MouseLeave({ param($sender, $event) $sender.Tag = @{ Hover = $false; Text = $sender.Tag.Text }; $sender.Invalidate() })
  return $button
}

$refreshButton = New-Button "Refresh"
$setupButton = New-Button "Setup"
$dashboardButton = New-Button "Dashboard"
$controls.Controls.Add($refreshButton, 0, 1)
$controls.Controls.Add($setupButton, 1, 1)
$controls.Controls.Add($dashboardButton, 2, 1)

function Update-Ui {
  $codex = Read-JsonSafe $CodexStatusPath
  $claude = Read-JsonSafe $ClaudeStatusPath
  $codexFiveHour = Get-Limit $codex "five_hour"
  $codexWeekly = Get-Limit $codex "weekly"
  $claudeFiveHour = Get-Limit $claude "five_hour"
  $claudeSevenDay = Get-Limit $claude "seven_day"
  $claudeDayWindow = Get-UsageWindow $claude "24h"
  $claudeWeekWindow = Get-UsageWindow $claude "7d"

  $codexMain = if ($codexFiveHour) { $codexFiveHour } else { $codexWeekly }
  $claudeMain = if ($claudeFiveHour) { $claudeFiveHour } else { $claudeSevenDay }

  $codexRemaining = Get-PercentText $codexMain
  $claudeRemaining = Get-PercentText $claudeMain
  $codexRemainingValue = Get-RemainingValue $codexMain
  $claudeRemainingValue = Get-RemainingValue $claudeMain

  $codexCard.State.Text = Get-StateText $codex
  $codexCard.First.Text = Get-PercentText $codexFiveHour
  $codexCard.Second.Text = Get-PercentText $codexWeekly
  $codexCard.Reset.Text = Get-ResetText $codexMain
  $codexCard.Age.Text = Get-StatusAgeText $codex
  Set-Dial $codexCard $codexRemainingValue

  $claudeCard.State.Text = Get-StateText $claude
  $claudeCard.First.Text = if ($claudeFiveHour) { Get-PercentText $claudeFiveHour } else { Get-UsageWindowText $claudeDayWindow }
  $claudeCard.Second.Text = if ($claudeSevenDay) { Get-PercentText $claudeSevenDay } else { Get-UsageWindowText $claudeWeekWindow }
  $claudeCard.Reset.Text = Get-FirstResetText @($claudeMain, $claudeSevenDay, $claudeFiveHour)
  $claudeCard.Age.Text = Get-StatusAgeText $claude
  Set-Dial $claudeCard $claudeRemainingValue
}

function Refresh-Now {
  try {
    Start-Collectors -Immediate
  } catch {
  }
  Update-Ui
}

$refreshButton.Add_Click({ Refresh-Now })
$setupButton.Add_Click({ Show-SetupWindow })
$dashboardButton.Add_Click({ Start-Dashboard })

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "Codex Claude Usage"
$notify.Visible = $true
$notify.Icon = $AppIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add((U "C5F4 AE30"), $null, { $form.Show(); $form.WindowState = "Normal"; $form.Activate() })
[void]$menu.Items.Add("Setup", $null, { Show-SetupWindow })
[void]$menu.Items.Add((U "B300 C2DC BCF4 B4DC"), $null, { Start-Dashboard })
[void]$menu.Items.Add((U "C885 B8CC"), $null, { $script:ExitRequested = $true; $form.Close() })
$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-Ui })
$timer.Start()

$form.Add_FormClosing({
  param($sender, $event)

  if (-not $script:ExitRequested) {
    $event.Cancel = $true
    $form.ShowInTaskbar = $true
    $form.WindowState = "Minimized"
    return
  }

  $timer.Stop()
  $notify.Visible = $false
  Stop-Collectors
})

Update-Ui
[System.Windows.Forms.Application]::Run($form)
