$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repositoryRoot
try {
  & node scripts/verify-toolchain.js
  if ($LASTEXITCODE -ne 0) {
    throw 'Pinned Node/npm/Rust toolchain verification failed.'
  }

  $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
  $vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'Microsoft C++ Build Tools were not found. Install the Desktop development with C++ workload.'
  }

  $msvcPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($msvcPath | Select-Object -First 1))) {
    throw 'The Visual C++ x64/x86 build tools workload is missing.'
  }
  Write-Output "OK MSVC build tools"

  # Microsoft의 Evergreen Runtime detection 계약에 나온 WebView2 product code다.
  $webViewProductCode = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $webViewLocations = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$webViewProductCode",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webViewProductCode",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$webViewProductCode"
  )
  $webViewVersion = $webViewLocations |
    Where-Object { Test-Path -LiteralPath $_ } |
    ForEach-Object {
      $rawVersion = [string](Get-ItemPropertyValue -LiteralPath $_ -Name 'pv' -ErrorAction SilentlyContinue)
      $rawVersion.Trim([char]0).Trim()
    } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_ -ne '0.0.0.0' } |
    Select-Object -First 1
  if ($null -eq $webViewVersion) {
    throw 'Microsoft Edge WebView2 Runtime was not found. Install the Evergreen Runtime.'
  }
  Write-Output "OK WebView2 Runtime $webViewVersion"
}
finally {
  Pop-Location
}
