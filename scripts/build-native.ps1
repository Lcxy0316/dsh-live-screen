# 用 .NET Framework 自带的 csc.exe 编译 ScreenHub.exe。
# 不需要安装 .NET SDK，也不需要 Visual Studio。
# 用法：pwsh -File scripts\build-native.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'native\ScreenHub.cs'
$outDir = Join-Path $root 'native\bin'
$out = Join-Path $outDir 'ScreenHub.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
  throw "找不到 csc.exe。需要 .NET Framework 4.x（Windows 自带）。"
}
if (-not (Test-Path $src)) {
  throw "找不到源码：$src"
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (Test-Path $out) { Remove-Item $out -Force }

& $csc /nologo /target:exe /optimize+ /platform:anycpu `
  "/out:$out" `
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll `
  $src

if ($LASTEXITCODE -ne 0) { throw "编译失败（exit $LASTEXITCODE）" }
if (-not (Test-Path $out)) { throw "编译没有产出 $out" }

$info = Get-Item $out
Write-Host ("OK  {0}  {1:N0} bytes" -f $info.Name, $info.Length)
