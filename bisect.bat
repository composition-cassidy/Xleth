@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM bisect.bat — switch between drone-fix states for manual verification.
REM
REM States:
REM   0  wip       260fa3f  Before any fix (bug present)
REM   A  fix-a     2fe4733  Fix A only: note-off filter + clamp  (root-cause fix)
REM   B  fix-a-b   f45913b  Fix A + B: release-envelope allNotesOff
REM   C  fix-all   71bfc30  Fix A + B + C: full patch series  (current main)
REM   M  main               Return to main branch tip
REM
REM After switching the script offers to rebuild automatically.
REM The engine and bridge both need to be rebuilt because the fixes live in
REM engine source that the bridge links against. The rebuild order is:
REM   engine first (recompiles the static lib), then bridge (relinks .node).
REM ─────────────────────────────────────────────────────────────────────────────

setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if "%~1"=="" goto :menu
set "TARGET=%~1"
goto :dispatch

:menu
echo.
echo ============================================================
echo   XLETH drone-fix bisect
echo ============================================================
echo   0) wip      260fa3f  before any fix (bug present)
echo   A) fix-a    2fe4733  Fix A only: note-off filter (root cause)
echo   B) fix-a-b  f45913b  Fix A + B: + release-envelope allNotesOff
echo   C) fix-all  71bfc30  Fix A + B + C: full patch series
echo   M) main              return to main branch tip
echo   ?) show which state you are in right now
echo ============================================================
set /p CHOICE="  choose: "
if /i "%CHOICE%"=="0" set "TARGET=wip"     & goto :dispatch
if /i "%CHOICE%"=="A" set "TARGET=fix-a"   & goto :dispatch
if /i "%CHOICE%"=="B" set "TARGET=fix-a-b" & goto :dispatch
if /i "%CHOICE%"=="C" set "TARGET=fix-all" & goto :dispatch
if /i "%CHOICE%"=="M" set "TARGET=main"    & goto :dispatch
if    "%CHOICE%"=="?" goto :show_state
echo Invalid choice.
goto :menu

:dispatch
if /i "%TARGET%"=="wip"     goto :t_wip
if /i "%TARGET%"=="fix-a"   goto :t_fix_a
if /i "%TARGET%"=="fix-a-b" goto :t_fix_ab
if /i "%TARGET%"=="fix-all" goto :t_fix_all
if /i "%TARGET%"=="main"    goto :t_main
echo [bisect.bat] Unknown target: %TARGET%
exit /b 1

REM ── helpers ──────────────────────────────────────────────────────────────────

:checkout
REM Usage: call :checkout <ref> <label>
echo.
echo [bisect.bat] checking out %~2 (%~1)...
git checkout --detach %~1
if not "!ERRORLEVEL!"=="0" (
    echo [bisect.bat] checkout FAILED — make sure there are no uncommitted changes.
    exit /b 1
)
echo.
echo [bisect.bat] now at: %~2
echo.
echo [bisect.bat] The fixes live in engine source that the bridge .node links
echo [bisect.bat] against — both need to be rebuilt to test this state.
echo.
set /p REBUILD="  rebuild now? (engine + bridge) [Y/n]: "
if /i "!REBUILD!"=="n"  goto :skip_rebuild
if /i "!REBUILD!"=="no" goto :skip_rebuild
call :do_rebuild
exit /b !ERRORLEVEL!
:skip_rebuild
echo [bisect.bat] skipped — run:  build.bat engine  then  build.bat bridge
exit /b 0

:do_rebuild
echo.
echo [bisect.bat] building engine...
call "%~dp0build.bat" engine
if not "!ERRORLEVEL!"=="0" (
    echo [bisect.bat] engine build FAILED
    exit /b !ERRORLEVEL!
)
echo.
echo [bisect.bat] building bridge...
call "%~dp0build.bat" bridge
if not "!ERRORLEVEL!"=="0" (
    echo [bisect.bat] bridge build FAILED
    exit /b !ERRORLEVEL!
)
echo.
echo [bisect.bat] rebuild OK — run the app with:  build.bat dev
exit /b 0

:show_state
echo.
echo Current HEAD:
git log --oneline -1
echo.
echo Fix commits on main:
for %%H in (260fa3f 2fe4733 f45913b 71bfc30) do (
    git log --oneline -1 %%H 2>nul
)
echo.
goto :menu

REM ── targets ──────────────────────────────────────────────────────────────────

:t_wip
call :checkout 260fa3f "wip (no fixes — bug present)"
exit /b !ERRORLEVEL!

:t_fix_a
call :checkout 2fe4733 "Fix A only"
exit /b !ERRORLEVEL!

:t_fix_ab
call :checkout f45913b "Fix A + B"
exit /b !ERRORLEVEL!

:t_fix_all
call :checkout 71bfc30 "Fix A + B + C (full)"
exit /b !ERRORLEVEL!

:t_main
echo.
echo [bisect.bat] returning to main...
git checkout main
if not "!ERRORLEVEL!"=="0" (
    echo [bisect.bat] checkout main FAILED.
    exit /b 1
)
echo [bisect.bat] back on main (71bfc30)
echo.
set /p REBUILD="  rebuild now? (engine + bridge) [Y/n]: "
if /i "!REBUILD!"=="n"  goto :main_skip
if /i "!REBUILD!"=="no" goto :main_skip
call :do_rebuild
exit /b !ERRORLEVEL!
:main_skip
echo [bisect.bat] skipped.
exit /b 0
