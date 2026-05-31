@echo off
title 停止 AI Dashboard
setlocal

echo.
echo ============================================
echo  正在停止 AI Dashboard 服务器...
echo ============================================
echo.

REM 杀掉占用 3000 端口的进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a 2>nul
    echo  已停止进程 PID: %%a
)

echo.
echo  服务器已停止。按任意键关闭...
pause >nul
