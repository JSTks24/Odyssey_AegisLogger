@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

rem ============================================================
rem  AegisLogger deploy: build Vencord + inject into Discord
rem  Copy this file into the Vencord repo root and double-click,
rem  or run it from anywhere (it auto-locates the repo).
rem ============================================================

set "VENCORD_DIR="

if not "%~1"=="" (
    set "VENCORD_DIR=%~1"
    goto :found
)

rem current directory looks like the Vencord repo?
if exist "%CD%\package.json" if exist "%CD%\scripts\build\build.mjs" (
    set "VENCORD_DIR=%CD%"
    goto :found
)

set "VENCORD_DIR=C:\MY_PROGRAM_PROJECT\SourceCode\Vencord"

:found
if not exist "%VENCORD_DIR%\package.json" (
    echo [ERROR] Vencord repo not found at: %VENCORD_DIR%
    echo Usage: deploy.cmd [path\to\Vencord]
    pause
    exit /b 1
)

echo [1/4] Vencord repo: %VENCORD_DIR%
cd /d "%VENCORD_DIR%"

echo.
echo [2/4] Building Vencord...
call pnpm build
if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

set "INSTALLER=%VENCORD_DIR%\dist\Installer\VencordInstallerCli.exe"
if not exist "%INSTALLER%" (
    echo [ERROR] Installer binary not found: %INSTALLER%
    echo         Run "pnpm inject" once to download it first.
    echo         ^(GitHub download needs proxy 127.0.0.1:7890 on this machine^)
    pause
    exit /b 1
)

echo.
set /p KILL="Kill Discord before patching? [Y/n] "
if /i not "%KILL%"=="n" (
    taskkill /IM Discord.exe /F >nul 2>&1
    timeout /t 4 /nobreak >nul
)

echo.
echo [3/4] Injecting into Discord Stable...
set "VENCORD_USER_DATA_DIR=%VENCORD_DIR%"
set "VENCORD_DEV_INSTALL=1"
"%INSTALLER%" -install -branch stable
if errorlevel 1 (
    echo [ERROR] Injection failed.
    pause
    exit /b 1
)

echo.
set /p START="Launch Discord now? [Y/n] "
if /i not "%START%"=="n" (
    echo [4/4] Starting Discord...
    for /f "delims=" %%d in ('dir /b /ad /o-n "%LocalAppData%\Discord\app-*" 2^>nul') do (
        start "" "%LocalAppData%\Discord\app-%%d\Discord.exe"
        goto :launched
    )
    echo [WARN] Discord executable not found.
) else (
    echo [4/4] Skipped.
)

:launched
echo.
echo Done.
timeout /t 3 >nul
exit /b 0
