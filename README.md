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

需要验证真实 AI Terminal 完整链路时，使用下面的独立测试。测试会把你的原始问题原样交给真实模型，由 AI 自己决定是否调用 `terminal_intent`、调用哪种只读操作和使用哪个授权目录内的相对路径；测试只自动处理 R1 只读 Terminal 的 capability/命令确认，不会替你预设问题或命令。默认授权目录是当前工作目录：

```bash
npm run test:ai-terminal -- --prompt "查看当前项目的 src 目录有哪些文件"
```

如果问题本身不需要 Terminal，可以允许测试只验证最终回答：

```bash
npm run test:ai-terminal -- --allow-no-terminal --prompt "简单介绍一下当前项目"
```

测试用例详见：[ai-terminal-directory.ts](scripts/ai-terminal-directory.ts)。

## Mini Agent（命令行闭环）

`scripts/mini-agent.ts` 是一个不依赖应用其它模块的独立 agent，用来在没有界面的情况下验证「模型能否自主调用工具并基于真实文件回答」。它提供 `list_files`、`read_file`、`run_command` 三个工具，需要 `.env` 中的 `MODEL_API_KEY`。

```bash
npm run agent -- "package.json 里的 dev 命令是什么"
npm run agent -- --debug "这个项目当前 git 分支是什么"
```

它不做任何权限拦截：命令直接执行、路径不限制在项目目录内、隐藏文件同样可见。只保留了防止撑爆上下文的限制（单文件读取 20K 字符、目录最多列 200 项、命令 60 秒超时、最多 6 轮工具循环）。因为 `.env` 对它可见，模型读取它会把 `MODEL_API_KEY` 一起发给模型服务，介意的话把 `.env` 加进脚本里的 `NOISY_DIRECTORIES`。

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
