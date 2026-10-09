@echo off
setlocal EnableExtensions DisableDelayedExpansion
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 22 or newer with npm is required: https://nodejs.org
    exit /b 1
)
where git >nul 2>&1
if errorlevel 1 (
    echo Git is required: https://git-scm.com/download/win
    exit /b 1
)
node "%~dp0scripts\install.mjs" %*
set "INSTALL_RESULT=%errorlevel%"
if not "%INSTALL_RESULT%"=="0" echo Installation failed. Read the error above before retrying.
exit /b %INSTALL_RESULT%
