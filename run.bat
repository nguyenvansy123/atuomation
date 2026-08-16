@echo off
cd /d "%~dp0"

echo [1/3] Installing Node dependencies...
npm install
if errorlevel 1 (
  echo ERROR: npm install failed.
  pause
  exit /b 1
)

echo [2/3] Installing Playwright Chromium...
npx playwright install chromium
if errorlevel 1 (
  echo ERROR: playwright install failed.
  pause
  exit /b 1
)

echo [3/3] Starting app...
npm start
pause
