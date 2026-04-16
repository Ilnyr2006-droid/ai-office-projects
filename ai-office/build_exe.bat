@echo off
setlocal
cd /d "%~dp0"

echo [1/4] Upgrading pip...
py -m pip install --upgrade pip
if errorlevel 1 goto :fail

echo [2/4] Installing PyInstaller...
py -m pip install pyinstaller
if errorlevel 1 goto :fail

echo [3/4] Cleaning old build artifacts...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
if exist AIOffice.spec del /q AIOffice.spec

echo [4/4] Building AIOffice.exe...
py -m PyInstaller --noconfirm --onefile --name AIOffice ai_office_app.py
if errorlevel 1 goto :fail

echo.
echo Done. EXE file:
echo %cd%\dist\AIOffice.exe
echo.
exit /b 0

:fail
echo.
echo Build failed. Check errors above.
exit /b 1
