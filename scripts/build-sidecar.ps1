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

# uv installs PyTorch on the user's machine at first launch. Pinned and checksum-verified
# because it ships inside the installer.
$UvVersion = '0.10.11'
$UvUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("har-uv-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
Invoke-WebRequest $UvUrl -OutFile (Join-Path $Tmp 'uv.zip')
Invoke-WebRequest "$UvUrl.sha256" -OutFile (Join-Path $Tmp 'uv.zip.sha256')
$Expected = ((Get-Content (Join-Path $Tmp 'uv.zip.sha256') -Raw).Trim() -split '\s+')[0]
$Actual = (Get-FileHash (Join-Path $Tmp 'uv.zip') -Algorithm SHA256).Hash
if ($Expected -ne $Actual) { throw "uv checksum mismatch: expected $Expected, got $Actual" }
Expand-Archive (Join-Path $Tmp 'uv.zip') -DestinationPath (Join-Path $Tmp 'uv')
$UvExe = Get-ChildItem (Join-Path $Tmp 'uv') -Recurse -Filter 'uv.exe' | Select-Object -First 1
if (-not $UvExe) { throw "uv.exe not found in $UvUrl" }
Remove-Item (Join-Path $Out 'uv') -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $Out 'uv') | Out-Null
Copy-Item $UvExe.FullName (Join-Path $Out 'uv/uv.exe')
Remove-Item $Tmp -Recurse -Force
Write-Output "Bundled uv ${UvVersion} at $Out/uv/uv.exe"
