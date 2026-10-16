@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo   ==========================================
echo    MSOTRA GAMEPLAY LAB - Grid Guardians
echo   ==========================================
echo.
echo   Starting the server...
echo.
echo   Now open this address in your browser:
echo.
echo        http://localhost:7788
echo.
echo   Keep this window OPEN. Closing it stops the server.
echo.

node --no-warnings server.mjs

echo.
echo   Server stopped.
pause
exit /b

:nonode
echo.
echo   Node.js is not installed on this laptop.
echo.
echo   Install it once, then double-click this file again:
echo.
echo     Easiest:  winget install OpenJS.NodeJS.LTS
echo     Or go to: https://nodejs.org  and run the LTS installer
echo.
echo   After installing, close this window and open a NEW one.
echo   Nothing else is needed - no npm install, no packages.
echo.
pause
exit /b 1
