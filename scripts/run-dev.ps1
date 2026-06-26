param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8000,
  [switch]$SkipInstall,
  [switch]$RecreateVenv
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

$venvPath = "backend\.venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"

if ($RecreateVenv -and (Test-Path $venvPath)) {
  $resolvedVenv = Resolve-Path $venvPath
  $resolvedRoot = Resolve-Path $projectRoot
  if (-not $resolvedVenv.Path.StartsWith($resolvedRoot.Path)) {
    throw "Refusing to remove venv outside the project: $resolvedVenv"
  }
  Write-Host "Removing existing backend virtual environment..."
  Remove-Item -LiteralPath $resolvedVenv.Path -Recurse -Force
}

if (-not (Test-Path $venvPython)) {
  Write-Host "Backend virtual environment is missing or incomplete. Creating it now..."
  & (Join-Path $PSScriptRoot "create-venv.ps1")
}

$python = Join-Path (Resolve-Path $venvPath) "Scripts\python.exe"

try {
  & $python -c "import sys; print(sys.executable)" | Out-Null
} catch {
  throw @"
The existing backend virtual environment is broken.

Run this to recreate it:
  .\scripts\run-dev.ps1 -RecreateVenv

If that still fails, install Python 3.11+ from https://www.python.org/downloads/
and enable 'Add python.exe to PATH' during installation.
"@
}

if (-not $SkipInstall) {
  Write-Host "Installing backend dependencies..."
  & $python -m pip install --disable-pip-version-check --upgrade pip
  & $python -m pip install --disable-pip-version-check -r backend\requirements.txt
} else {
  Write-Host "Skipping dependency installation because -SkipInstall was provided."
}

$baseUrl = "http://$HostName`:$Port"

Write-Host ""
Write-Host "Starting Satellite Crop Planner"
Write-Host "Dashboard: $baseUrl"
Write-Host "API docs:  $baseUrl/docs"
Write-Host "Stop:      Ctrl+C"
& $python -m uvicorn app.main:app --reload --host $HostName --port $Port --app-dir backend
