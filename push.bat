@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM push.bat — stage, commit, and push to origin/main.
REM
REM Pre-push gate: bridge/test_perf_regression.js runs before the actual
REM `git push`. It drives the real preview path against a synthetic project
REM and asserts the preview-FPS regression fixed in 3db1b33 (SyncManager::
REM videoTick performing 100-330ms blocking decodes nobody consumed, which
REM collapsed preview from 60fps to ~17fps) has not resurfaced. It needs a
REM built native addon (bridge/build/Release/xleth_native.node) and the
REM vendored FFmpeg (vendor/ffmpeg/bin/ffmpeg.exe); typical runtime is a few
REM seconds. See CONTRIBUTING.md, "Preview-performance regression gate", for
REM what it measures and what to do if it fails.
REM
REM To skip it for an emergency push (does NOT skip the commit, only the
REM gate check before `git push`):
REM     set XLETH_SKIP_PERF_GATE=1 ^&^& push.bat
REM ─────────────────────────────────────────────────────────────────────────────
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

if defined XLETH_SKIP_PERF_GATE goto :skip_perf_gate

echo.
echo Running preview-performance regression gate...
node "%~dp0bridge\test_perf_regression.js"
if errorlevel 1 goto :perf_gate_failed
goto :after_perf_gate

:perf_gate_failed
echo.
echo Preview-performance regression gate FAILED — push aborted.
echo See CONTRIBUTING.md, "Preview-performance regression gate", for how to diagnose this.
echo To push anyway in an emergency: set XLETH_SKIP_PERF_GATE=1 ^&^& push.bat
pause
exit /b 1

:skip_perf_gate
echo.
echo [push.bat] Skipping preview-performance regression gate ^(XLETH_SKIP_PERF_GATE is set^).

:after_perf_gate
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
