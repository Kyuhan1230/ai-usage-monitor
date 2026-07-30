[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $CandidateInstaller,

    [Parameter(Mandatory)]
    [string] $CandidateApplication,

    [Parameter(Mandatory)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $ExpectedVersion,

    [switch] $AllowLocal
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$baselineVersion = '1.2.7'
$baselineTag = "v$baselineVersion"
$baselineTagCommit = 'd417cb919c5e0c491a647ee45031ea03b296c5eb'
$baselineInstallerSize = 2299068
$baselineInstallerSha256 = '2F194A0D25A59DC024D26C2BB3367BC78EA91082EECBE953FEDF43CF75F271FC'
$repositoryUrl = 'https://github.com/Kyuhan1230/ai-usage-monitor.git'
$baselineInstallerUrl = (
    "https://github.com/Kyuhan1230/ai-usage-monitor/releases/download/" +
    "$baselineTag/Codex-Claude-Usage-Setup-$baselineVersion.exe"
)
$uninstallRegistryPath = (
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Codex Claude Usage'
)

if (-not $AllowLocal -and $env:GITHUB_ACTIONS -cne 'true') {
    throw 'This destructive installer smoke is restricted to an ephemeral GitHub Actions runner.'
}
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'RUNNER_TEMP is required for the disposable upgrade target.'
}
if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
    throw 'USERPROFILE is required for the production data-path preservation check.'
}
if ([version]$ExpectedVersion -le [version]$baselineVersion) {
    throw "Candidate version $ExpectedVersion must be newer than baseline $baselineVersion."
}

$candidateInstallerPath = (Resolve-Path -LiteralPath $CandidateInstaller).Path
$candidateApplicationPath = (Resolve-Path -LiteralPath $CandidateApplication).Path
$workRoot = Join-Path $env:RUNNER_TEMP "ai-usage-monitor-upgrade-$PID"
$baselineInstallerPath = Join-Path $workRoot "Codex-Claude-Usage-Setup-$baselineVersion.exe"
$appDataPath = Join-Path $env:USERPROFILE '.codex-usage-wrapper'
$expectedAppDataPath = [System.IO.Path]::GetFullPath(
    (Join-Path $env:USERPROFILE '.codex-usage-wrapper')
)
$actualAppDataPath = [System.IO.Path]::GetFullPath($appDataPath)
if ($actualAppDataPath -cne $expectedAppDataPath) {
    throw 'Resolved application data path escaped the expected user profile target.'
}
if (Test-Path -LiteralPath $appDataPath) {
    throw 'The ephemeral runner application data target was not clean.'
}
if (Test-Path -LiteralPath $workRoot) {
    throw 'The disposable upgrade work root was not clean.'
}

$originalCodexHome = $env:CODEX_HOME
$originalCodexInstallDir = $env:CODEX_INSTALL_DIR
$originalProcessPath = $env:Path
$userPathBefore = [Environment]::GetEnvironmentVariable(
    'Path',
    [System.EnvironmentVariableTarget]::User
)
$machinePathBefore = [Environment]::GetEnvironmentVariable(
    'Path',
    [System.EnvironmentVariableTarget]::Machine
)

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory)]
        [string] $FilePath,

        [Parameter(Mandatory)]
        [string[]] $ArgumentList,

        [Parameter(Mandatory)]
        [ValidateRange(1, 180)]
        [int] $TimeoutSeconds,

        [Parameter(Mandatory)]
        [string] $Description
    )

    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $ArgumentList `
        -WindowStyle Hidden `
        -PassThru
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            try {
                & $taskkill /PID $process.Id /T /F *> $null
            } catch {
                # Preserve the deterministic timeout even if the process exited concurrently.
            }
            $null = $process.WaitForExit(10000)
            throw "$Description timed out after $TimeoutSeconds seconds."
        }
        $process.Refresh()
        if ($process.ExitCode -ne 0) {
            throw "$Description failed with exit code $($process.ExitCode)."
        }
    } finally {
        $process.Dispose()
    }
}

function Invoke-BoundedApplicationLaunch {
    param(
        [Parameter(Mandatory)]
        [string] $FilePath,

        [Parameter(Mandatory)]
        [string] $Description
    )

    $process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList @('--background') `
        -WindowStyle Hidden `
        -PassThru
    try {
        Start-Sleep -Seconds 5
        if ($process.HasExited) {
            $process.Refresh()
            throw "$Description exited unexpectedly with code $($process.ExitCode)."
        }
    } finally {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $null = $process.WaitForExit(10000)
        }
        $process.Dispose()
    }
}

function Get-FileFingerprint {
    param(
        [Parameter(Mandatory)]
        [string] $LiteralPath
    )

    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        return '[absent]'
    }
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return '[not-a-file]'
    }
    $item = Get-Item -LiteralPath $LiteralPath
    $hash = (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash
    return "$($item.Length):$hash"
}

function Get-TreeFingerprint {
    param(
        [Parameter(Mandatory)]
        [string] $LiteralPath
    )

    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Container)) {
        return '[absent]'
    }
    $root = [System.IO.Path]::GetFullPath($LiteralPath)
    $rows = @(
        Get-ChildItem -LiteralPath $root -Recurse -File |
            ForEach-Object {
                $relative = [System.IO.Path]::GetRelativePath($root, $_.FullName)
                $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
                "$relative`:$($_.Length):$hash"
            } |
            Sort-Object
    )
    return ($rows -join "`n")
}

function Get-NsisPayloadReference {
    param(
        [Parameter(Mandatory)]
        [string] $Source
    )

    $unknownMarker = '__TAURI_BUNDLE_TYPE_VAR_UNK'
    $nsisMarker = '__TAURI_BUNDLE_TYPE_VAR_NSS'
    if ($unknownMarker.Length -ne $nsisMarker.Length) {
        throw 'Tauri bundle markers must have the same byte length.'
    }
    $bytes = [System.IO.File]::ReadAllBytes($Source)
    $asciiView = [System.Text.Encoding]::ASCII.GetString($bytes)
    $markerOffset = $asciiView.IndexOf(
        $unknownMarker,
        [System.StringComparison]::Ordinal
    )
    if ($markerOffset -lt 0) {
        throw 'The candidate application is missing the Tauri bundle marker.'
    }
    if (
        $asciiView.IndexOf(
            $unknownMarker,
            $markerOffset + 1,
            [System.StringComparison]::Ordinal
        ) -ge 0
    ) {
        throw 'The candidate application contains multiple Tauri bundle markers.'
    }
    $replacement = [System.Text.Encoding]::ASCII.GetBytes($nsisMarker)
    [System.Array]::Copy(
        $replacement,
        0,
        $bytes,
        $markerOffset,
        $replacement.Length
    )
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = [System.BitConverter]::ToString(
            $sha256.ComputeHash($bytes)
        ).Replace('-', '')
    } finally {
        $sha256.Dispose()
    }
    return [pscustomobject]@{
        Hash = $hash
        Length = $bytes.LongLength
    }
}

function Write-SeedState {
    param(
        [Parameter(Mandatory)]
        [string] $Root
    )

    New-Item -ItemType Directory -Path (Join-Path $Root 'history') -Force | Out-Null
    @{
        schemaVersion = 1
        completed = $true
        skipped = $false
        completedAt = '2026-07-31T00:00:00Z'
    } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $Root 'onboarding.json') -Encoding utf8
    @{
        schemaVersion = 1
        hiddenProviders = @()
    } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $Root 'preferences.json') -Encoding utf8
    @{
        schemaVersion = 1
        enabled = $false
    } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $Root 'monitoring.json') -Encoding utf8
    @{
        schemaVersion = 2
        lastSuccessfulCheckAt = '2026-07-31T00:00:00Z'
        lastSuccessfulCheckAppVersion = $baselineVersion
        lastAutomaticAttemptAt = '2026-07-31T00:00:00Z'
        consecutiveAutomaticFailures = 0
        lastCheckError = $null
        availableVersion = $null
        lastNotifiedVersion = $null
        snoozeUntil = $null
    } | ConvertTo-Json -Depth 4 |
        Set-Content -LiteralPath (Join-Path $Root 'update-state.json') -Encoding utf8
    '{"schema_version":1,"captured_at":"2026-07-31T09:00:00+09:00","parse_status":"ok","limits":[{"type":"five_hour","remaining_percent":73}]}' |
        Set-Content -LiteralPath (Join-Path $Root 'history\2026-07-31.jsonl') -Encoding utf8
    [System.IO.File]::WriteAllBytes(
        (Join-Path $Root 'upgrade-sentinel.bin'),
        [byte[]](0, 1, 2, 3, 127, 128, 254, 255)
    )
}

function Assert-ExternalStateUnchanged {
    param(
        [Parameter(Mandatory)]
        [hashtable] $CodexFileState,

        [Parameter(Mandatory)]
        [string[]] $CodexTargets,

        [Parameter(Mandatory)]
        [string] $CodexHomeFingerprint,

        [Parameter(Mandatory)]
        [string] $CodexHomePath,

        [Parameter(Mandatory)]
        [string] $CustomInstallFingerprint,

        [Parameter(Mandatory)]
        [string] $CustomInstallPath,

        [Parameter(Mandatory)]
        [string] $Phase
    )

    foreach ($target in $CodexTargets) {
        if ((Get-FileFingerprint -LiteralPath $target) -cne $CodexFileState[$target]) {
            throw "$Phase unexpectedly changed Codex CLI target: $target"
        }
    }
    if ((Get-TreeFingerprint -LiteralPath $CodexHomePath) -cne $CodexHomeFingerprint) {
        throw "$Phase unexpectedly changed the isolated CODEX_HOME."
    }
    if (
        (Get-TreeFingerprint -LiteralPath $CustomInstallPath) -cne
        $CustomInstallFingerprint
    ) {
        throw "$Phase unexpectedly changed CODEX_INSTALL_DIR."
    }
    if ($env:Path -cne $originalProcessPath) {
        throw "$Phase unexpectedly changed the process PATH."
    }
    if (
        [Environment]::GetEnvironmentVariable(
            'Path',
            [System.EnvironmentVariableTarget]::User
        ) -cne $userPathBefore
    ) {
        throw "$Phase unexpectedly changed the user PATH."
    }
    if (
        [Environment]::GetEnvironmentVariable(
            'Path',
            [System.EnvironmentVariableTarget]::Machine
        ) -cne $machinePathBefore
    ) {
        throw "$Phase unexpectedly changed the machine PATH."
    }
}

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
try {
    $remoteRefs = @(
        & git ls-remote `
            --exit-code `
            $repositoryUrl `
            "refs/tags/$baselineTag" `
            "refs/tags/$baselineTag^{}"
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Could not resolve public baseline tag $baselineTag."
    }
    $resolvedTagCommit = $null
    foreach ($line in $remoteRefs) {
        $fields = @($line -split '\s+', 2)
        if ($fields.Count -ne 2) {
            continue
        }
        if ($fields[1] -ceq "refs/tags/$baselineTag^{}") {
            $resolvedTagCommit = $fields[0].ToLowerInvariant()
            break
        }
    }
    if ($resolvedTagCommit -cne $baselineTagCommit) {
        throw "Public baseline tag commit changed from $baselineTagCommit."
    }

    $downloaded = $false
    $lastDownloadError = 'No response'
    foreach ($attempt in 1..3) {
        try {
            Invoke-WebRequest `
                -Uri $baselineInstallerUrl `
                -OutFile $baselineInstallerPath `
                -Headers @{ 'Cache-Control' = 'no-cache' }
            $downloaded = $true
            break
        } catch {
            $lastDownloadError = $_.Exception.Message
            if ($attempt -lt 3) {
                Start-Sleep -Seconds 5
            }
        }
    }
    if (-not $downloaded) {
        throw "Downloading public $baselineTag installer failed: $lastDownloadError"
    }
    if ((Get-Item -LiteralPath $baselineInstallerPath).Length -ne $baselineInstallerSize) {
        throw "Public $baselineTag installer size changed."
    }
    if (
        (Get-FileHash -LiteralPath $baselineInstallerPath -Algorithm SHA256).Hash -cne
        $baselineInstallerSha256
    ) {
        throw "Public $baselineTag installer SHA-256 changed."
    }

    $candidatePayload = Get-NsisPayloadReference -Source $candidateApplicationPath
    foreach ($mode in @('default', 'custom')) {
        $scenarioRoot = Join-Path $workRoot $mode
        $installRoot = Join-Path $scenarioRoot 'app'
        $codexHome = Join-Path $scenarioRoot 'codex-home'
        $customCodexInstall = Join-Path $scenarioRoot 'custom-codex'
        New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
        New-Item -ItemType Directory -Path $customCodexInstall -Force | Out-Null
        [System.IO.File]::WriteAllText(
            (Join-Path $codexHome 'auth.json'),
            '{"test_only":"not-a-real-credential"}'
        )
        [System.IO.File]::WriteAllText(
            (Join-Path $customCodexInstall 'preserve.txt'),
            'custom-install-sentinel'
        )

        $env:CODEX_HOME = $codexHome
        if ($mode -ceq 'custom') {
            $env:CODEX_INSTALL_DIR = $customCodexInstall
        } else {
            $env:CODEX_INSTALL_DIR = $null
        }

        $codexTargets = @(
            (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'),
            (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.cmd'),
            (Join-Path $env:APPDATA 'npm\codex'),
            (Join-Path $env:APPDATA 'npm\codex.cmd'),
            (Join-Path $env:APPDATA 'npm\codex.ps1'),
            (Join-Path $env:USERPROFILE '.local\bin\codex.exe'),
            (Join-Path $env:USERPROFILE '.local\bin\codex.cmd'),
            (Join-Path $customCodexInstall 'codex.exe'),
            (Join-Path $customCodexInstall 'codex.cmd'),
            (Join-Path $customCodexInstall 'codex.ps1')
        ) | Sort-Object -Unique
        $codexFileState = @{}
        foreach ($target in $codexTargets) {
            $codexFileState[$target] = Get-FileFingerprint -LiteralPath $target
        }
        $codexHomeFingerprint = Get-TreeFingerprint -LiteralPath $codexHome
        $customInstallFingerprint = Get-TreeFingerprint -LiteralPath $customCodexInstall

        if (Test-Path -LiteralPath $appDataPath) {
            throw "Application data was not clean before $mode scenario."
        }
        Write-SeedState -Root $appDataPath
        $seededAppDataFingerprint = Get-TreeFingerprint -LiteralPath $appDataPath

        Invoke-BoundedProcess `
            -FilePath $baselineInstallerPath `
            -ArgumentList @('/S', "/D=$installRoot") `
            -TimeoutSeconds 90 `
            -Description "$baselineTag silent baseline install ($mode)"

        $application = Join-Path $installRoot 'codex-claude-usage.exe'
        $uninstaller = Join-Path $installRoot 'uninstall.exe'
        foreach ($artifact in @($application, $uninstaller)) {
            if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
                throw "$baselineTag did not install required artifact: $artifact"
            }
        }
        if (-not (Test-Path -LiteralPath $uninstallRegistryPath)) {
            throw "$baselineTag did not create the expected uninstall registry entry."
        }
        $baselineRegistry = Get-ItemProperty -LiteralPath $uninstallRegistryPath
        if ([string]$baselineRegistry.DisplayVersion -cne $baselineVersion) {
            throw "$baselineTag registry DisplayVersion is invalid."
        }
        if (
            ([string]$baselineRegistry.InstallLocation).Trim('"') -cne
            $installRoot
        ) {
            throw "$baselineTag registry install location is invalid."
        }
        $baselineApplicationFingerprint = Get-FileFingerprint -LiteralPath $application
        Invoke-BoundedApplicationLaunch `
            -FilePath $application `
            -Description "$baselineTag baseline launch ($mode)"
        if ((Get-TreeFingerprint -LiteralPath $appDataPath) -cne $seededAppDataFingerprint) {
            throw "$baselineTag launch changed seeded application data in $mode scenario."
        }

        Invoke-BoundedProcess `
            -FilePath $candidateInstallerPath `
            -ArgumentList @('/P', '/UPDATE') `
            -TimeoutSeconds 120 `
            -Description "$baselineTag to v$ExpectedVersion passive update ($mode)"

        if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
            throw "Candidate update removed the installed application in $mode scenario."
        }
        if ((Get-FileFingerprint -LiteralPath $application) -ceq $baselineApplicationFingerprint) {
            throw "Candidate update left the $baselineTag application bytes unchanged."
        }
        if ((Get-Item -LiteralPath $application).Length -ne $candidatePayload.Length) {
            throw 'Updated application length differs from the candidate NSIS payload.'
        }
        if (
            (Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash -cne
            $candidatePayload.Hash
        ) {
            throw 'Updated application bytes differ from the candidate NSIS payload.'
        }
        $installedFiles = @(
            Get-ChildItem -LiteralPath $installRoot -File |
                ForEach-Object Name |
                Sort-Object
        )
        $expectedFiles = @('codex-claude-usage.exe', 'uninstall.exe') | Sort-Object
        if (Compare-Object $expectedFiles $installedFiles) {
            throw "Candidate update left an unexpected installed file set: $($installedFiles -join ', ')"
        }
        $candidateRegistry = Get-ItemProperty -LiteralPath $uninstallRegistryPath
        if ([string]$candidateRegistry.DisplayVersion -cne $ExpectedVersion) {
            throw "Candidate registry DisplayVersion is not $ExpectedVersion."
        }
        if (
            ([string]$candidateRegistry.InstallLocation).Trim('"') -cne
            $installRoot
        ) {
            throw 'Candidate update changed the existing install location.'
        }
        if ((Get-TreeFingerprint -LiteralPath $appDataPath) -cne $seededAppDataFingerprint) {
            throw "Candidate update changed seeded application data in $mode scenario."
        }
        Assert-ExternalStateUnchanged `
            -CodexFileState $codexFileState `
            -CodexTargets $codexTargets `
            -CodexHomeFingerprint $codexHomeFingerprint `
            -CodexHomePath $codexHome `
            -CustomInstallFingerprint $customInstallFingerprint `
            -CustomInstallPath $customCodexInstall `
            -Phase "Candidate update ($mode)"

        Invoke-BoundedApplicationLaunch `
            -FilePath $application `
            -Description "v$ExpectedVersion post-upgrade launch ($mode)"
        if ((Get-TreeFingerprint -LiteralPath $appDataPath) -cne $seededAppDataFingerprint) {
            throw "Post-upgrade launch changed seeded application data in $mode scenario."
        }
        Assert-ExternalStateUnchanged `
            -CodexFileState $codexFileState `
            -CodexTargets $codexTargets `
            -CodexHomeFingerprint $codexHomeFingerprint `
            -CodexHomePath $codexHome `
            -CustomInstallFingerprint $customInstallFingerprint `
            -CustomInstallPath $customCodexInstall `
            -Phase "Post-upgrade launch ($mode)"

        Invoke-BoundedProcess `
            -FilePath $uninstaller `
            -ArgumentList @('/S') `
            -TimeoutSeconds 60 `
            -Description "v$ExpectedVersion uninstall ($mode)"
        $deadline = (Get-Date).AddSeconds(30)
        while ((Test-Path -LiteralPath $installRoot) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 250
        }
        if (Test-Path -LiteralPath $installRoot) {
            throw "Candidate uninstall did not remove the install root in $mode scenario."
        }
        if (Test-Path -LiteralPath $uninstallRegistryPath) {
            throw "Candidate uninstall did not remove the uninstall registry entry in $mode scenario."
        }
        if ((Get-TreeFingerprint -LiteralPath $appDataPath) -cne $seededAppDataFingerprint) {
            throw "Candidate uninstall changed preserved application data in $mode scenario."
        }
        Assert-ExternalStateUnchanged `
            -CodexFileState $codexFileState `
            -CodexTargets $codexTargets `
            -CodexHomeFingerprint $codexHomeFingerprint `
            -CodexHomePath $codexHome `
            -CustomInstallFingerprint $customInstallFingerprint `
            -CustomInstallPath $customCodexInstall `
            -Phase "Candidate uninstall ($mode)"

        Remove-Item -LiteralPath $appDataPath -Recurse -Force
    }

    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
        @(
            '### Existing-customer upgrade smoke'
            "- Baseline: $baselineTag / $baselineTagCommit"
            "- Candidate: v$ExpectedVersion"
            '- Modes: default, custom CODEX_INSTALL_DIR'
            '- Result: install, launch, passive update, relaunch, uninstall, data/Codex/PATH preservation PASS'
        ) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
    }
    Write-Output (
        "PASS public $baselineTag -> v$ExpectedVersion existing-customer upgrade " +
        'for default and custom Codex paths.'
    )
} finally {
    $env:CODEX_HOME = $originalCodexHome
    $env:CODEX_INSTALL_DIR = $originalCodexInstallDir
    $env:Path = $originalProcessPath
    if (Test-Path -LiteralPath $appDataPath) {
        Remove-Item -LiteralPath $appDataPath -Recurse -Force
    }
    if (Test-Path -LiteralPath $workRoot) {
        Remove-Item -LiteralPath $workRoot -Recurse -Force
    }
}
