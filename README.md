# Pingo

Pingo 是一个仅支持 macOS 的 Electron 桌面伴侣 MVP：拥有自己的性格，支持聊天和日常辅助，并逐步建立用户明确授权的长期记忆。项目文件等开发工具能力仅作为可选的低优先级辅助。

## 开发运行

```bash
npm install
cp .env.example .env
# 在 .env 中填写 MODEL_API_KEY
npm run dev
```

架构现状、目标架构和助手功能优先级见：[架构对齐与功能优先级](docs/ARCHITECTURE_ALIGNMENT.md)。

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

- Renderer 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，只通过 preload 白名单接收任务状态、权限卡和操作预览。
- 能力授权、风险分级、审批 token、路径复检和真实执行全部由 Main Process 控制；权限默认拒绝，session 授权不会跨应用重启保留。
- 文件工具只接受用户明确授权目录内的相对路径；`..`、绝对路径、反斜杠、符号链接越权、`.env`、密钥文件、敏感目录、二进制和超大文件默认拒绝。
- 写入、补丁、移动、废纸篓和所有 Terminal 命令都必须逐次“允许一次”；写入使用原子替换并绑定文件 hash/mtime，删除只进入可恢复废纸篓。
- Terminal 仅接受结构化 `executable + args + cwd`，强制 `shell: false`、最小环境、超时、输出上限和取消回收；Shell、解释器、sudo、安装、网络客户端和永久删除永远阻止。
- 操作历史保存在应用数据目录的 `0600` 脱敏 JSONL 中，不保存 API Key、完整 Prompt、文件全文或未脱敏输出。

能力方案、风险矩阵、确认规则和验证矩阵见：[受控文件与 Terminal 能力方案](docs/TERMINAL_CAPABILITY_PLAN.md)。Developer ID 签名和公证凭据通过 electron-builder 的标准环境变量配置；本地没有证书时 `pack:mac` 可能只剩外部签名阻塞。

## Git 管理

项目的分支、提交、Review、质量门禁和发布规则见：[Git 管理规范](docs/GIT_MANAGEMENT.md)。
