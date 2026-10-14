@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\playwright\package.json" goto chuaCai
if not exist ".browsers" goto chuaCai
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.browsers"
node auto-sign-director.js --login
if errorlevel 1 goto loi
echo.
echo Da luu tai khoan. Bam KiemTra.cmd (chi kiem tra) hoac Chay.cmd (ky va gui that).
pause
exit /b 0
:chuaCai
echo Chua cai du thanh phan. Chay CaiDat.cmd truoc.
:loi
echo.
echo Chuong trinh dung vi loi. Xem thong bao ben tren.
pause
exit /b 1
