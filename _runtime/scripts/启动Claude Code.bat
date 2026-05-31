@echo off
title Claude Code Portable

setlocal

set "ROOT=%~dp0..\"

call "%~dp0api-key-config.cmd"

set "PATH=%ROOT%node;%ROOT%PortableGit\mingw64\bin;%ROOT%PortableGit\cmd;%PATH%"
set "CLAUDE_CONFIG_DIR=%ROOT%.claude"
set "npm_config_cache=%ROOT%.npm-cache"
set "npm_config_prefix=%ROOT%node"

cd /d "%ROOT%workspace"

:: 自动查找 claude.exe（兼容不同版本的目录名）
for /d %%d in ("%ROOT%node\node_modules\@anthropic-ai\.claude-code*") do (
    for /d %%p in ("%%d\node_modules\@anthropic-ai\claude-code-win32-x64") do (
        if exist "%%p\claude.exe" (
            "%%p\claude.exe"
            goto :done
        )
    )
)
echo [CCV4.0] Claude Code CLI 未找到
:done

endlocal
