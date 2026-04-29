@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
if /i "%~1"=="/?" goto :usage

set "XLETH_VERSION=%~1"
if "%XLETH_VERSION%"=="" (
    echo.
    set /p XLETH_VERSION="Enter portable version, e.g. 1.0.0: "
)

if "%XLETH_VERSION%"=="" (
    echo [build-portable] Version is required.
    goto :usage
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$v=$env:XLETH_VERSION; if ($v -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$') { exit 0 } exit 1" >nul
if errorlevel 1 (
    echo [build-portable] Invalid version: %XLETH_VERSION%
    echo [build-portable] Use semver like 1.0.0 or 1.0.0-beta.1
    exit /b 1
)

if not exist "ui\package.json" (
    echo [build-portable] Could not find ui\package.json. Run this from the XLETH repo root.
    exit /b 1
)

if not exist "vendor\ffmpeg\bin\ffmpeg.exe" (
    echo [build-portable] Missing vendor\ffmpeg\bin\ffmpeg.exe
    exit /b 1
)

if not exist "vendor\ffmpeg\bin\ffprobe.exe" (
    echo [build-portable] Missing vendor\ffmpeg\bin\ffprobe.exe
    exit /b 1
)

if not exist "vendor\node\node.exe" (
    echo [build-portable] Missing vendor\node\node.exe
    exit /b 1
)

echo.
echo [build-portable] Building XLETH portable version %XLETH_VERSION%
echo [build-portable] Output: dist\Xleth-%XLETH_VERSION%-portable.exe
echo.

pushd ui
call npm run build
set "RC=!ERRORLEVEL!"
if not "!RC!"=="0" (
    popd
    echo [build-portable] UI build failed ^(!RC!^)
    exit /b !RC!
)

call npx --no-install electron-builder --config electron-builder.json --config.extraMetadata.version=%XLETH_VERSION%
set "RC=!ERRORLEVEL!"
popd
if not "!RC!"=="0" (
    echo [build-portable] Portable package failed ^(!RC!^)
    exit /b !RC!
)

set "PORTABLE_EXE=%CD%\dist\Xleth-%XLETH_VERSION%-portable.exe"
if not exist "%PORTABLE_EXE%" (
    echo [build-portable] Build finished, but expected file was not found:
    echo [build-portable] %PORTABLE_EXE%
    exit /b 1
)

for %%F in ("%PORTABLE_EXE%") do set "PORTABLE_BYTES=%%~zF"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$bytes=%PORTABLE_BYTES%; '[build-portable] Created: %PORTABLE_EXE%'; '[build-portable] Size: {0:N2} MB' -f ($bytes / 1MB)"
exit /b 0

:usage
echo.
echo Usage:
echo   build-portable.bat VERSION
echo.
echo Examples:
echo   build-portable.bat 1.0.0
echo   build-portable.bat 1.0.0-beta.1
echo.
echo The version is passed to electron-builder for this build only. It does not edit ui\package.json.
exit /b 1
