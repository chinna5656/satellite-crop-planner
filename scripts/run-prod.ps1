param(
  [string]$HostName = "0.0.0.0",
  [int]$Port = 8000,
  [int]$Workers = 1,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

$venvPath = "backend\.venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
  Write-Host "Backend virtual environment is missing. Creating it now..."
  & (Join-Path $PSScriptRoot "create-venv.ps1")
}

$python = Join-Path (Resolve-Path $venvPath) "Scripts\python.exe"

if (-not $SkipInstall) {
  Write-Host "Installing backend dependencies..."
  & $python -m pip install --disable-pip-version-check -r backend\requirements.txt
}

$env:CROP_API_ENVIRONMENT = if ($env:CROP_API_ENVIRONMENT) { $env:CROP_API_ENVIRONMENT } else { "production" }

Write-Host ""
Write-Host "Starting production server"
Write-Host "URL: http://$HostName`:$Port"
Write-Host "Workers: $Workers"
& $python -m uvicorn app.main:app --host $HostName --port $Port --workers $Workers --proxy-headers --app-dir backend
