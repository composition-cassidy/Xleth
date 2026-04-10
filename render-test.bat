@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM render-test.bat — Run the real project render test (bars 1-17, 1920x1080 60fps)
REM Loads \XLETH\test\project.json, renders to test_render_bars1to17.mp4,
REM and reports PASS/FAIL.
REM ─────────────────────────────────────────────────────────────────────────────

setlocal EnableExtensions
cd /d "%~dp0"

set "EXE=bridge\build\Release\test_real_render.exe"
set "LOG=%TEMP%\xleth_render_test.log"

if not exist "%EXE%" (
    echo [render-test] ERROR: %EXE% not found.
    echo [render-test] Run:  build.bat bridge
    exit /b 1
)

echo.
echo [render-test] Running: %EXE%
echo [render-test] Log:     %LOG%
echo.

"%EXE%" > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"

REM Always print the last 20 lines so progress/result is visible
echo === Last output ===
powershell -NoProfile -Command "Get-Content '%LOG%' | Select-Object -Last 25"
echo ===================

REM Check for clamping activity
for /f %%C in ('powershell -NoProfile -Command "(Select-String -Path '%LOG%' -Pattern 'frame clamped').Count"') do set "CLAMP_COUNT=%%C"
if "%CLAMP_COUNT%"=="" set "CLAMP_COUNT=0"
if "%CLAMP_COUNT%"=="0" (
    echo [render-test] NOTE: No frame-clamp events fired ^(no notes exceeded their source video length^)
) else (
    echo [render-test] Frame-clamp events: %CLAMP_COUNT%
)

echo.
if "%RC%"=="0" (
    echo [render-test] PASSED
) else (
    echo [render-test] FAILED ^(exit code %RC%^)
    echo [render-test] Full log: %LOG%
)
exit /b %RC%
