$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Target = (rustc -vV | Select-String '^host:' | ForEach-Object { $_.Line.Split(':')[1].Trim() })
$Out = Join-Path $Root 'web/src-tauri/runtime'
New-Item -ItemType Directory -Force -Path $Out | Out-Null

python -m PyInstaller --clean --noconfirm --onedir `
  --noconsole `
  --name har-runtime-server `
  --paths src `
  src/har_runtime/desktop_entry.py

Remove-Item (Join-Path $Out 'har-runtime-server') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item 'dist/har-runtime-server' (Join-Path $Out 'har-runtime-server') -Recurse -Force
Write-Output "Built runtime bundle: $Out/har-runtime-server"
