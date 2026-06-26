param(
  [string]$BaseUrl = "http://127.0.0.1:8000",
  [int]$Vus = 300,
  [string]$Duration = "30s",
  [switch]$RunAnalysis,
  [string]$TestFile = "tests\k6\web.js"
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $projectRoot

if (-not (Get-Command k6 -ErrorAction SilentlyContinue)) {
  throw "k6 is not installed or is not on PATH. Install it from https://grafana.com/docs/k6/latest/set-up/install-k6/"
}

$previousBaseUrl = $env:BASE_URL
$previousVus = $env:CROP_K6_VUS
$previousDuration = $env:CROP_K6_DURATION
$previousRunAnalysis = $env:RUN_ANALYSIS

try {
  $env:BASE_URL = $BaseUrl
  $env:CROP_K6_VUS = [string]$Vus
  $env:CROP_K6_DURATION = $Duration
  $env:RUN_ANALYSIS = if ($RunAnalysis) { "1" } else { "0" }

  Write-Host "Running k6 web test"
  Write-Host "Base URL: $BaseUrl"
  Write-Host "VUs:      $Vus"
  Write-Host "Duration: $Duration"
  Write-Host "Analysis: $($RunAnalysis.IsPresent)"
  k6 run $TestFile
}
finally {
  $env:BASE_URL = $previousBaseUrl
  $env:CROP_K6_VUS = $previousVus
  $env:CROP_K6_DURATION = $previousDuration
  $env:RUN_ANALYSIS = $previousRunAnalysis
}
