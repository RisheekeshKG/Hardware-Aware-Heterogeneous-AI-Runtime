$ErrorActionPreference = "Stop"

Set-Location -Path $PSScriptRoot

$venvPath = Join-Path $PSScriptRoot ".venv"
$pythonPath = Join-Path $venvPath "Scripts\python.exe"
$cudaIndex = "https://download.pytorch.org/whl/cu128"

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($ArgumentList -join ' ')"
    }
}

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    throw "Python was not found. Install Python 3.10 or newer, then run this file again."
}

$pythonCandidates = @(@("-3.14"), @("-3.13"), @("-3.12"), @("-3.11"), @("-3.10"))
$systemPython = $null
foreach ($candidate in $pythonCandidates) {
    & py @candidate -c "import sys" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $systemPython = @("py") + $candidate
        break
    }
}
if ($null -eq $systemPython) {
    throw "Python 3.10 or newer was not found through the Python launcher."
}

if (-not (Test-Path $pythonPath)) {
    Invoke-Checked -FilePath $systemPython[0] -ArgumentList ($systemPython[1..($systemPython.Count - 1)] + @("-m", "venv", $venvPath))
}

Write-Host "Installing CUDA-enabled PyTorch..."
Invoke-Checked -FilePath $pythonPath -ArgumentList @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Checked -FilePath $pythonPath -ArgumentList @("-m", "pip", "install", "torch", "--index-url", $cudaIndex)

Write-Host "Installing the runtime and test dependencies..."
Invoke-Checked -FilePath $pythonPath -ArgumentList @("-m", "pip", "install", "-e", ".[test]")

Write-Host "Checking the NVIDIA driver and CUDA runtime..."
Invoke-Checked -FilePath $pythonPath -ArgumentList @("-c", "import torch; assert torch.cuda.is_available(), 'CUDA is unavailable'; print(f'GPU: {torch.cuda.get_device_name(0)}'); print(f'PyTorch: {torch.__version__}'); print(f'CUDA: {torch.version.cuda}')")

Write-Host "Checking runtime device discovery..."
Invoke-Checked -FilePath $pythonPath -ArgumentList @("-m", "har_runtime.cli", "devices")

Write-Host ""
Write-Host "Setup complete. Start this machine as a worker with:"
Write-Host "  .\.venv\Scripts\har.exe worker --coordinator http://COORDINATOR-IP:8000 --advertise-url http://THIS-MACHINE-IP:9000 --name gpu-worker --node-id gpu-worker"
