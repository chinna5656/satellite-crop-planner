@echo off
setlocal
cd /d "%~dp0.."

if "%APP_HOST%"=="" set "APP_HOST=0.0.0.0"
if "%APP_PORT%"=="" set "APP_PORT=8000"
if "%APP_WORKERS%"=="" set "APP_WORKERS=1"
if "%CROP_API_ENVIRONMENT%"=="" set "CROP_API_ENVIRONMENT=production"

if not exist "backend\.venv\Scripts\python.exe" (
  echo Backend virtual environment is missing. Creating it now...
  call "%~dp0create-venv.bat"
  if errorlevel 1 exit /b 1
)

if /i not "%SKIP_INSTALL%"=="1" (
  echo Installing backend dependencies...
  "backend\.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r backend\requirements.txt
)

echo.
echo Starting production server
echo URL: http://%APP_HOST%:%APP_PORT%
echo Workers: %APP_WORKERS%
"backend\.venv\Scripts\python.exe" -m uvicorn app.main:app --host %APP_HOST% --port %APP_PORT% --workers %APP_WORKERS% --proxy-headers --app-dir backend
