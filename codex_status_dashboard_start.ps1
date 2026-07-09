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
$port = 8767

try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/status.json" -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
        Add-Content -Path $stdoutLog -Encoding UTF8 -Value "[$(Get-Date -Format o)] dashboard already running on port $port"
        exit 0
    }
} catch {
    # 서버가 응답하지 않으면 새로 시작한다.
}

Start-Process -FilePath "python" `
    -ArgumentList @("codex_status_dashboard.py", "--serve", "--port", "$port") `
    -WorkingDirectory $scriptDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog
