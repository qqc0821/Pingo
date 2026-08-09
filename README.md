# Pingo

Pingo 是一个仅支持 macOS 的 Electron 桌面伴侣 MVP：拥有自己的性格，支持聊天和日常辅助。聊天上下文仅在当前应用运行期间保留，重新打开应用时会从新的空白对话开始；项目文件等开发工具能力仅作为可选的低优先级辅助。

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

只检查指定目录时，使用独立的目录测试；它不会运行其他测试，也不会执行 Terminal 命令：

```bash
PINGO_INSPECT_DIRECTORY="$HOME/Documents" npm run test:directory

# 可选：断言目录中存在某个相对路径文件
PINGO_INSPECT_DIRECTORY="$HOME/Documents" \
PINGO_INSPECT_EXPECT="notes/today.txt" \
npm run test:directory
```

需要验证真实 AI Terminal 完整链路时，使用下面的独立测试。它会让真实模型调用 `terminal_intent`，自动完成本测试专用的一次 capability/命令确认，并在 macOS Seatbelt 沙箱中执行受限的 `ls -1`；不会运行其他测试：

```bash
PINGO_INSPECT_DIRECTORY="$HOME/Documents" \
PINGO_INSPECT_EXPECT="notes/today.txt" \
npm run test:ai-terminal-directory
```

该测试只开放 `directory.list` 只读 intent；不会执行 Shell、写入、删除、安装或联网命令。测试用例详见：[ai-terminal-directory.ts](scripts/ai-terminal-directory.ts)。

## AI Lab（无界面只读闭环）

在接入正式对话前，可用独立的 AI Lab 对模型回答和工具调用做回归测试。无参数时运行 Legacy runtime 的虚拟场景；提供 `--project` 后使用真实项目的只读 runtime，模型只会看到 `list_files`、`search_files`、`read_file` 三个工具，所有读取仍经过 Pingo 的路径防护。

```bash
# 运行全部虚拟基准用例（需要 .env 中的 MODEL_API_KEY）
npm run ai:lab

# 运行真实项目只读场景，默认使用 Vercel AI SDK runtime
npm run ai:lab -- --project . --runtime vercel

# 自由提问（必须同时提供真实项目）
npm run ai:lab -- --project . --runtime vercel --prompt "读取 package.json，说明这个项目的名称和测试命令"

# 仅调试虚拟项目读取或写入拦截用例
npm run ai:lab -- --scenario project-read
npm run ai:lab -- --scenario blocked-write --json

# 对比 Legacy/Vercel runtime 或另一兼容接口，不改动应用设置
npm run ai:lab -- --project . --runtime legacy --scenario real-list,real-search,real-no-tool
npm run ai:lab -- --project . --runtime vercel --model your-model --base-url https://example.com/v1
```

报告包含 `runtime`、`environment`、`fallbackUsed`、工具轨迹、最终回答、停止原因和逐项通过/失败结果；失败时命令以非零状态退出。虚拟与真实场景不能混用，`--prompt` 与 `--scenario` 互斥。

模型诊断只对 AI Lab 生效：默认关闭；`PINGO_DEBUG_MODEL=1` 写入脱敏的协议摘要，`PINGO_DEBUG_MODEL=raw` 才写入有大小上限的脱敏 request/response body。日志位于 `~/Library/Logs/Pingo/`，可能包含提示词和项目片段，请仅在本地调试时开启。

安装包输出到 `dist/`，当前目标为 macOS arm64。未签名应用首次启动时需要在 macOS 中允许打开；公开分发前需配置 Developer ID 签名和公证。

## 安全边界

- Renderer 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，只通过 preload 白名单接收任务状态、权限卡和操作预览。
- 能力授权、风险分级、审批 token、路径复检和真实执行全部由 Main Process 控制；普通 session 授权不会跨应用重启保留。首次启动可由用户为单个目录开启 Trusted Workspace，目录内结构化文件操作可跨重启免重复授权，但不包含 Terminal、项目脚本或目录外访问。
- 文件工具只接受用户明确授权目录内的相对路径；`..`、绝对路径、反斜杠、符号链接越权、`.env`、密钥文件、敏感目录、二进制和超大文件默认拒绝。
- 标准模式下写入、补丁、移动、废纸篓和所有 Terminal 命令都必须逐次“允许一次”；Trusted Workspace 内的结构化文件操作不再重复确认，但仍使用原子替换、路径/文件状态复检、审计和可恢复废纸篓。
- Terminal 仅接受结构化 `executable + args + cwd`，强制 `shell: false`、最小环境、超时、输出上限和取消回收；Shell、解释器、sudo、安装、网络客户端和永久删除永远阻止。
- 操作历史保存在应用数据目录的 `0600` 脱敏 JSONL 中，不保存 API Key、完整 Prompt、文件全文或未脱敏输出。

能力方案、风险矩阵、确认规则和验证矩阵见：[受控文件与 Terminal 能力方案](docs/TERMINAL_CAPABILITY_PLAN.md)。Developer ID 签名和公证凭据通过 electron-builder 的标准环境变量配置；本地没有证书时 `pack:mac` 可能只剩外部签名阻塞。

## Git 管理

项目的分支、提交、Review、质量门禁和发布规则见：[Git 管理规范](docs/GIT_MANAGEMENT.md)。
