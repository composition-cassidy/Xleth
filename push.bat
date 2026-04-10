@echo off
setlocal

set /p MSG=Commit message:

if "%MSG%"=="" (
    echo Aborted: commit message cannot be empty.
    pause
    exit /b 1
)

echo.
echo Staging all changes...
git add .

echo Committing: %MSG%
git commit -m "%MSG%"

if %errorlevel% neq 0 (
    echo Nothing to commit or commit failed.
    pause
    exit /b 1
)

echo Pushing to origin/main...
git push origin main

if %errorlevel% neq 0 (
    echo Push failed. Check your connection or remote status.
    pause
    exit /b 1
)

echo.
echo Done. Staged, committed, and pushed to origin/main.
pause
endlocal
