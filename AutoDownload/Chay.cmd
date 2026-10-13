@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto chuaCai
node setup.js --check
if errorlevel 1 goto loi
if not exist "node_modules\playwright\package.json" goto chuaCai
if not exist "node_modules\exceljs\package.json" goto chuaCai
if not exist ".browsers" goto chuaCai
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.browsers"
echo Nho dong file Excel truoc khi chay.
node AutoDownload.js
if errorlevel 1 goto loi
echo.
echo Da ket thuc. Kiem tra trang thai trong Excel.
pause
exit /b 0
:chuaCai
echo Chua cai du thanh phan. Chay CaiDat.cmd truoc.
goto loi
:loi
echo.
echo Chuong trinh dung vi loi. Xem thong bao ben tren.
pause
exit /b 1
