@echo off
echo Killing existing Electron / XLETH instances...
taskkill /F /IM electron.exe >nul 2>&1
taskkill /F /IM XLETH.exe >nul 2>&1

echo Freeing port 5173...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

timeout /t 1 /nobreak >nul
cd /d "%~dp0ui"
npm run dev:designer
pause
