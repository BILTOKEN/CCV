# CCV v4.2 — Claude Code Vision

> 便携版 AI 编程助手，插上 U 盘就能用。

## 什么是 CCV

CCV 是一个便携的 AI 编程助手启动器，集成了：
- **AI 网页版** — 浏览器里的 ChatGPT 式聊天，支持智能体模式（读写文件、执行命令、生成文档）
- **Claude Code 终端** — Anthropic Claude Code CLI，完整编程能力
- **VS Code 编辑器** — 便携版 VS Code，预装 Claude Code 扩展

## 快速开始

1. 申请 API Key（推荐 [DeepSeek](https://platform.deepseek.com)）
2. 双击 `CCV v4.2 启动器.exe`
3. 点「配置 API 密钥」→ 粘贴 Key → 保存
4. 点「AI 网页版」开始使用

## 目录结构

```
CCV v4.2/
├── CCV v4.2 启动器.exe    # 启动器
├── 使用说明.html          # 详细教程
├── workspace/             # AI 工作目录
└── _runtime/              # 运行时引擎
    ├── dashboard/         # 网页服务
    ├── scripts/           # 启动脚本
    ├── images/            # 图片资源
    └── ...
```

## 安装依赖（仅开发需要）

```bash
npm install --prefix _runtime/dashboard
```

便携版用户无需安装，`_runtime/node_modules/` 已包含所有依赖。

## 作者

**Bill偷啃** — [B站主页](https://space.bilibili.com/379802977)

联系：B站私信

## 许可证

MIT
