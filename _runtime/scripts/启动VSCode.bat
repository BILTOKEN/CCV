@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0..\"
set "PATH=%ROOT%node;%ROOT%PortableGit\mingw64\bin;%ROOT%PortableGit\cmd;%PATH%"
set "CLAUDE_CONFIG_DIR=%ROOT%.claude"
set "NPM_CONFIG_CACHE=%ROOT%.npm-cache"

if not exist "%ROOT%workspace\" mkdir "%ROOT%workspace\"

REM === 跨盘符会话迁移 ===
set "DRIVE=%~d0"
set "DRIVE=%DRIVE:~0,1%"
set "PROJ_DIR=%CLAUDE_CONFIG_DIR%\projects"

REM 从 ROOT 路径提取项目名（如 CCV3.1 → CCV3-1-workspace）
set "RP=%ROOT:~0,-1%"
for %%i in ("%RP%") do set "PARENT=%%~nxi"
set "PROJ=%PARENT:.=-%-workspace"

set "CUR=%DRIVE%--%PROJ%"
if not exist "%PROJ_DIR%\%CUR%" mkdir "%PROJ_DIR%\%CUR%"
if not exist "%PROJ_DIR%\%CUR%\memory" mkdir "%PROJ_DIR%\%CUR%\memory"

for /d %%d in ("%PROJ_DIR%\*--%PROJ%") do (
    set "NAME=%%~nxd"
    if /i not "!NAME!"=="%CUR%" (
        echo [CCV] 迁移旧会话: !NAME! → %CUR%
        copy "%%d\*.jsonl" "%PROJ_DIR%\%CUR%\" >nul 2>&1
        copy "%%d\memory\*" "%PROJ_DIR%\%CUR%\memory\" >nul 2>&1
        for /d %%s in ("%%d\*") do (
            if /i not "%%~nxs"=="memory" (
                if not exist "%PROJ_DIR%\%CUR%\%%~nxs\" (
                    mkdir "%PROJ_DIR%\%CUR%\%%~nxs" 2>nul
                    copy "%%s\*" "%PROJ_DIR%\%CUR%\%%~nxs\" >nul 2>&1
                )
            )
        )
    )
)

start "" "%ROOT%VSCode\Code.exe" "%ROOT%workspace"
