$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Target = (rustc -vV | Select-String '^host:' | ForEach-Object { $_.Line.Split(':')[1].Trim() })
$Out = Join-Path $Root 'web/src-tauri/binaries'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

python -m PyInstaller --clean --noconfirm --onefile `
  --name har-runtime-server `
  --paths src `
  src/har_runtime/desktop_entry.py

Copy-Item 'dist/har-runtime-server.exe' (Join-Path $Out "har-runtime-server-$Target.exe") -Force
Write-Output "Built sidecar: $Out/har-runtime-server-$Target.exe"
