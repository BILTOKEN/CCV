@echo off
setlocal
title AI Dashboard - DeepSeek

set "ROOT=%~dp0..\"
set "PATH=%ROOT%node;%ROOT%PortableGit\mingw64\bin;%ROOT%PortableGit\cmd;%PATH%"

REM 打开浏览器
start http://localhost:3000

REM 生成 VBS 脚本，静默启动 node（窗口隐藏）
echo CreateObject("WScript.Shell").Run """%ROOT%node\node.exe"" ""%ROOT%dashboard\server.mjs""", 0, False > "%TEMP%\run_dashboard.vbs"
cscript //nologo "%TEMP%\run_dashboard.vbs"
del "%TEMP%\run_dashboard.vbs"

endlocal
