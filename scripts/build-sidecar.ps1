$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Out = Join-Path $Root 'web/src-tauri/runtime'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# PyInstaller logs to stderr; Windows PowerShell 5.1 would treat that as a
# terminating error under "Stop", so judge success by the exit code instead.
$ErrorActionPreference = "Continue"
python -m PyInstaller --clean --noconfirm --onedir `
  --noconsole `
  --name har-runtime-server `
  --specpath build `
  --paths src `
  src/har_runtime/desktop_entry.py 2>&1 | Out-Host
$ExitCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($ExitCode -ne 0) { throw "PyInstaller failed with exit code $ExitCode" }

Remove-Item (Join-Path $Out 'har-runtime-server') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item 'dist/har-runtime-server' (Join-Path $Out 'har-runtime-server') -Recurse -Force
Write-Output "Built runtime bundle: $Out/har-runtime-server"
