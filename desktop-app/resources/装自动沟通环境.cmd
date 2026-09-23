@echo off
setlocal EnableExtensions
chcp 65001 >nul
REM ============================================================
REM  BossClaw - Windows 一键安装「自动沟通」环境
REM
REM  只做一件事：安装 Python 依赖（camoufox + playwright）。
REM
REM  重要说明：
REM  - 不装这个脚本，软件照样能用。采集、加入任务、投递、
REM    数据统计、漏斗看板这些功能都不需要它。
REM  - 只有「自动沟通」（隐身引擎自动跟 HR 聊）需要它。
REM  - 浏览器指纹内核（camoufox.exe，约 900MB）已经内置在本软件里，
REM    所以不用再下载，只装 Python 包即可，整个过程约 1-3 分钟。
REM ============================================================

REM main.cjs 位于 resources/app/electron/，detectPython() 优先查找
REM resources/app/.venv/Scripts/python.exe，因此 venv 必须建在那里。
REM 注意：本脚本自身就在 resources\ 下，%~dp0 已是 resources 目录，别再拼一层 resources。
cd /d "%~dp0"
set "VENV_DIR=%~dp0app\.venv"

echo.
echo ============================================
echo   BossClaw 自动沟通环境安装
echo ============================================
echo.
echo   本脚本只安装 Python 依赖。
echo   不安装也不影响其他功能正常使用。
echo.

REM ---- 0. Python 检查 ----
where python >nul 2>&1
if errorlevel 1 (
    echo [未找到 Python]
    echo.
    echo   请先去 https://www.python.org/downloads/ 安装 Python 3.10 或更高版本，
    echo   安装时务必勾选第一屏下方的 "Add Python to PATH"，
    echo   装完关掉本窗口，重新双击本脚本。
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('python -c "import sys;print(sys.version)"') do set "PY_VER=%%v"
echo [1/3] 已找到 Python: %PY_VER%

REM ---- 1. 建 venv（装到软件目录内，避免污染系统环境，也避免系统 Python 权限问题）----
if exist "%VENV_DIR%\Scripts\python.exe" (
    echo [2/3] 检测到已存在的环境，跳过创建。
) else (
    echo [2/3] 正在创建独立 Python 环境（首次约 20 秒）...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [失败] 无法创建 Python 环境。
        echo        请确认安装 Python 时勾选了 "Add Python to PATH"，然后重试。
        echo.
        pause
        exit /b 1
    )
)

REM ---- 2. 装依赖（失败自动切清华源重试）----
echo [3/3] 正在安装依赖 camoufox + playwright（约 1-3 分钟，请耐心等待）...
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip -q
"%VENV_DIR%\Scripts\python.exe" -m pip install "camoufox[geoip]>=0.5" "playwright>=1.40,<1.61"
if errorlevel 1 (
    echo [提示] 默认源安装失败，正在切换清华镜像重试...
    "%VENV_DIR%\Scripts\python.exe" -m pip install "camoufox[geoip]>=0.5" "playwright>=1.40,<1.61" -i https://pypi.tuna.tsinghua.edu.cn/simple
    if errorlevel 1 (
        echo [失败] 依赖安装失败。请检查网络或代理后重试。
        echo.
        pause
        exit /b 1
    )
)

echo.
echo ============================================
echo   安装完成。
echo.
echo   现在可以关闭本窗口，回到软件：
echo   进入「设置」或「自动沟通」页，
echo   点「Camoufox 扫码登录」，用手机 BOSS App 扫一次即可。
echo ============================================
echo.
pause
