@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM render-1080p.bat — Render bars 1-17 at 1920x1080 60fps
REM Loads \XLETH\test\project.json, renders to test_render_bars1to17_1080p.mp4,
REM and reports PASS/FAIL.
REM ─────────────────────────────────────────────────────────────────────────────

setlocal EnableExtensions
cd /d "%~dp0"

set "EXE=bridge\build\Release\test_real_render.exe"
set "LOG=%TEMP%\xleth_render_1080p.log"
set "OUT=test\test_render_bars1to17_1080p.mp4"

if not exist "%EXE%" (
    echo [render-1080p] ERROR: %EXE% not found.
    echo [render-1080p] Run:  build.bat bridge
    exit /b 1
)

echo.
echo [render-1080p] Running: %EXE% --width 1920 --height 1080 --output %OUT%
echo [render-1080p] Log:     %LOG%
echo.

"%EXE%" --width 1920 --height 1080 --output "%~dp0%OUT%" > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

REM Always print the last 25 lines so progress/result is visible
echo === Last output ===
powershell -NoProfile -Command "Get-Content '%LOG%' | Select-Object -Last 25"
echo ===================

REM Check for clamping activity
for /f %%C in ('powershell -NoProfile -Command "(Select-String -Path '%LOG%' -Pattern 'frame clamped').Count"') do set "CLAMP_COUNT=%%C"
if "%CLAMP_COUNT%"=="" set "CLAMP_COUNT=0"
if "%CLAMP_COUNT%"=="0" (
    echo [render-1080p] NOTE: No frame-clamp events fired ^(no notes exceeded their source video length^)
) else (
    echo [render-1080p] Frame-clamp events: %CLAMP_COUNT%
)

echo.
if "%RC%"=="0" (
    echo [render-1080p] PASSED  --  %OUT%
) else (
    echo [render-1080p] FAILED ^(exit code %RC%^)
    echo [render-1080p] Full log: %LOG%
)
exit /b %RC%
