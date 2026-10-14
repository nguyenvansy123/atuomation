@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\playwright\package.json" goto chuaCai
if not exist ".browsers" goto chuaCai
if not exist "storageState.director.json" goto chuaDangNhap
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.browsers"
echo CHE DO KIEM TRA: khong ky va khong gui ho so.
node auto-sign-director.js %*
if errorlevel 1 goto loi
echo.
echo Da ket thuc kiem tra.
pause
exit /b 0
:chuaCai
echo Chua cai du thanh phan. Chay CaiDat.cmd truoc.
goto loi
:chuaDangNhap
echo Chua luu tai khoan. Chay DangNhap.cmd truoc.
:loi
echo.
echo Chuong trinh dung vi loi. Xem thong bao ben tren.
pause
exit /b 1
