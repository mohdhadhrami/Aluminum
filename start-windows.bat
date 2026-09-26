@echo off
chcp 65001 >nul
title Aluminum Pricing System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js is not installed.
    echo   Node.js غير مثبت على هذا الجهاز.
    echo.
    echo   1. Download and install the LTS version from the page that will open now.
    echo   2. Restart the computer, then double-click this file again.
    echo.
    start https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo   Installing packages, please wait... جاري تثبيت الحزم
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo   Package installation failed. Check the internet connection and try again.
        pause
        exit /b 1
    )
)

rem Open the browser a few seconds after the server starts
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000/admin"

echo   Keep this window open while using the system. Close it to stop.
echo   اترك هذه النافذة مفتوحة أثناء استخدام النظام
call npm start
pause
