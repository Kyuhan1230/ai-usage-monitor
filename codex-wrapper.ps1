$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

if (-not (Test-Path -LiteralPath (Join-Path $scriptDir "node_modules\node-pty"))) {
    Write-Host "[usage-wrapper] installing npm dependencies..."
    npm install
}

node .\codex-wrapper.js @args
