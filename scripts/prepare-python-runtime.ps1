param(
    [string]$PythonExe = "python",
    [string]$OutputDir = "runtime\python"
)

$ErrorActionPreference = "Stop"

$pythonVersion = "3.13.14"
$archiveName = "python-$pythonVersion-embed-amd64.zip"
$archiveUrl = "https://www.python.org/ftp/python/$pythonVersion/$archiveName"
$expectedSha256 = "90b4e5b9898b72d744650524bff92377c367f44bd5fbd09e3148656c080ad907"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
$runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "runtime"))

if (-not $resolvedOutput.StartsWith($runtimeRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must stay inside $runtimeRoot"
}

$hostPythonVersion = & $PythonExe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($LASTEXITCODE -ne 0 -or $hostPythonVersion.Trim() -ne "3.13") {
    throw "Python 3.13 is required to prepare the bundled runtime. '$PythonExe' reported '$hostPythonVersion'."
}

$cacheRoot = Join-Path $env:LOCALAPPDATA "ai-usage-monitor\runtime-cache"
$archivePath = Join-Path $cacheRoot $archiveName
New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null

if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-Host "Downloading official CPython $pythonVersion embeddable runtime..."
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$archiveStream = [System.IO.File]::OpenRead($archivePath)
try {
    $actualSha256 = [System.BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace("-", "").ToLowerInvariant()
} finally {
    $archiveStream.Dispose()
    $sha256.Dispose()
}
if ($actualSha256 -ne $expectedSha256) {
    Remove-Item -LiteralPath $archivePath -Force
    throw "CPython archive checksum mismatch. Expected $expectedSha256, got $actualSha256"
}

if (Test-Path -LiteralPath $resolvedOutput) {
    Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $resolvedOutput -Force

$pthPath = Join-Path $resolvedOutput "python313._pth"
if (-not (Test-Path -LiteralPath $pthPath)) {
    throw "Expected embedded Python path file was not found: $pthPath"
}
$pthLines = Get-Content -LiteralPath $pthPath
$pthLines = $pthLines | ForEach-Object {
    if ($_ -eq "#import site") { "import site" } else { $_ }
}
if ($pthLines -notcontains "Lib\site-packages") {
    $pthLines += "Lib\site-packages"
}
Set-Content -LiteralPath $pthPath -Value $pthLines -Encoding ASCII

$sitePackages = Join-Path $resolvedOutput "Lib\site-packages"
New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
& $PythonExe -m pip install --disable-pip-version-check --no-compile --only-binary=:all: --target $sitePackages -r (Join-Path $repoRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    throw "Installing Python runtime dependencies failed with exit code $LASTEXITCODE"
}

$embeddedPython = Join-Path $resolvedOutput "python.exe"
& $embeddedPython -c "import fastapi, uvicorn; from zoneinfo import ZoneInfo; ZoneInfo('Asia/Seoul'); print('embedded Python runtime ready')"
if ($LASTEXITCODE -ne 0) {
    throw "Embedded Python runtime verification failed with exit code $LASTEXITCODE"
}

Write-Host "Prepared bundled Python runtime at $resolvedOutput"
