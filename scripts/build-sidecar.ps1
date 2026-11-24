$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root 'desktop/src-tauri/runtime'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Set-Location (Join-Path $Root 'har')

# PyInstaller logs to stderr; Windows PowerShell 5.1 would treat that as a
# terminating error under "Stop", so judge success by the exit code instead.
$ErrorActionPreference = "Continue"
python -m PyInstaller --clean --noconfirm har-runtime-server.spec 2>&1 | Out-Host
$ExitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($ExitCode -ne 0) { throw "PyInstaller failed with exit code $ExitCode" }

Remove-Item (Join-Path $Out 'har-runtime-server') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item 'dist/har-runtime-server' (Join-Path $Out 'har-runtime-server') -Recurse -Force
Write-Output "Built runtime bundle: $Out/har-runtime-server"
