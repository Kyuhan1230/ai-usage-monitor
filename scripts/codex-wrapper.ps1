$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
Set-Location $projectRoot

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules\node-pty"))) {
    Write-Host "[usage-wrapper] installing npm dependencies..."
    npm install
}

node .\src\node\codex-wrapper.js @args
