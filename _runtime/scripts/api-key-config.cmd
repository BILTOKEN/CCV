@echo off

REM ============================================
REM  Claude Code 便携版 - API 配置
REM ============================================
REM  只改这里就行，启动时自动同步到 settings.json
REM  获取 Key: https://platform.deepseek.com/
REM
REM  如果改了这里没生效，去 .claude 文件夹里检查
REM  settings.json 是不是被手动改过或锁定了
REM ============================================

REM ----- 配置区 -----
set "ANTHROPIC_AUTH_TOKEN=sk-10f0c9547ce34cfea6c73b372e8f30d2"
set "ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic"
set "ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro"
set "ANTHROPIC_MODEL=deepseek-v4-pro"

REM ----- 同步到 settings.json -----
powershell -NoProfile -Command "$f='%~dp0..\.claude\settings.json'; $j=Get-Content $f -Encoding UTF8 | ConvertFrom-Json; $j.env.ANTHROPIC_AUTH_TOKEN=$env:ANTHROPIC_AUTH_TOKEN; $j.env.ANTHROPIC_BASE_URL=$env:ANTHROPIC_BASE_URL; $j.env.ANTHROPIC_DEFAULT_HAIKU_MODEL=$env:ANTHROPIC_DEFAULT_HAIKU_MODEL; $j.env.ANTHROPIC_DEFAULT_SONNET_MODEL=$env:ANTHROPIC_DEFAULT_SONNET_MODEL; $j.env.ANTHROPIC_DEFAULT_OPUS_MODEL=$env:ANTHROPIC_DEFAULT_OPUS_MODEL; $j.env.ANTHROPIC_MODEL=$env:ANTHROPIC_MODEL; $j | ConvertTo-Json -Depth 10 | Set-Content $f -Encoding UTF8"

REM ----- 启动 Claude Code -----
"%~dp0..\node\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
