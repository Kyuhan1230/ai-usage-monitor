param(
  [string]$PortableDir = "dist\native",
  [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir "..")
$Out = Join-Path $Root $OutputDir
$Portable = Join-Path $Root $PortableDir
$AppName = "Codex Claude Usage"
$InstallerPath = Join-Path $Out "$AppName Setup.exe"
$NsiPath = Join-Path $Out "native-installer.nsi"
$IconPath = Join-Path $Root "assets\codex-claude-usage.ico"

if (-not (Test-Path -LiteralPath $IconPath)) {
  throw "Missing app icon: $IconPath"
}

function Find-MakeNsis {
  $command = Get-Command "makensis.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $cacheRoot = Join-Path $env:LOCALAPPDATA "electron-builder\Cache"
  if (Test-Path -LiteralPath $cacheRoot) {
    $cached = Get-ChildItem -LiteralPath $cacheRoot -Recurse -Filter "makensis.exe" -ErrorAction SilentlyContinue |
      Sort-Object FullName |
      Select-Object -First 1
    if ($cached) {
      return $cached.FullName
    }
  }

  throw "makensis.exe was not found. Run npm run dist:electron once, or install NSIS."
}

function Escape-NsisPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return $Path.Replace("\", "\\")
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ScriptDir "build-native-exe.ps1") -OutputDir $PortableDir
if ($LASTEXITCODE -ne 0) {
  throw "Portable native build failed"
}

if (-not (Test-Path -LiteralPath $Out)) {
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
}

$portableEscaped = Escape-NsisPath -Path $Portable
$installerEscaped = Escape-NsisPath -Path $InstallerPath
$iconEscaped = Escape-NsisPath -Path $IconPath

$nsi = @"
Unicode true
Name "$AppName"
OutFile "$installerEscaped"
Icon "$iconEscaped"
UninstallIcon "$iconEscaped"
InstallDir "`$LOCALAPPDATA\Programs\$AppName"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  IfFileExists "`$INSTDIR\*.*" 0 +2
  RMDir /r "`$INSTDIR"
  SetOutPath "`$INSTDIR"
  File /r "$portableEscaped\*"
  CreateDirectory "`$SMPROGRAMS\$AppName"
  CreateShortcut "`$SMPROGRAMS\$AppName\$AppName.lnk" "`$INSTDIR\$AppName.exe" "" "`$INSTDIR\assets\codex-claude-usage.ico" 0
  CreateShortcut "`$DESKTOP\$AppName.lnk" "`$INSTDIR\$AppName.exe" "" "`$INSTDIR\assets\codex-claude-usage.ico" 0
  WriteUninstaller "`$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" "DisplayName" "$AppName"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" "UninstallString" '"`$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" "DisplayIcon" "`$INSTDIR\assets\codex-claude-usage.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" "InstallLocation" "`$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "`$DESKTOP\$AppName.lnk"
  Delete "`$SMPROGRAMS\$AppName\$AppName.lnk"
  RMDir "`$SMPROGRAMS\$AppName"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppName"
  RMDir /r "`$INSTDIR"
SectionEnd
"@

Set-Content -LiteralPath $NsiPath -Value $nsi -Encoding UTF8

$makeNsis = Find-MakeNsis
& $makeNsis /V2 $NsiPath

if (-not (Test-Path -LiteralPath $InstallerPath)) {
  throw "Installer was not created: $InstallerPath"
}

Write-Output "created $InstallerPath"
