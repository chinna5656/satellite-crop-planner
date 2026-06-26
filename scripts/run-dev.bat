@echo off
setlocal
cd /d "%~dp0.."

if "%APP_HOST%"=="" set "APP_HOST=127.0.0.1"
if "%APP_PORT%"=="" set "APP_PORT=8000"

if /i "%RECREATE_VENV%"=="1" (
  if exist "backend\.venv" (
    echo Removing existing backend virtual environment...
    rmdir /s /q "backend\.venv"
  )
)

if not exist "backend\.venv\Scripts\python.exe" (
  echo Backend virtual environment is missing or incomplete. Creating it now...
  call "%~dp0create-venv.bat"
  if errorlevel 1 exit /b 1
)

"backend\.venv\Scripts\python.exe" -c "import sys; print(sys.executable)" >nul 2>nul
if errorlevel 1 (
  echo The existing backend virtual environment is broken.
  echo.
  echo Run this to recreate it:
  echo   set RECREATE_VENV=1
  echo   scripts\run-dev.bat
  echo.
  echo If that still fails, install Python 3.11+ from https://www.python.org/downloads/
  echo and enable "Add python.exe to PATH" during installation.
  exit /b 1
)

if /i not "%SKIP_INSTALL%"=="1" (
  echo Installing backend dependencies...
  "backend\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip
  "backend\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r backend\requirements.txt
) else (
  echo Skipping dependency installation because SKIP_INSTALL=1.
)

echo.
echo Starting Satellite Crop Planner
echo Dashboard: http://%APP_HOST%:%APP_PORT%
echo API docs:  http://%APP_HOST%:%APP_PORT%/docs
echo Stop:      Ctrl+C
"backend\.venv\Scripts\python.exe" -m uvicorn app.main:app --reload --host %APP_HOST% --port %APP_PORT% --app-dir backend
