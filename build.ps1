# Audora - production build script (Windows / PowerShell)
# Produces: frontend/dist-electron/Audora Setup <version>.exe (NSIS installer)
#
# Prereqs: Python 3.11-3.13, Node 18+, and a built venv in backend/.venv
# Usage:   powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "==> [1/4] Building backend.exe with PyInstaller" -ForegroundColor Cyan
Push-Location "$root\backend"
if (-not (Test-Path ".venv")) {
    python -m venv .venv
}
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
& ".\.venv\Scripts\python.exe" -m pip install -r requirements-build.txt
& ".\.venv\Scripts\pyinstaller.exe" backend.spec --noconfirm
Pop-Location

if (-not (Test-Path "$root\backend\dist\backend.exe")) {
    throw "backend.exe was not produced - check PyInstaller output above."
}

Write-Host "==> [2/4] Installing frontend dependencies" -ForegroundColor Cyan
Push-Location "$root\frontend"
npm install

Write-Host "==> [3/4] Building React frontend" -ForegroundColor Cyan
npm run build

Write-Host "==> [4/4] Packaging Electron app (NSIS installer)" -ForegroundColor Cyan
npm run dist
Pop-Location

Write-Host "==> Done. Installer is in frontend\dist-electron\" -ForegroundColor Green
