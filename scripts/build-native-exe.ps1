param(
  [string]$OutputDir = "dist\native"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir "..")
$Out = Join-Path $Root $OutputDir
$AppName = "Codex Claude Usage"
$ExePath = Join-Path $Out "$AppName.exe"

if (Test-Path -LiteralPath $Out) {
  Remove-Item -LiteralPath $Out -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

foreach ($name in @("scripts", "src")) {
  Copy-Item -LiteralPath (Join-Path $Root $name) -Destination (Join-Path $Out $name) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $Root "package.json") -Destination (Join-Path $Out "package.json") -Force
Copy-Item -LiteralPath (Join-Path $Root "package-lock.json") -Destination (Join-Path $Out "package-lock.json") -Force

$lockPath = Join-Path $Root "package-lock.json"
$depScriptPath = Join-Path $Out "list-prod-deps.cjs"
$nodeScript = @"
const lock = require(process.argv[2]);
for (const [name, meta] of Object.entries(lock.packages || {})) {
  if (name.startsWith("node_modules/") && !meta.dev) {
    console.log(name);
  }
}
"@
Set-Content -LiteralPath $depScriptPath -Value $nodeScript -Encoding UTF8
$packageEntries = & node $depScriptPath $lockPath
$nodeExitCode = $LASTEXITCODE
Remove-Item -LiteralPath $depScriptPath -Force
if ($nodeExitCode -ne 0) {
  throw "Failed to read production dependencies from package-lock.json"
}

foreach ($entryName in $packageEntries) {
  $relativePath = $entryName -replace "/", [IO.Path]::DirectorySeparatorChar
  $sourcePath = Join-Path $Root $relativePath
  $destPath = Join-Path $Out $relativePath
  $destParent = Split-Path -Parent $destPath
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Missing production dependency: $sourcePath"
  }
  New-Item -ItemType Directory -Force -Path $destParent | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $destPath -Recurse -Force
}

$source = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Management.Automation;

public static class Program
{
    [STAThread]
    public static int Main()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string scriptPath = Path.Combine(baseDir, "scripts", "native-usage-tray.ps1");
        if (!File.Exists(scriptPath))
        {
            System.Windows.Forms.MessageBox.Show("Missing script: " + scriptPath, "Codex Claude Usage");
            return 1;
        }

        Directory.SetCurrentDirectory(baseDir);
        using (PowerShell powerShell = PowerShell.Create())
        {
            powerShell.AddCommand("Set-ExecutionPolicy")
                .AddParameter("ExecutionPolicy", "Bypass")
                .AddParameter("Scope", "Process")
                .AddParameter("Force");
            powerShell.Invoke();
            powerShell.Commands.Clear();

            powerShell.AddCommand(scriptPath);
            powerShell.Invoke();
            if (powerShell.HadErrors)
            {
                return 1;
            }
        }
        return 0;
    }
}
"@

$automationAssembly = Join-Path $env:WINDIR "Microsoft.NET\assembly\GAC_MSIL\System.Management.Automation\v4.0_3.0.0.0__31bf3856ad364e35\System.Management.Automation.dll"
if (-not (Test-Path -LiteralPath $automationAssembly)) {
  throw "System.Management.Automation.dll was not found: $automationAssembly"
}

Add-Type `
  -TypeDefinition $source `
  -ReferencedAssemblies @("System.dll", "System.Windows.Forms.dll", $automationAssembly) `
  -OutputAssembly $ExePath `
  -OutputType WindowsApplication

Write-Output "created $ExePath"
