@echo off
setlocal
cd /d "%~dp0.."

if "%BASE_URL%"=="" set "BASE_URL=http://127.0.0.1:8000"
if "%CROP_K6_VUS%"=="" set "CROP_K6_VUS=300"
if "%CROP_K6_DURATION%"=="" set "CROP_K6_DURATION=30s"
if "%RUN_ANALYSIS%"=="" set "RUN_ANALYSIS=0"
if "%K6_TEST_FILE%"=="" set "K6_TEST_FILE=tests\k6\web.js"

where k6 >nul 2>nul
if errorlevel 1 (
  echo k6 is not installed or is not on PATH.
  echo Install it from https://grafana.com/docs/k6/latest/set-up/install-k6/
  exit /b 1
)

echo Running k6 web test
echo Base URL: %BASE_URL%
echo VUs:      %CROP_K6_VUS%
echo Duration: %CROP_K6_DURATION%
echo Analysis: %RUN_ANALYSIS%
k6 run "%K6_TEST_FILE%"
