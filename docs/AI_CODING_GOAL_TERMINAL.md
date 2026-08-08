# Pingo Terminal Capability — AI Coding Goal

下面内容可直接作为 AI Coding Agent 的 Goal 提示词使用。

```text
你是一名负责 Electron、TypeScript、macOS 和安全工程的资深 Coding Agent。请在当前 Pingo 仓库中，完整实现“结构化文件操作 + 受限 Terminal”能力。

开始编码前，必须先完整阅读：

- docs/TERMINAL_CAPABILITY_PLAN.md
- README.md
- docs/ARCHITECTURE_ALIGNMENT.md
- src/main/ipc.ts
- src/main/ai/client.ts
- src/main/tools/registry.ts
- src/main/security/pathGuard.ts
- src/preload/index.ts
- src/shared/types.ts
- src/renderer/src/App.tsx
- tests/ai.test.ts
- tests/security.test.ts

将 docs/TERMINAL_CAPABILITY_PLAN.md 视为已确认的产品与安全契约。如果实现细节与该文档冲突，以文档中的安全边界为准。不要擅自把范围扩大为任意 Shell、系统自动化或未授权的电脑控制。

## 1. 你的目标是什么

在 Pingo 中实现一个端到端、默认拒绝、可审计、可撤销的电脑操作闭环，使用户能够通过 AI 任务面板：

1. 在执行任何文件或 Terminal 操作前，先向 Pingo 授予明确的能力权限和目录范围。
2. 在用户授权目录内执行普通文件读取、搜索和列表操作。
3. 通过结构化工具创建目录、创建/修改文本文件、应用补丁、移动/重命名文件以及将文件移入废纸篓。
4. 运行策略明确允许的受限 Terminal 命令。
5. 在任何文件变更、删除或 Terminal 命令执行前，展示精确且不可变的操作预览，并获得用户“允许一次”的明确确认。
6. 支持拒绝、确认超时、取消任务、撤销权限、命令超时、输出截断、失败恢复和可行的文件撤销。
7. 展示任务状态和脱敏操作历史，让用户能看见 Pingo 正在等待什么、执行什么以及执行结果。
8. 保持 Electron Renderer 沙箱化，并完成 macOS Hardened Runtime、最小 entitlements、签名/公证所需的项目配置。

当前分支曾在提交 6281de2 中主动移除聊天功能。可以读取 6281de2 的父提交作为旧 Chat IPC/UI 的实现参考，但禁止直接 revert、cherry-pick 或覆盖当前宠物和设置功能。应恢复一个与当前界面兼容的受控任务入口，并加入以下状态：

proposed
→ awaiting_permission
→ planning
→ awaiting_confirmation
→ executing
→ completed | failed | cancelled

### 必须遵守的安全契约

- 模型只能提出结构化操作请求，不能决定权限、风险等级或确认结果。
- Renderer 只能展示信息并提交 taskId、operationId 和 approve/deny，不能获得 Node.js、文件系统、child_process、ipcRenderer 或通用命令接口。
- 授权、风险判定、确认状态和执行必须全部由 Electron Main Process 控制。
- 未获得有效授权时，底层文件写 API、废纸篓 API 和进程启动 API必须保持 0 次调用。
- 所有高权限 IPC 必须校验 sender、参数结构、长度、枚举值和任务归属关系。
- `workspace.read` 可以在用户明确授权后执行普通只读操作。
- `workspace.write` 和 `terminal.execute` 的基础授权默认最多持续到当前会话结束。
- 所有文件变更以及所有 Terminal 命令必须逐次确认，不允许“始终允许”。
- 确认必须绑定到 Main Process 保存的规范化 OperationPlan 和 digest。Renderer 不得回传可被替换的命令、路径或文件内容。
- 批准 token 只能使用一次，必须有短 TTL，不能跨 task、window 或 session 重放。
- 批准后执行前，必须重新校验权限、风险、路径、符号链接、文件 hash/mtime 和操作 digest；任何变化都要求重新预览和确认。
- 绝对路径、`..`、反斜杠绕过、符号链接/alias 越权、敏感目录、敏感扩展名和授权目录外访问必须拒绝。
- 删除只能移入废纸篓；V1 不允许永久删除。
- 文件写入必须使用临时文件和原子替换，并避免预览后文件发生变化时覆盖新内容。
- Terminal 必须使用 executable + args 数组直接启动，强制 `shell: false`。禁止接收或执行拼接后的命令字符串。
- Terminal 必须使用最小环境变量，不得向子进程传递 MODEL_API_KEY 或其他应用密钥。
- Terminal 默认无 stdin/TTY，设置 cwd、超时、stdout/stderr 上限、并发上限，并在取消时回收完整子进程树。
- Shell、解释器、sudo、osascript、安装/卸载、持久化服务、系统安全设置、永久删除、未受控网络客户端和未知程序属于 R4；即使 UI 收到确认也不得执行。
- `npm run`、测试、构建等会执行仓库代码的命令属于 R3，必须逐次强确认。
- 独立进程或 Electron utilityProcess 只能用于故障隔离和取消管理，不能被当作完整文件系统安全沙箱。
- 操作日志不得保存密钥、完整 Prompt、文件全文或未脱敏的敏感输出。

### 需要完成的主要模块

1. 受控任务入口
   - 恢复任务输入、AI 事件、取消和任务状态 UI。
   - 保留当前桌面宠物、设置、拖动和状态表现。
   - 等待权限/确认时切换到 needs-action，执行时切换到 working。

2. 共享类型和 IPC
   - 定义 CapabilityGrant、Capability、OperationPlan、ApprovalRequest、OperationDecision、OperationResult、TaskState 和 AuditRecord。
   - 在 preload 中只暴露一事一方法的白名单 API。
   - 增加能力申请/查询/撤销、任务提交/取消、确认响应和任务事件通道。

3. Main Process 安全层
   - 实现 capabilityManager、riskClassifier 和 approvalBroker。
   - 使用 deny-by-default 策略。
   - 主进程保存 pending operation，生成规范化 digest，并管理 TTL、一次性使用、取消和撤销。
   - 不信任模型声称的风险等级或“用户已同意”。

4. 结构化文件工具
   - 保留并接入 list_files、search_files、read_file。
   - 新增 create_directory、write_file、apply_patch、move_path 和 trash_path。
   - 扩展 pathGuard，使其能安全处理尚不存在的新目标路径、真实父目录和检查/使用竞态。
   - 实现 diff/清单预览、expectedHash/mtime、原子写入和可行的撤销记录。

5. 受限 Terminal
   - 实现 commandPolicy 和 runner。
   - 使用 executable/子命令/参数规则表，不使用字符串黑名单替代结构化验证。
   - 第一版只开放少量经过测试的命令；rm、mv、cp 必须继续走结构化文件工具。
   - 对 git 只读命令禁用 pager、external diff 和不受信任的全局配置。
   - 对 timeout、output limit、exit code、signal、cancel 和进程树清理提供明确结果。

6. AI 工具循环
   - 重构 ModelClient 当前覆盖整个工具循环的 60 秒计时和 10 秒工具计时。
   - 将其拆分为单次网络请求超时、用户决定 TTL 和批准后执行超时。
   - 等待用户授权或确认的时间不能被当成模型或工具超时。
   - 用户拒绝后返回结构化 denied 结果，禁止同一操作反复弹窗。

7. 日志、撤销和权限管理
   - 在应用数据目录中保存权限为 0600 的脱敏操作日志。
   - 提供操作历史、撤销授权和可行的文件撤销入口。
   - 撤销操作本身重新经过风险分级和确认。

8. Electron/macOS 加固
   - 保持 contextIsolation: true、nodeIntegration: false、sandbox: true。
   - 添加严格 CSP、导航限制、新窗口限制和所有高权限 IPC sender 校验。
   - 将 hardenedRuntime 配置为 true，增加最小 entitlements，并补充签名和公证说明。
   - 不要为了 Terminal 能力关闭 Renderer 沙箱或 Context Isolation。

优先复用当前代码结构和 Node/Electron 内置能力。除非确有必要，不增加大型依赖。不要修改、删除或覆盖与本目标无关的用户代码和未提交改动。

按可验证的垂直切片实施：每完成一个阶段立即补充测试并运行相关门禁，不要先写完全部代码再集中测试。任何工具在接入真实执行器前，必须先有拒绝路径和授权/确认测试。

## 2. 如何验证结果

### 自动化验证

必须新增或扩展测试，至少覆盖以下场景：

权限与确认：

- 未授权、拒绝、关闭弹窗、确认超时均不会调用文件写 API 或 spawn。
- session grant 在应用重启后失效。
- 撤销权限使待确认请求、批准 token 和运行任务立即失效。
- approval 不能重复使用、跨任务使用、跨窗口使用或在过期后使用。
- operationId、digest、路径、参数、风险或文件 hash/mtime 改变后拒绝执行并重新请求确认。
- 非 Pingo 主窗口 sender 无法申请权限、读取授权状态、批准或执行任务。

路径与文件：

- 授权目录内的正常增删改查成功。
- 绝对路径、`..`、反斜杠、符号链接、alias、敏感目录和敏感扩展名被拒绝。
- 新建目标的父目录越权和检查/执行竞态被拒绝。
- 原子写入失败时原文件保持完整。
- 预览后文件变化时不会覆盖。
- 超大文件、二进制文件、批量数量/总大小超限安全失败。
- trash_path 可恢复且有审计记录；不存在永久删除入口。

Terminal：

- executable 与每个 arg 分开传递，Shell 元字符只作为普通参数，不会被解释。
- shell、解释器、sudo、osascript、安装器、网络客户端和未知程序被拒绝。
- cwd 越权、环境变量泄密、stdin/TTY 依赖、超时、输出超限、非零退出码和 signal 均有确定结果。
- 取消后没有残留子进程或后代进程。
- 所有 Terminal 命令，包括只读命令，都先触发 R3 操作预览和逐次确认。
- npm run、测试和构建命令不能绕过强确认。

AI、任务和 UI：

- 普通聊天/任务仍可完成和取消。
- 任务状态按照状态机转换，不会在拒绝、失败或取消后卡死。
- 等待用户确认不会触发模型网络超时或执行超时。
- 确认卡完整展示 cwd、命令/参数、路径、diff/文件清单、风险原因和可撤销性。
- Renderer 无 Node.js、文件系统、child_process、ipcRenderer 或通用执行接口。

回归与构建：

在最终交付前必须全部运行并通过：

npm run lint
npm run typecheck
npm test
npm run build
npm run pack:mac

如果 pack:mac 因缺少 Developer ID 或公证凭据而无法完成在线签名，只能将其记录为外部凭据阻塞；仍需完成本地打包、Hardened Runtime/entitlements 配置校验和其余全部自动测试。

### 手工验收流程

至少验证以下完整流程，并记录结果：

1. 首次启动后请求读取项目；Pingo 先申请目录和 read 权限，拒绝时不读取。
2. 授权 read 后读取普通文件成功，敏感文件仍被拒绝。
3. 请求修改文件；展示准确 diff，拒绝后文件不变，允许一次后原子写入成功。
4. 请求移动和删除文件；展示完整路径，删除进入废纸篓，并可从操作历史发起撤销。
5. 请求运行允许命令；展示 executable、args 和 cwd，确认后返回 exit code 和输出。
6. 请求 Shell、sudo、解释器、安装、永久删除、越权目录；全部被 Main Process 阻止。
7. 等待确认期间取消任务、撤销权限或关闭窗口；不执行且没有残留进程。
8. 修改确认卡对应文件后再批准；旧批准失效并要求重新预览。
9. 重启应用；session 写入和 Terminal 授权失效。
10. 在打包版 macOS 应用中重复关键授权、确认、取消和撤销流程。

### 完成判定

只有同时满足以下条件才能报告目标完成：

- 上述端到端能力全部实现。
- 所有新增安全测试和现有回归测试通过。
- lint、typecheck、test、build 通过。
- pack:mac 通过，或唯一未完成项是明确记录的外部签名/公证凭据。
- 没有任意 Shell、永久删除、提权、敏感文件或 Renderer 通用执行后门。
- 文档已更新，明确权限范围、确认规则、撤销方式、禁止能力和验证结果。
- `git diff --check` 通过，最终 diff 不包含无关改动、密钥、生成缓存或敏感日志。

## 3. 停止条件

成功停止：

- 仅当“完成判定”中的条件全部满足，并给出修改文件、架构决策、测试结果、剩余外部阻塞和已知限制的总结后停止。
- 不得因为 UI 已出现、单个命令能运行或部分测试通过就提前宣布完成。

安全停止并请求用户决定：

- 实现需要开放任意 Shell、解释器、sudo、系统安全设置、未授权目录、永久删除或其他 R4 能力。
- 需要关闭 contextIsolation、Renderer sandbox 或扩大 preload/IPC 为通用执行接口。
- 现有产品需求与 docs/TERMINAL_CAPABILITY_PLAN.md 的安全契约发生实质冲突。
- 必须新增会显著扩大供应链或原生权限面的依赖，且没有更小的安全实现。
- 发现当前工作区存在与目标文件重叠、无法安全保留的用户未提交改动。
- 需要执行破坏性 Git 操作、删除用户数据或进行未授权的外部系统变更。

阻塞停止：

- 同一技术阻塞经过诊断、替代方案和重新设计三次仍无法在安全边界内继续。
- 缺少只能由用户提供的证书、账号、硬件或系统权限；此时完成所有不依赖该外部条件的工作，记录准确复现步骤和剩余验证，不得伪造通过结果。
- 安全测试证明授权、确认、路径隔离或命令策略存在可绕过问题，且当前方案无法修复；不得以风险说明代替修复后继续交付。

最终回复必须包含：

- 实现结果摘要。
- 关键安全边界及其代码位置。
- 新增/修改文件清单。
- 自动化命令及真实结果。
- 手工验收结果。
- 未完成项、外部阻塞和已知限制。
- 用户如何授权、确认、取消和撤销权限的简要说明。
```

