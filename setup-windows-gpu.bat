@echo off
setlocal
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows-gpu.ps1"
if errorlevel 1 (
    echo.
    echo Setup failed. Review the error above.
    pause
    exit /b 1
)
echo.
echo Setup completed successfully.
start "HAR local control" /min "%~dp0.venv\Scripts\python.exe" -m uvicorn har_runtime.control:control_app --host 127.0.0.1 --port 9100
pause
