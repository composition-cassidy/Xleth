@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM XLETH build script — handles every rebuild use case.
REM
REM Usage:  build.bat [target]
REM
REM   (no arg)     Show menu
REM   bridge       Rebuild native addon (fastest path after C++ edits)
REM   bridge-clean Wipe bridge/build and rebuild from scratch
REM   ui           Vite production build (ui/dist)
REM   engine       Configure + build engine (standalone exe + tests) in build/
REM   engine-clean Wipe build/ and reconfigure + rebuild engine
REM   tests        Run ALL engine self-tests (46 test_* executables) via ctest.
REM                Equivalent to: ctest --test-dir build -C Release
REM                Bridge contract tests are separate: cd bridge ^&^& npm test
REM   all          engine + bridge + ui  (most common "rebuild everything")
REM   all-clean    Nuke build/ AND bridge/build/ AND ui/dist, then all
REM   dev          Kill electron + launch dev server (same as start-ui.bat)
REM   run          Launch Electron against the current ui/dist build
REM ─────────────────────────────────────────────────────────────────────────────

setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if "%~1"=="" goto :menu
set "TARGET=%~1"
goto :dispatch

:menu
echo.
echo ============================================================
echo   XLETH build menu
echo ============================================================
echo   1) bridge       - rebuild native addon (C++ ^-^> .node)
echo   2) bridge-clean - wipe bridge/build, rebuild
echo   3) ui           - vite production build
echo   4) engine       - build engine + tests (CMake main build)
echo   5) engine-clean - wipe build/, reconfigure + build
echo   6) tests        - run all 46 engine self-tests via ctest
echo   7) all          - engine + bridge + ui
echo   8) all-clean    - nuke everything, then all
echo   9) dev          - launch electron dev (kills running instances)
echo  10) run          - launch built electron app
echo   0) exit
echo ============================================================
set /p CHOICE="  choose: "
if "%CHOICE%"=="1"  set "TARGET=bridge"       & goto :dispatch
if "%CHOICE%"=="2"  set "TARGET=bridge-clean" & goto :dispatch
if "%CHOICE%"=="3"  set "TARGET=ui"           & goto :dispatch
if "%CHOICE%"=="4"  set "TARGET=engine"       & goto :dispatch
if "%CHOICE%"=="5"  set "TARGET=engine-clean" & goto :dispatch
if "%CHOICE%"=="6"  set "TARGET=tests"        & goto :dispatch
if "%CHOICE%"=="7"  set "TARGET=all"          & goto :dispatch
if "%CHOICE%"=="8"  set "TARGET=all-clean"    & goto :dispatch
if "%CHOICE%"=="9"  set "TARGET=dev"          & goto :dispatch
if "%CHOICE%"=="10" set "TARGET=run"          & goto :dispatch
if "%CHOICE%"=="0"  exit /b 0
echo Invalid choice.
goto :menu

:dispatch
echo.
echo [build.bat] target = %TARGET%
echo.

REM Always kill Electron first — it holds xleth_native.node open on disk
REM which causes cmake-js link errors ("cannot open output file").
call :kill_electron

if /i "%TARGET%"=="bridge"       goto :t_bridge
if /i "%TARGET%"=="bridge-clean" goto :t_bridge_clean
if /i "%TARGET%"=="ui"           goto :t_ui
if /i "%TARGET%"=="engine"       goto :t_engine
if /i "%TARGET%"=="engine-clean" goto :t_engine_clean
if /i "%TARGET%"=="tests"        goto :t_tests
if /i "%TARGET%"=="all"          goto :t_all
if /i "%TARGET%"=="all-clean"    goto :t_all_clean
if /i "%TARGET%"=="dev"          goto :t_dev
if /i "%TARGET%"=="run"          goto :t_run
echo [build.bat] Unknown target: %TARGET%
exit /b 1

REM ─── helpers ─────────────────────────────────────────────────────────────────
:kill_electron
taskkill /F /IM electron.exe  >nul 2>&1
taskkill /F /IM XLETH.exe     >nul 2>&1
taskkill /F /IM XlethEngine.exe >nul 2>&1
exit /b 0

REM ─── targets ─────────────────────────────────────────────────────────────────
:t_bridge
echo [build.bat] rebuilding native addon...
pushd bridge
call npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release
set "BUILD_RC=!ERRORLEVEL!"
popd
if not "!BUILD_RC!"=="0" ( echo [build.bat] bridge build FAILED ^(!BUILD_RC!^) & exit /b !BUILD_RC! )
echo [build.bat] bridge OK
exit /b 0

:t_bridge_clean
echo [build.bat] wiping bridge/build...
if exist bridge\build rmdir /S /Q bridge\build
echo [build.bat] rebuilding native addon from scratch...
pushd bridge
call npx cmake-js rebuild --CDCMAKE_BUILD_TYPE=Release
set "BUILD_RC=!ERRORLEVEL!"
popd
if not "!BUILD_RC!"=="0" ( echo [build.bat] bridge-clean FAILED ^(!BUILD_RC!^) & exit /b !BUILD_RC! )
echo [build.bat] bridge-clean OK
exit /b 0

:t_ui
echo [build.bat] vite build...
pushd ui
call npm run build
set "BUILD_RC=!ERRORLEVEL!"
popd
if not "!BUILD_RC!"=="0" ( echo [build.bat] ui build FAILED ^(!BUILD_RC!^) & exit /b !BUILD_RC! )
echo [build.bat] ui OK
exit /b 0

:t_engine
echo [build.bat] configuring + building engine...
if not exist build mkdir build
pushd build
call cmake .. -G "Visual Studio 17 2022" -A x64
set "BUILD_RC=!ERRORLEVEL!"
if not "!BUILD_RC!"=="0" ( popd & echo [build.bat] cmake configure FAILED ^(!BUILD_RC!^) & exit /b !BUILD_RC! )
call cmake --build . --config Release --parallel
set "BUILD_RC=!ERRORLEVEL!"
popd
if not "!BUILD_RC!"=="0" ( echo [build.bat] engine build FAILED ^(!BUILD_RC!^) & exit /b !BUILD_RC! )
echo [build.bat] engine OK
exit /b 0

:t_engine_clean
echo [build.bat] wiping build/...
if exist build rmdir /S /Q build
call :t_engine
exit /b !ERRORLEVEL!

:t_tests
echo [build.bat] running ALL engine self-tests via ctest...
if not exist "build\CTestTestfile.cmake" (
    echo [build.bat] build\ not configured — run 'engine' first.
    exit /b 1
)
if not exist "build\engine\Release\test_timeline.exe" (
    echo [build.bat] test executables not found — run 'engine' first.
    exit /b 1
)
ctest --test-dir build -C Release --output-on-failure
set "BUILD_RC=!ERRORLEVEL!"
if not "!BUILD_RC!"=="0" (
    echo [build.bat] ctest reported failures ^(!BUILD_RC!^)
    exit /b !BUILD_RC!
)
echo [build.bat] all tests passed
exit /b 0

:t_all
REM bridge first so vcpkg packages (FFmpeg etc.) are present for engine configure
call :t_bridge      || exit /b !ERRORLEVEL!
call :t_engine      || exit /b !ERRORLEVEL!
call :t_ui          || exit /b !ERRORLEVEL!
echo.
echo [build.bat] all OK (bridge + engine + ui)
exit /b 0

:t_all_clean
echo [build.bat] nuking build/, bridge/build/, ui/dist/...
if exist build         rmdir /S /Q build
if exist bridge\build  rmdir /S /Q bridge\build
if exist ui\dist       rmdir /S /Q ui\dist
REM bridge-clean first: installs vcpkg packages (FFmpeg etc.) that engine configure needs
call :t_bridge_clean || exit /b !ERRORLEVEL!
call :t_engine       || exit /b !ERRORLEVEL!
call :t_ui           || exit /b !ERRORLEVEL!
echo.
echo [build.bat] all-clean OK
exit /b 0

:t_dev
echo [build.bat] launching electron dev server...
pushd ui
call npm run dev
popd
exit /b 0

:t_run
echo [build.bat] launching electron against ui/dist...
pushd ui
call npx electron .
popd
exit /b 0
