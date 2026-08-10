# Pingo

**中文** | [English](./README.md)

<p align="center">
  <strong>一个常驻桌面、会记住上下文、会调用工具并真正把事情做完的 AI 伙伴。</strong>
</p>

![Pingo 把一句请求变成调用工具完成项目任务的闭环](docs/pingo-agent-demo-zh-CN.gif)

<p align="center">
  <sub>说出目标 → 检查项目 → 调用工具 → 给出结果 → 记住下一步。</sub>
</p>

## 一句话进去，一个闭环出来

你对 Pingo 说：“看看我今天项目还有什么没完成。”它会检查 Git 状态、读取项目任务、调用限定在工作区内的工具、整理剩余事项，并带着下一步继续协作——入口就是那个一直陪在桌面上的小家伙。

> **Cute 只是第一眼。Agentic 才是留下来的理由。**

Pingo 不是给聊天窗口套上一层宠物皮肤。桌宠是一个随时在场的 Agent 入口：它理解你的项目，用可见、可控的方式采取行动，帮你把事情真正收尾。

> **MVP 状态：** Pingo 是可运行的 macOS 早期版本。上方分镜使用 Pingo 当前视觉素材预览产品工作流；对话上下文会在本次运行期间保留，但重启后仍会从空白对话开始，暂不支持跨启动记忆。

## Pingo 能做什么

- **一直在桌面上** — 可拖拽的动画伙伴，拥有 idle、happy、thinking、gentle 多种状态，并支持托盘控制。
- **理解你的工作区** — 在你授权的目录内列出、搜索和读取项目文件。
- **真正调用工具** — 写入和补丁文件、移动到可恢复废纸篓、检查 Git，以及运行获准的项目质量脚本。
- **让控制权始终在你手里** — 高风险操作会被分级、预览并逐次确认；不会静默执行。
- **把任务做成闭环** — 查看任务进度与结果，回顾、重跑 Terminal 历史，并对比输出。
- **使用你选择的模型** — 默认 DeepSeek，也可以配置任意兼容 Chat Completions 的接口和模型。

### 有用的自主性，不等于不受限的权限

Pingo 把工作区限定的文件工具、意图白名单 Terminal、macOS Seatbelt 沙箱、脱敏审计日志和可恢复的破坏性操作组合在一起。Trusted Workspace 可以减少重复的文件确认，但 Terminal 命令仍然需要审批。

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
