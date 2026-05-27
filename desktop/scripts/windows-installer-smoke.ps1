param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [string]$InstallDir = "$env:RUNNER_TEMP\VectorKnowledgeInstall",
  [string]$DataDir = "$env:APPDATA\向量知识库\data"
)

$ErrorActionPreference = "Stop"

function Assert-Exists($Path, $Message) {
  if (-not (Test-Path $Path)) {
    throw "$Message Path: $Path"
  }
}

function Wait-ForPath($Path, $TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $Path) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

$installerFullPath = Resolve-Path $InstallerPath
$installDirFullPath = [System.IO.Path]::GetFullPath($InstallDir)
$desktopDir = [Environment]::GetFolderPath("DesktopDirectory")
$commonDesktopDir = [Environment]::GetFolderPath("CommonDesktopDirectory")
$shortcutName = "向量知识库.lnk"
$userDesktopShortcut = Join-Path $desktopDir $shortcutName
$commonDesktopShortcut = Join-Path $commonDesktopDir $shortcutName

Write-Host "Installer: $installerFullPath"
Write-Host "InstallDir: $installDirFullPath"
Write-Host "User desktop shortcut: $userDesktopShortcut"
Write-Host "Common desktop shortcut: $commonDesktopShortcut"

Remove-Item $installDirFullPath -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $userDesktopShortcut -Force -ErrorAction SilentlyContinue
Remove-Item $commonDesktopShortcut -Force -ErrorAction SilentlyContinue

$installArgs = @("/S", "/D=$installDirFullPath")
$process = Start-Process -FilePath $installerFullPath -ArgumentList $installArgs -Wait -PassThru
if ($process.ExitCode -ne 0) {
  throw "Installer exited with code $($process.ExitCode)"
}

$exePath = Join-Path $installDirFullPath "向量知识库.exe"
Assert-Exists $exePath "Installed executable was not created."
Assert-Exists (Join-Path $installDirFullPath "resources") "Electron resources directory was not created."

$shortcutReady = (Wait-ForPath $userDesktopShortcut 30) -or (Wait-ForPath $commonDesktopShortcut 5)
if (-not $shortcutReady) {
  throw "Desktop shortcut was not created on user or common desktop."
}

$shortcutPath = if (Test-Path $userDesktopShortcut) { $userDesktopShortcut } else { $commonDesktopShortcut }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if (-not (Test-Path $shortcut.TargetPath)) {
  throw "Desktop shortcut target does not exist: $($shortcut.TargetPath)"
}

Write-Host "Desktop shortcut target: $($shortcut.TargetPath)"
Write-Host "Windows installer smoke test passed."

$uninstaller = Get-ChildItem $installDirFullPath -Filter "Uninstall*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($uninstaller) {
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) {
    throw "Uninstaller exited with code $($uninstall.ExitCode)"
  }
}

if (Test-Path $DataDir) {
  Write-Host "Data directory exists and is preserved: $DataDir"
}
