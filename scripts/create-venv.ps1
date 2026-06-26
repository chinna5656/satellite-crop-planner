param(
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

$venvPath = "backend\.venv"

function Get-UsablePython {
  $candidates = @()
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $candidates += ,@("py", "-3")
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    $candidates += ,@("python")
  }
  if (Get-Command python3 -ErrorAction SilentlyContinue) {
    $candidates += ,@("python3")
  }

  foreach ($candidate in $candidates) {
    $exe = $candidate[0]
    $args = @()
    if ($candidate.Length -gt 1) {
      $args = $candidate[1..($candidate.Length - 1)]
    }

    try {
      $pythonPath = & $exe @args -c "import sys; print(sys.executable)"
      if ($LASTEXITCODE -eq 0 -and $pythonPath -and ($pythonPath -notmatch "\\WindowsApps\\")) {
        return @{
          Exe = $exe
          Args = $args
          Path = $pythonPath
        }
      }
    } catch {
      continue
    }
  }

  throw @"
No usable Python interpreter was found.

Install Python 3.11+ from https://www.python.org/downloads/
and enable 'Add python.exe to PATH' during installation.

Important: disable Windows App Execution Aliases for python.exe/python3.exe
if they point to Microsoft Store Python.
"@
}

if ($Recreate -and (Test-Path $venvPath)) {
  $resolvedVenv = Resolve-Path $venvPath
  $resolvedRoot = Resolve-Path $projectRoot
  if (-not $resolvedVenv.Path.StartsWith($resolvedRoot.Path)) {
    throw "Refusing to remove venv outside the project: $resolvedVenv"
  }
  Write-Host "Removing existing backend virtual environment..."
  Remove-Item -LiteralPath $resolvedVenv.Path -Recurse -Force
}

if (-not (Test-Path $venvPath)) {
  $pythonCommand = Get-UsablePython
  Write-Host "Using Python: $($pythonCommand.Path)"
  Write-Host "Creating backend virtual environment at $venvPath..."
  & $pythonCommand.Exe @($pythonCommand.Args) -m venv $venvPath
} else {
  Write-Host "Backend virtual environment already exists at $venvPath."
}

$python = Join-Path (Resolve-Path $venvPath) "Scripts\python.exe"

try {
  & $python -c "import sys; print(sys.executable)" | Out-Null
} catch {
  throw @"
The backend virtual environment exists but cannot run Python.

Run this to recreate it:
  .\scripts\create-venv.ps1 -Recreate

If that still fails, install Python 3.11+ from https://www.python.org/downloads/
and enable 'Add python.exe to PATH' during installation.
"@
}

Write-Host "Upgrading pip..."
& $python -m pip install --upgrade pip

Write-Host "Installing backend dependencies..."
& $python -m pip install -r backend\requirements.txt

Write-Host ""
Write-Host "Virtual environment ready."
Write-Host "Activate it with:"
Write-Host "  backend\.venv\Scripts\Activate.ps1"
