# Pingo

**中文** | [English](./README.md)

Pingo 是一个仅支持 macOS 的 Electron 桌面伴侣 MVP：拥有自己的性格，常驻屏幕边缘，支持聊天和日常辅助。它会在你授权的项目目录内、在严格的逐次审批模型下读写文件——既能帮忙做事，又不会像开着一个裸终端。

> MVP 状态：应用是可用的早期版本。聊天上下文仅在当前应用运行期间保留，重新打开应用时会从新的空白对话开始。

## 功能

- **活的宠物** — idle 视频动画 + happy/thinking/gentle 多状态表情，可拖拽，支持托盘菜单。
- **项目助手** — 结构化文件工具（`list_files`、`search_files`、`read_file`、`write_file`、`apply_patch`、移动/废纸篓），全部限制在你授权的目录内。
- **审批优先的安全模型** — 每次写入和终端命令都由主进程规划、风险分级（R0–R4），并逐次展示操作预览确认；没有任何静默执行。
- **Trusted Workspace** — 可把单个目录标记为可信，其结构化文件操作跨重启免重复授权（终端命令仍需确认）。
- **意图白名单终端** — 只允许结构化 `executable + args` 意图（只读 git、项目质量脚本）；强制 `shell: false`，macOS Seatbelt 沙箱，Shell/解释器/sudo/网络永远禁止。
- **审计与撤销** — 每次操作都写入脱敏的 JSONL 审计日志（0600）；破坏性文件变更可通过废纸篓式撤销恢复。
- **终端运行历史** — 浏览历史运行、重跑、对比输出。
- **可配置模型** — 默认 DeepSeek；设置页可改任意兼容 Chat Completions 的接口地址与模型名。

## 架构

- Electron + React + TypeScript（electron-vite），SCSS 样式。
- Renderer 保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，只通过 preload 白名单接收任务状态、权限卡和操作预览。
- 能力授权、风险分级、审批 token、路径复检和真实执行全部由 Main Process 控制。
- 宠物窗口是透明无边框的置顶窗口；托盘菜单控制退出与显隐。

## 环境要求

- macOS（arm64；打包目标为 macOS arm64）
- Node.js 20+

## 开发运行

```bash
npm install
cp .env.example .env
# 在 .env 中填写 MODEL_API_KEY
npm run dev
```

默认模型为 `deepseek-chat`。也可以在设置页修改兼容 Chat Completions 的接口地址和模型名。

### 打包版的密钥配置

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

安装包输出到 `dist/`。当前未签名：首次启动时 macOS 会要求允许打开；公开分发前需配置 Developer ID 签名和公证。

### 独立的目录测试

只检查指定目录，不运行其他测试，也不执行 Terminal 命令：

```bash
PINGO_INSPECT_DIRECTORY="$HOME/Documents" npm run test:directory

# 可选：断言目录中存在某个相对路径文件
PINGO_INSPECT_DIRECTORY="$HOME/Documents" \
PINGO_INSPECT_EXPECT="notes/today.txt" \
npm run test:directory
```

### AI Terminal 端到端测试

把你的原始问题原样交给真实模型，由 AI 自己决定是否调用只读 `terminal_intent`；测试只自动处理 capability/命令确认，不会替你预设问题或命令。默认授权目录是当前工作目录：

```bash
npm run test:ai-terminal -- --prompt "查看当前项目的 src 目录有哪些文件"
```

如果问题本身不需要 Terminal，可以允许测试只验证最终回答：

```bash
npm run test:ai-terminal -- --allow-no-terminal --prompt "简单介绍一下当前项目"
```

测试用例详见：[ai-terminal-directory.ts](scripts/ai-terminal-directory.ts)。

### Agent Harness（离线回放）

Agent Harness 用固定的模型响应驱动真实的 `AgentOrchestrator`，所以不需要 API Key、网络或桌面界面，也不会读取或修改当前项目。它验证最终回答之外的行为轨迹：模型调用次数、工具调用与参数、步骤事件、取消和工具循环上限。

```bash
npm run harness
```

场景位于 `tests/agent-harness.test.ts`，通用回放 Runner 位于 `tests/harness/agentHarness.ts`。新增场景时，为每一轮写入一个有名称的 `modelSteps` 响应，并断言结构化轨迹或最终状态；不要把整段自然语言回答做为唯一断言。真实的权限 token、文件操作和 Terminal 沙箱链路继续由 `task-manager`、`security` 和 `terminal-security` 测试覆盖。

Harness 是确定性回归测试，不替代真实模型的端到端评估；后者仍使用 `npm run test:ai-terminal`，应在隔离环境中按需运行。

## Mini Agent（命令行闭环）

`scripts/mini-agent.ts` 是不依赖应用其它模块的独立 agent，用来在没有界面的情况下验证「模型能否自主调用工具并基于真实文件回答」。它提供 `list_files`、`read_file`、`run_command` 三个工具，需要 `.env` 中的 `MODEL_API_KEY`：

```bash
npm run agent -- "package.json 里的 dev 命令是什么"
npm run agent -- --debug "这个项目当前 git 分支是什么"
```

它**不做任何权限拦截**：命令直接执行、路径不限制在项目目录内、隐藏文件同样可见。只保留防止撑爆上下文的限制（单文件读取 20K 字符、目录最多列 200 项、命令 60 秒超时、最多 6 轮工具循环）。因为 `.env` 对它可见，模型读取它会把 `MODEL_API_KEY` 一起发给模型服务，介意的话把 `.env` 加进脚本里的 `NOISY_DIRECTORIES`。

## 安全边界

- 结构化文件工具只接受授权目录内的相对路径；`..`、绝对路径、反斜杠、符号链接越权、`.env`、密钥文件、敏感目录、二进制和超大文件默认拒绝。
- 标准模式下写入、补丁、移动、废纸篓和所有 Terminal 命令都必须逐次“允许一次”；Trusted Workspace 内的结构化文件操作不再重复确认，但仍使用原子替换、路径/文件状态复检、审计和可恢复废纸篓。
- Terminal 仅接受结构化 `executable + args + cwd` 意图，强制 `shell: false`、最小环境、超时、输出上限和取消回收；Shell、解释器、sudo、安装、网络客户端和永久删除永远阻止。
- 操作历史保存在应用数据目录的 `0600` 脱敏 JSONL 中，不保存 API Key、完整 Prompt、文件全文或未脱敏输出。
- 普通授权不会跨应用重启保留；Trusted Workspace 只持久化目录选择本身，不持久化任何命令或文件授权。

## 文档

详细方案在 `docs/` 下：

- [架构对齐与功能优先级](docs/ARCHITECTURE_ALIGNMENT.md)
- [受控文件与 Terminal 能力方案](docs/TERMINAL_CAPABILITY_PLAN.md)
- [Git 管理规范](docs/GIT_MANAGEMENT.md)

## License

MIT
