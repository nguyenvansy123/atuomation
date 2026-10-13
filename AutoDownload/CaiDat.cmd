@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chua co Node.js. Cai Node.js LTS tu https://nodejs.org/ roi chay lai.
  pause
  exit /b 1
)
node setup.js --check
if errorlevel 1 goto loi
where npm >nul 2>nul
if errorlevel 1 (
  echo Khong tim thay npm. Hay cai lai Node.js LTS voi npm.
  goto loi
)
call npm ci
if errorlevel 1 goto loi
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.browsers"
call npx --no-install playwright install chromium
if errorlevel 1 goto loi
node setup.js
if errorlevel 1 goto loi
echo.
echo Cai dat xong. Nhap tai khoan trong config.json va ma BN trong danh_sach.xlsx.
echo Dong Excel, sau do bam Chay.cmd.
pause
exit /b 0
:loi
echo.
echo Cai dat KHONG thanh cong. Xem loi ben tren, khac phuc roi chay lai CaiDat.cmd.
pause
exit /b 1
