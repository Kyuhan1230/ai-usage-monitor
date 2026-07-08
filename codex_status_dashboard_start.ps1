$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Test-Path -LiteralPath (Join-Path $scriptDir "node_modules\node-pty"))) {
    Write-Host "[dashboard] installing npm dependencies..."
    npm install
}

$logDir = Join-Path $HOME ".codex-usage-wrapper"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdoutLog = Join-Path $logDir "dashboard.log"
$stderrLog = Join-Path $logDir "dashboard-error.log"

Start-Process -FilePath "python" `
    -ArgumentList @("codex_status_dashboard.py", "--serve") `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog
