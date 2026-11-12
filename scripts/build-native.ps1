# Compile the native host with the csc.exe that ships with .NET Framework.
# No .NET SDK and no Visual Studio required.
#
#   powershell -File scripts\build-native.ps1              # DesktopHost (default)
#   powershell -File scripts\build-native.ps1 -Target Probe
#   powershell -File scripts\build-native.ps1 -Target All
#
# ASCII-only on purpose: Windows PowerShell reads BOM-less .ps1 as ANSI,
# so non-ASCII comments would corrupt the parser.

[CmdletBinding()]
param(
  [ValidateSet('DesktopHost', 'Probe', 'All')]
  [string]$Target = 'DesktopHost'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'native\bin'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
  throw "csc.exe not found. .NET Framework 4.x is required (bundled with Windows)."
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Build-One([string]$name) {
  $src = Join-Path $root ('native\' + $name + '.cs')
  $out = Join-Path $outDir ($name + '.exe')
  if (-not (Test-Path $src)) { throw "Source not found: $src" }
  if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }

  & $csc /nologo /target:exe /optimize+ /platform:anycpu `
    ("/out:" + $out) `
    /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
    $src
  if ($LASTEXITCODE -ne 0) { throw "$name failed to compile (exit $LASTEXITCODE)" }
  if (-not (Test-Path $out)) { throw "Compiler produced no output at $out" }
  $info = Get-Item $out
  Write-Host ("OK  {0}  {1:N0} bytes" -f $info.Name, $info.Length)
}

$targets = if ($Target -eq 'All') { @('DesktopHost', 'Probe') } else { @($Target) }
foreach ($t in $targets) { Build-One $t }
