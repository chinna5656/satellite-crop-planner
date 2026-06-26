@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0.."

set "PYTHON_CMD="

where py >nul 2>nul
if not errorlevel 1 (
  for /f "usebackq delims=" %%P in (`py -3 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_PATH=%%P"
  echo !PYTHON_PATH! | findstr /i "\\WindowsApps\\" >nul
  if errorlevel 1 if not "!PYTHON_PATH!"=="" set "PYTHON_CMD=py -3"
)

if "%PYTHON_CMD%"=="" (
  where python >nul 2>nul
  if not errorlevel 1 (
    for /f "usebackq delims=" %%P in (`python -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_PATH=%%P"
    echo !PYTHON_PATH! | findstr /i "\\WindowsApps\\" >nul
    if errorlevel 1 if not "!PYTHON_PATH!"=="" set "PYTHON_CMD=python"
  )
)

if "%PYTHON_CMD%"=="" (
  echo No usable Python interpreter was found.
  echo.
  echo Install Python 3.11+ from https://www.python.org/downloads/
  echo and enable "Add python.exe to PATH" during installation.
  echo.
  echo Important: disable Windows App Execution Aliases for python.exe/python3.exe
  echo if they point to Microsoft Store Python.
  exit /b 1
)

if /i "%RECREATE_VENV%"=="1" (
  if exist "backend\.venv" (
    echo Removing existing backend virtual environment...
    rmdir /s /q "backend\.venv"
  )
)

if not exist "backend\.venv" (
  echo Creating backend virtual environment at backend\.venv...
  %PYTHON_CMD% -m venv backend\.venv
) else (
  echo Backend virtual environment already exists at backend\.venv.
)

"backend\.venv\Scripts\python.exe" -c "import sys; print(sys.executable)" >nul 2>nul
if errorlevel 1 (
  echo The backend virtual environment exists but cannot run Python.
  echo.
  echo Run this to recreate it:
  echo   set RECREATE_VENV=1
  echo   scripts\create-venv.bat
  echo.
  echo If that still fails, install Python 3.11+ from https://www.python.org/downloads/
  echo and enable "Add python.exe to PATH" during installation.
  exit /b 1
)

echo Upgrading pip...
"backend\.venv\Scripts\python.exe" -m pip install --upgrade pip

echo Installing backend dependencies...
"backend\.venv\Scripts\python.exe" -m pip install -r backend\requirements.txt

echo.
echo Virtual environment ready.
echo Activate it with:
echo   backend\.venv\Scripts\activate.bat
