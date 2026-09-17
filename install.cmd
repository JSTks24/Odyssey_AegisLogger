@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 936 >nul
title Odyssey AegisLogger 一键安装

rem ============================================================
rem  Odyssey AegisLogger 一键安装
rem  自动准备 Node/pnpm 环境，拉取 Vencord 源码，编译本插件并
rem  注入 Discord。所有文件都放在本脚本所在的目录里，不会写进
rem  用户目录。可反复运行：已有环境会被更新，不会残留垃圾。
rem
rem  用法:   install.cmd [代理地址] [Vencord目录]
rem  示例:   install.cmd http://127.0.0.1:7890
rem ============================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

set "PROXY=%~1"
set "VENCORD_DIR=%~2"
if "%VENCORD_DIR%"=="" set "VENCORD_DIR=%SCRIPT_DIR%\Vencord"

set "PLUGIN_NAME=odyssey-aegis-logger"
set "USERPLUGIN=%VENCORD_DIR%\src\userplugins\%PLUGIN_NAME%"
set "INSTALLER_DIR=%VENCORD_DIR%\dist\Installer"
set "INSTALLER=%INSTALLER_DIR%\VencordInstallerCli.exe"
set "INSTALLER_URL=https://github.com/Vencord/Installer/releases/latest/download/VencordInstallerCli.exe"
set "INSTALLER_TMP=%INSTALLER_DIR%\VencordInstallerCli.exe.download"

set "GIT_PROXY="
if defined PROXY set "GIT_PROXY=-c http.proxy=%PROXY% -c https.proxy=%PROXY%"
set "CURL_PROXY="
if defined PROXY set "CURL_PROXY=--proxy %PROXY%"

echo ============================================
echo   Odyssey AegisLogger 一键安装
echo   本目录: %SCRIPT_DIR%
echo   Vencord 源码目录: %VENCORD_DIR%
if defined PROXY echo   代理: %PROXY%
echo ============================================
echo.

if not exist "%SCRIPT_DIR%\settings.tsx" (
    set "FAILMSG=未在脚本目录找到插件源码（settings.tsx）。请完整下载本仓库后再运行，不要单独移动 install.cmd。"
    goto :fail
)

for %%i in ("%VENCORD_DIR%") do set "VENCORD_ABS=%%~fi"
if "%VENCORD_ABS:~-1%"=="\" set "VENCORD_ABS=%VENCORD_ABS:~0,-1%"
if /i "%VENCORD_ABS%"=="%SCRIPT_DIR%" (
    set "FAILMSG=Vencord 目录不能就是本仓库目录。请换一个位置重跑本脚本。"
    goto :fail
)
if exist "%VENCORD_DIR%\install.cmd" (
    set "FAILMSG=目标目录里已经是本插件仓库，请不要在仓库目录里拉取 Vencord。请换一个位置重跑本脚本。"
    goto :fail
)
if exist "%VENCORD_DIR%" if not exist "%VENCORD_DIR%\.git" (
    set "FAILMSG=目标目录已存在且不是 Vencord 仓库：%VENCORD_DIR%。为避免误删，请手动删除该目录或换一个位置后重跑本脚本。"
    goto :fail
)

echo [1/7] 环境检查
where git >nul 2>&1
if errorlevel 1 (
    set "FAILMSG=未找到 git。请安装 Git for Windows: https://git-scm.com/download/win ，安装时一路默认即可，装完后重新运行本脚本。"
    goto :fail
)
where node >nul 2>&1
if errorlevel 1 (
    set "FAILMSG=未找到 Node.js。请到 https://nodejs.org 下载并安装 22 或更新版本，安装时保持默认选项，装完后重新运行本脚本。"
    goto :fail
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set "NODE_MAJOR=%%v"
set /a NODE_MAJOR=%NODE_MAJOR% >nul 2>nul
if %NODE_MAJOR% LSS 22 (
    set "FAILMSG=Node.js 版本过低（当前 !NODE_MAJOR!，需要 22+）。请到 https://nodejs.org 安装新版后重新运行本脚本。"
    goto :fail
)
where pnpm >nul 2>&1 && goto :pnpm_ok
echo   未找到 pnpm，正在通过 npm 全局安装（装到 npm 的全局目录，可用 npm root -g 查看位置）...
call npm install -g pnpm
where pnpm >nul 2>&1 && goto :pnpm_ok
set "FAILMSG=无法自动安装 pnpm。请手动执行 npm install -g pnpm，或参考 https://pnpm.io/installation ，然后重新运行本脚本。"
goto :fail
:pnpm_ok
echo   git / node %NODE_MAJOR% / pnpm 均就绪
echo.

echo [2/7] 获取 Vencord 源码
if exist "%VENCORD_DIR%\.git" (
    echo   已存在，更新到最新版本...
    pushd "%VENCORD_DIR%"
    git !GIT_PROXY! fetch origin
    if errorlevel 1 (
        popd
        set "FAILMSG=更新 Vencord 失败（网络原因）。可带代理重跑，例如: install.cmd http://127.0.0.1:7890"
        goto :fail
    )
    git reset --hard origin/main >nul 2>&1
    git clean -fd >nul 2>&1
    popd
) else (
    echo   首次克隆到本目录，可能需要几分钟...
    git !GIT_PROXY! clone https://github.com/Vendicated/Vencord.git "%VENCORD_DIR%"
    if errorlevel 1 (
        if exist "%VENCORD_DIR%" rd /s /q "%VENCORD_DIR%"
        set "FAILMSG=克隆 Vencord 失败（网络原因），已清理残留文件。可带代理重跑，例如: install.cmd http://127.0.0.1:7890"
        goto :fail
    )
)
echo.

echo [3/7] 安装依赖（首次较慢，请耐心等待）
pushd "%VENCORD_DIR%"
call pnpm install
set "STEP_RC=%errorlevel%"
popd
if not "%STEP_RC%"=="0" (
    rd /s /q "%VENCORD_DIR%\node_modules" >nul 2>&1
    set "FAILMSG=依赖安装失败，已清理残留文件。可直接重新运行本脚本重试。"
    goto :fail
)
echo.

echo [4/7] 挂载插件源码
if not exist "%VENCORD_DIR%\src\userplugins" mkdir "%VENCORD_DIR%\src\userplugins"
rmdir "%USERPLUGIN%" >nul 2>&1
if exist "%USERPLUGIN%" rd /s /q "%USERPLUGIN%"
mklink /J "%USERPLUGIN%" "%SCRIPT_DIR%" >nul 2>&1
if errorlevel 1 (
    set "FAILMSG=创建目录链接失败。请尝试以管理员身份运行后重跑本脚本。若仍失败，请截图反馈给作者。"
    goto :fail
)
echo   %USERPLUGIN% -^> %SCRIPT_DIR%
echo.

echo [5/7] 编译插件（首次较慢）
pushd "%VENCORD_DIR%"
call pnpm build
set "STEP_RC=%errorlevel%"
popd
if not "%STEP_RC%"=="0" (
    set "FAILMSG=编译失败。请把上方的报错信息完整截图反馈给作者。"
    goto :fail
)
echo.

echo [6/7] 下载 Vencord 安装器
if exist "%INSTALLER%" (
    echo   已存在，跳过下载。若注入报错，可删除该文件后重跑: %INSTALLER%
    goto :installer_ok
)
if not exist "%INSTALLER_DIR%" mkdir "%INSTALLER_DIR%"
del "%INSTALLER_TMP%" >nul 2>&1
where curl >nul 2>&1
if errorlevel 1 goto :ps_download
curl -fL !CURL_PROXY! -o "%INSTALLER_TMP%" "%INSTALLER_URL%"
if errorlevel 1 (
    if defined PROXY goto :ps_download
    del "%INSTALLER_TMP%" >nul 2>&1
    set "FAILMSG=安装器下载失败（网络原因）。可带代理重跑，例如: install.cmd http://127.0.0.1:7890"
    goto :fail
)
goto :move_installer
:ps_download
echo   使用 PowerShell 下载...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $p=@{}; If('%PROXY%' -ne ''){ $p.Proxy='%PROXY%' }; Invoke-WebRequest -Uri '%INSTALLER_URL%' -OutFile '%INSTALLER_TMP%' @p"
if errorlevel 1 (
    del "%INSTALLER_TMP%" >nul 2>&1
    set "FAILMSG=安装器下载失败。可手动下载 %INSTALLER_URL% 并改名为 VencordInstallerCli.exe 放到 %INSTALLER_DIR% ，然后重新运行本脚本。"
    goto :fail
)
:move_installer
move /y "%INSTALLER_TMP%" "%INSTALLER%" >nul 2>&1
if errorlevel 1 (
    del "%INSTALLER_TMP%" >nul 2>&1
    set "FAILMSG=安装器文件移动失败，请重跑本脚本。"
    goto :fail
)
:installer_ok
echo.

echo [7/7] 注入 Discord
tasklist /FI "IMAGENAME eq Discord.exe" 2>nul | "%SystemRoot%\System32\find.exe" /I "Discord.exe" >nul
if errorlevel 1 goto :do_inject
echo   检测到 Discord 正在运行，注入前需要先结束它。
set "KILL=y"
set /p "KILL=  结束 Discord 并继续? [Y/n] "
if /i "!KILL!"=="n" (
    echo   已跳过注入。请稍后手动关闭 Discord 后重新运行本脚本。
    goto :done
)
taskkill /IM Discord.exe /F >nul 2>&1
timeout /t 4 /nobreak >nul
:do_inject
set "VENCORD_USER_DATA_DIR=%VENCORD_DIR%"
set "VENCORD_DEV_INSTALL=1"
"%INSTALLER%" -install -branch stable
if errorlevel 1 (
    set "FAILMSG=注入失败。若提示文件被占用，请完全退出 Discord（包括托盘图标）后重跑；其他报错请截图反馈给作者。"
    goto :fail
)
echo.

:done
set "START=y"
set /p "START=立即启动 Discord? [Y/n] "
if /i not "!START!"=="n" (
    for /f "delims=" %%d in ('dir /b /ad /o-n "%LocalAppData%\Discord\app-*" 2^>nul') do (
        start "" "%LocalAppData%\Discord\%%d\Discord.exe"
        goto :launched
    )
    echo   [提示] 未找到 Discord 安装目录，请手动启动 Discord。
)
:launched
echo.
echo ============================================
echo   安装完成！
echo   本次产生的文件都在本目录内，卸载时删掉整个目录即可：
echo     Vencord 源码: %VENCORD_DIR%
echo     插件源码链接: %USERPLUGIN% -^> %SCRIPT_DIR%
echo     安装器: %INSTALLER%
echo.
echo   重启 Discord 后打开 设置 -^> Vencord -^> 插件，
echo   搜索并启用 AegisLogger 即可使用。
echo ============================================
echo.
pause
exit /b 0

:fail
echo.
echo ============================================
echo   [错误] %FAILMSG%
echo ============================================
echo.
pause
exit /b 1
