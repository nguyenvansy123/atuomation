@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\playwright\package.json" goto chuaCai
if not exist ".browsers" goto chuaCai
if not exist "storageState.director.json" goto chuaDangNhap
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0.browsers"
echo CHE DO KY THAT: se ky Truong khoa/uy quyen Giam doc va gui ho so.
echo Them --limit N sau Chay.cmd de gioi han so ho so, vi du: Chay.cmd --limit 1
node auto-sign-director.js --execute %*
if errorlevel 1 goto loi
echo.
echo Da ket thuc. Kiem tra ket qua trong logs\auto-sign-director.jsonl.
pause
exit /b 0
:chuaCai
echo Chua cai du thanh phan. Chay CaiDat.cmd truoc.
goto loi
:chuaDangNhap
echo Chua luu tai khoan. Chay DangNhap.cmd truoc.
:loi
echo.
echo Chuong trinh dung vi loi hoac can kiem tra thu cong. Xem thong bao ben tren.
pause
exit /b 1
