@echo off
title 团队待办管理系统（便携版）
cd /d "%~dp0"

echo ============================================
echo   团队待办管理系统 - 一键启动（便携版）
echo ============================================
echo.

:: ---------- 1. 选择 Python ----------
set "PY=%~dp0runtime\python.exe"
if exist "%PY%" (
    echo [Python] 使用自带运行环境
) else (
    set "PY=python"
    where python >nul 2>nul
    if %errorlevel% equ 0 (
        echo [Python] 未找到自带运行环境，退回系统 Python
    ) else (
        echo [错误] 未找到 Python！请确保 runtime 目录存在，或先安装 Python。
        pause
        exit /b 1
    )
)

:: ---------- 2. 端口占用预检 ----------
netstat -ano | findstr ":5001" | findstr "LISTENING" >nul 2>nul
if %errorlevel% equ 0 (
    echo [提示] 检测到 5001 端口已有服务在运行，直接打开浏览器...
    start "" "http://127.0.0.1:5001/"
    echo.
    echo [说明] 服务正由之前打开的窗口在后台运行，本窗口稍后关闭。
    pause
    exit /b 0
)

:: ---------- 3. 启动服务 ----------
echo [启动] 正在启动服务（首次启动需几秒初始化数据库）...
timeout /t 2 >nul
start "" "http://127.0.0.1:5001/"
echo [服务] 已启动。请勿关闭本黑色窗口，服务就运行在它里面。
echo [停止] 如需停止服务，关闭本窗口或在窗口内按 Ctrl+C。
echo.
%PY% app.py
pause
