@echo off
setlocal

set "ROOT=%~dp0..\"

set "PATH=%ROOT%node;%ROOT%PortableGit\mingw64\bin;%ROOT%PortableGit\cmd;%PATH%"
set "CLAUDE_CONFIG_DIR=%ROOT%.claude"
set "npm_config_cache=%ROOT%.npm-cache"
set "npm_config_prefix=%ROOT%node"

cd /d "%ROOT%workspace"

set "CLAUDE_EXE="
for /d %%d in ("%ROOT%node\node_modules\@anthropic-ai\.claude-code*") do (
    for /d %%p in ("%%d\node_modules\@anthropic-ai\claude-code-win32-x64") do (
        if exist "%%p\claude.exe" set "CLAUDE_EXE=%%p\claude.exe"
    )
)

if defined CLAUDE_EXE (
    "%CLAUDE_EXE%"
    exit /b 0
)

echo [CCV4.0] Claude Code CLI not found
exit /b 1
