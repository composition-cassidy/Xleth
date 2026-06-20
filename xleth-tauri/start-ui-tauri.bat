@echo off
taskkill /f /im xleth-engine.exe 2>nul
if exist "%~dp0target\release\xleth-tauri.exe" (
    start "" /d "%~dp0" "%~dp0target\release\xleth-tauri.exe"
) else if exist "%~dp0src-tauri\target\release\xleth-tauri.exe" (
    start "" /d "%~dp0" "%~dp0src-tauri\target\release\xleth-tauri.exe"
) else (
    cd /d "%~dp0"
    call build-env.cmd cargo run --manifest-path src-tauri\Cargo.toml
)
