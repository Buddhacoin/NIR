# NIR for Windows: NIR Wallet and NIR Майнер in one app, NIR, built from NIR's
# open source code (docs/install-desktop.md). Paste into PowerShell:
#
#   irm https://nircoin.com/install.ps1 | iex
#
# What it does, in order, for this Windows user only (no administrator):
#   1. Node.js, checked against nodejs.org's published SHA-256 sums;
#   2. NIR's source from GitHub;
#   3. a NIR shortcut in the Start menu and on the desktop, then starts NIR.
# Nothing is sent anywhere; wallet keys are created later, inside NIR.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeVersion = "26.12.0"
$Source = "https://github.com/Buddhacoin/NIR/archive/refs/heads/main.zip"
$Data = Join-Path $env:LOCALAPPDATA "NIR"

function Say($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Green }
function Note($text) { Write-Host "   $text" }
function Fail($text) { Write-Host ""; Write-Host "Не получилось: $text" -ForegroundColor Red; throw "NIR install failed" }

switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { $Arch = "x64" }
  "ARM64" { $Arch = "arm64" }
  default { Fail "этот процессор не поддерживается: $($env:PROCESSOR_ARCHITECTURE)." }
}
if ([Environment]::OSVersion.Version.Major -lt 10) { Fail "нужна Windows 10 или новее." }

Write-Host ""
Write-Host "NIR — блокчейн, который майнят решением задач." -ForegroundColor White
Note "Установщик поставит NIR (кошелёк и майнер) для этого пользователя Windows."
New-Item -ItemType Directory -Force -Path $Data | Out-Null
$Temp = Join-Path ([IO.Path]::GetTempPath()) ("nir-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Temp | Out-Null

try {
  Say "1/3 Node.js $NodeVersion"
  $NodeDir = Join-Path $Data "node-v$NodeVersion-win-$Arch"
  $Node = Join-Path $NodeDir "node.exe"
  $current = if (Test-Path $Node) { & $Node --version } else { "" }
  if ($current -eq "v$NodeVersion") {
    Note "Уже есть."
  } else {
    $zip = "node-v$NodeVersion-win-$Arch.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/$zip" -OutFile (Join-Path $Temp $zip)
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile (Join-Path $Temp "SHASUMS256.txt")
    $line = Get-Content (Join-Path $Temp "SHASUMS256.txt") | Where-Object { $_ -match "^[0-9a-f]{64}  $([regex]::Escape($zip))$" }
    $expected = if ($line) { ($line -split "\s+")[0] } else { "" }
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Temp $zip)).Hash.ToLowerInvariant()
    if (-not $expected -or $actual -ne $expected) { Fail "Node.js не прошёл проверку контрольной суммы." }
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Expand-Archive -Path (Join-Path $Temp $zip) -DestinationPath $Data
    Note "Скачан и проверен."
  }

  Say "2/3 NIR"
  # NIR_SOURCE_ZIP: a local archive instead of GitHub, for NIR's own checks.
  if ($env:NIR_SOURCE_ZIP) { Copy-Item $env:NIR_SOURCE_ZIP (Join-Path $Temp "nir.zip") }
  else { Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile (Join-Path $Temp "nir.zip") }
  Expand-Archive -Path (Join-Path $Temp "nir.zip") -DestinationPath (Join-Path $Temp "nir")
  $unpacked = Get-ChildItem (Join-Path $Temp "nir") -Directory | Select-Object -First 1
  if (-not $unpacked -or -not (Test-Path (Join-Path $unpacked.FullName "blockchain\nir-desktop.mjs"))) {
    Fail "архив NIR неполный. Запустите команду ещё раз."
  }
  $SourceDir = Join-Path $Data "source"
  if (Test-Path $SourceDir) { Remove-Item -Recurse -Force $SourceDir }
  Move-Item $unpacked.FullName $SourceDir
  Note "Код загружен."

  Say "3/3 Ярлык NIR"
  $script = Join-Path $SourceDir "blockchain\nir-desktop.mjs"
  # PowerShell starts NIR without a console window of its own. The command is
  # passed encoded, so no folder name can break its quoting.
  $quote = { param($text) "'" + ($text -replace "'", "''") + "'" }
  $command = "Start-Process -WindowStyle Hidden -FilePath $(& $quote $Node) -ArgumentList $(& $quote ('"' + $script + '"'))"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $shell = New-Object -ComObject WScript.Shell
  $places = @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))
  foreach ($place in $places) {
    $link = $shell.CreateShortcut((Join-Path $place "NIR.lnk"))
    $link.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $link.Arguments = "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded"
    $link.WorkingDirectory = $SourceDir
    $link.IconLocation = Join-Path $SourceDir "desktop-ui\nir.ico"
    $link.WindowStyle = 7
    $link.Description = "NIR Wallet и NIR Майнер"
    $link.Save()
  }
  Note "NIR есть в меню «Пуск» и на рабочем столе."
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Готово!" -ForegroundColor Green
Note "Сначала NIR предложит создать кошелёк: запишите 24 слова на бумагу."
Note "Потом в окне NIR Майнер нажмите «Подключить NIR Wallet» и «Начать майнинг»."
if (-not $env:NIR_INSTALL_NO_START) {
  Start-Process -WindowStyle Hidden -FilePath $Node -ArgumentList ('"' + $script + '"') -WorkingDirectory $SourceDir
}
