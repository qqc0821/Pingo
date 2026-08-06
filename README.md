# Pingo

Pingo 是一个仅支持 macOS 的 Electron 桌面宠物 MVP：可聊天、读取用户明确授权项目中的文本文件，并通过主进程安全执行只读工具。

## 开发运行

```bash
npm install
cp .env.example .env
# 在 .env 中填写 MODEL_API_KEY
npm run dev
```

默认模型为 `deepseek-chat`。也可以在设置页修改兼容 Chat Completions 的接口地址和模型名。

从 Finder 打开的打包版会从 macOS 用户配置目录读取密钥：

```bash
mkdir -p "$HOME/Library/Application Support/pingo"
cp .env.example "$HOME/Library/Application Support/pingo/.env"
# 编辑 "$HOME/Library/Application Support/pingo/.env"，填写 MODEL_API_KEY
chmod 600 "$HOME/Library/Application Support/pingo/.env"
```

## 验证与打包

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run pack:mac
```

安装包输出到 `dist/`，当前目标为 macOS arm64。未签名应用首次启动时需要在 macOS 中允许打开；公开分发前需配置 Developer ID 签名和公证。

## 安全边界

- renderer 不持有 API Key、Node.js 或文件系统权限。
- 文件工具只接受授权项目内的相对路径。
- `..`、绝对路径、符号链接越权、`.env`、密钥文件、敏感目录、二进制和超大文件默认拒绝。
- MVP 不支持任意 Shell、修改文件、删除文件或安装软件。

## Git 管理

项目的分支、提交、Review、质量门禁和发布规则见：[Git 管理规范](docs/GIT_MANAGEMENT.md)。
