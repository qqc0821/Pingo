# Pingo Git 管理规范

## 1. 适用范围

本规范适用于 Pingo 当前的 macOS-only Electron + React + TypeScript MVP，以及后续的功能开发、缺陷修复、安全加固和 macOS 打包发布。

项目当前尚未初始化 Git 仓库。初始化后，默认分支使用 `main`，采用“短分支 + Pull Request + 主干保持可发布”的轻量流程，不设置长期维护的 `develop` 分支。

## 2. 版本库边界

### 必须提交

- `src/`：Electron 主进程、preload、renderer、共享类型和安全工具；
- `tests/`：路径保护、模型调用、环境配置等测试；
- `docs/`：产品方案、实施计划和本规范；
- `package.json` 与 `package-lock.json`：依赖和脚本必须保持一致；
- `electron.vite.config.ts`、`electron-builder.yml`、`tsconfig.json`、`eslint.config.js`、`.prettierrc.json`；
- `.gitignore`、`.env.example` 和 README 等协作配置。

### 禁止提交

以下内容已经由 `.gitignore` 忽略，禁止使用 `git add -f` 强行提交：

- `.env`、API Key、访问令牌、证书、私钥和用户配置目录；
- `node_modules/`、`out/`、`dist/`、`.vite/`、`coverage/`；
- `.DS_Store`、日志、临时配置和本地应用数据；
- 个人调试截图、下载文件和与项目无关的构建缓存。

`package-lock.json` 必须提交；它用于固定依赖版本，不能删除或用其他包管理器生成的 lockfile 替代。

## 3. 分支策略

### 分支职责

| 分支                | 用途                              | 规则                                     |
| ------------------- | --------------------------------- | ---------------------------------------- |
| `main`              | 稳定、可构建、可发布代码          | 禁止直接提交，必须通过 PR 合并           |
| `feature/<name>`    | 新功能                            | 从最新 `main` 创建，完成后及时合并并删除 |
| `fix/<name>`        | 普通缺陷修复                      | 必须包含复现或回归验证                   |
| `security/<name>`   | 安全边界、密钥、IPC、路径保护变更 | 必须补充安全测试并重点 Review            |
| `docs/<name>`       | 文档、规范和示例                  | 不修改运行时代码                         |
| `chore/<name>`      | 依赖、构建、格式化和工程维护      | 说明对产物或开发流程的影响               |
| `release/<version>` | 发布前整理                        | 仅在发布内容较多时短期使用               |

分支名称使用小写 kebab-case，例如：

```text
feature/chat-history
fix/tool-call-protocol
security/path-guard-symlink
docs/git-workflow
chore/update-electron
```

### 开发流程

```text
main
  ↓
短期工作分支
  ↓  本地质量门禁
Pull Request
  ↓  Review + CI
合并到 main
  ↓
发布时创建 vX.Y.Z 标签
```

开始工作前同步主干：

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/<short-name>
```

工作分支只保留一个明确目标。功能、无关重构、依赖升级和发布版本号不要混在同一个 PR 中。

## 4. 提交信息规范

提交信息采用 Conventional Commits：

```text
<type>(<scope>): <imperative subject>
```

推荐使用英文 type/scope，subject 可使用简洁中文或英文；subject 使用动词开头，不加句号，控制在 72 个字符以内。

### type

| type       | 使用场景                      |
| ---------- | ----------------------------- |
| `feat`     | 新增用户可见能力              |
| `fix`      | 修复缺陷                      |
| `security` | 安全加固或安全漏洞修复        |
| `test`     | 新增或调整测试                |
| `refactor` | 不改变行为的代码重构          |
| `perf`     | 性能优化                      |
| `docs`     | 文档变更                      |
| `build`    | 构建、打包、Electron 配置变更 |
| `chore`    | 依赖、脚本或杂项维护          |
| `release`  | 发布准备或版本变更            |

### scope

本项目优先使用以下 scope：

`main`、`preload`、`renderer`、`ai`、`tools`、`security`、`tests`、`build`、`docs`。

### 示例

```text
feat(renderer): 支持 Shift+Enter 换行
fix(ai): 修复工具调用消息的协议结构
security(tools): 拒绝符号链接越权访问
test(security): 增加敏感文件和路径穿越回归测试
build(mac): 修正 preload 打包格式
docs(git): 增加项目 Git 管理规范
chore(deps): 更新 Electron 依赖
```

一次提交应当是一个可理解、可回滚的逻辑单元。提交前检查：

```bash
git diff --check
git diff --staged --check
git status --short
```

不要提交以下类型的内容：`WIP`、`临时修改`、`修一下`、混合多个无关主题的“大杂烩提交”，以及把密钥删除但不说明泄漏处置的提交。

需要说明背景、风险或迁移步骤时，在 subject 后增加正文：

```text
fix(security): 限制工具路径必须位于授权目录内

- 拒绝绝对路径和 .. 片段
- 校验 realpath，阻止符号链接绕过
- 增加路径越权回归测试
```

## 5. 本项目质量门禁

### 日常代码提交前

涉及 `src/`、`tests/` 或配置的提交至少执行：

```bash
npm run lint
npm run typecheck
npm run test
npm run format:check
```

### PR 合并前

除上述检查外，运行生产构建：

```bash
npm run build
```

安全、IPC、模型协议、环境变量加载或工具注册发生变化时，必须同时满足：

- 有针对性的回归测试；
- 没有把 API Key、完整 Prompt、用户文件内容写入日志或测试快照；
- 检查 renderer 是否仍未获得 Node.js、文件系统和密钥权限；
- 检查主进程是否继续执行参数、路径和工具白名单校验。

### 发布前

在 macOS arm64 环境执行：

```bash
npm run lint
npm run typecheck
npm run test
npm run format:check
npm run build
npm run pack:mac
```

发布验收至少确认：DMG/ZIP 可生成、应用可启动、preload 无加载错误、对话和只读文件工具可用、密钥不会进入前端产物。当前未配置 Developer ID 时可以生成内部测试包，但不能把它标记为公开分发版本。

## 6. Pull Request 规范

PR 标题沿用提交格式，例如：`fix(ai): 修复多轮工具调用协议`。

PR 描述至少包含：

```text
## 变更内容
-

## 影响范围
- main / preload / renderer / tools / build / docs

## 验证结果
- [ ] npm run lint
- [ ] npm run typecheck
- [ ] npm run test
- [ ] npm run format:check
- [ ] npm run build
- [ ] npm run pack:mac（发布或打包变更时必选）

## 风险与回滚
- 风险：
- 回滚方式：
```

Review 优先关注：

- 行为是否与当前 MVP 范围一致；
- Electron 主进程、preload、renderer 的权限边界是否被扩大；
- 文件工具是否仍只允许授权目录内的只读操作；
- 新增逻辑是否有测试，尤其是安全和协议代码；
- 是否引入了不必要的依赖、包体或启动行为变化；
- 文档、环境变量名称和实际代码是否一致。

至少一名维护者批准后才能合并。优先使用 squash merge，让 `main` 保持清晰的功能级提交；禁止使用未经确认的强制 push 改写 `main` 历史。

## 7. 版本与发布

采用 Semantic Versioning：

- `MAJOR`：不兼容的配置、IPC 或用户行为变更；
- `MINOR`：向后兼容的新功能；
- `PATCH`：向后兼容的缺陷、安全和文档修复。

版本号必须同步更新 `package.json` 和 `package-lock.json`。标签使用带 `v` 前缀的 annotated tag：

```bash
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin main
git push origin v0.1.1
```

发布提交建议使用：

```text
release: v0.1.1
```

发布说明应包含：新增功能、修复问题、安全影响、已知限制、DMG/ZIP 文件名、支持平台和签名/公证状态。 `dist/` 中的 DMG、ZIP 和 App 是构建产物，不进入 Git；应通过 Release 附件或制品存储分发。

## 8. 密钥与敏感信息处置

- `.env.example` 只保留变量名和空值/占位符，不能放真实 Key；
- 开发环境使用项目根目录 `.env`，打包应用按 README 使用 macOS 用户配置目录；
- 提交前必须检查 `git diff --staged`，确认没有 API Key、用户路径、文件内容和个人信息；
- 一旦密钥进入 Git 历史，立即撤销/轮换密钥，再讨论历史清理；仅删除当前文件或 `git rm --cached` 不能消除历史泄漏；
- 日志、Issue、PR 和测试输出不得包含完整密钥、Authorization Header、完整 Prompt 或用户项目内容。

## 9. 仓库初始化建议

首次建立远程仓库时，在项目根目录执行：

```bash
git init
git branch -M main
git add .
git diff --cached --check
git status --short
git commit -m "chore(repo): initialize Pingo repository"
git remote add origin <remote-url>
git push -u origin main
```

初始化前确认 `.env` 未被加入暂存区，且 `node_modules/`、`out/`、`dist/` 已被忽略。远程仓库启用以下保护：禁止直接 push `main`、要求 PR Review、要求质量门禁通过、禁止未签名或未经审查的强制 push。

## 10. 常用操作速查

```bash
# 查看当前状态和最近提交
git status --short --branch
git log --oneline --decorate -10

# 暂存前检查
git diff --check
git diff --stat
git diff -- . ':!package-lock.json'

# 同步主干并变基
git fetch origin
git rebase origin/main

# 只查看将要提交的内容
git diff --cached

# 合并后删除本地工作分支
git branch -d feature/<short-name>
```

本规范与 `package.json` 中的实际脚本保持一致；新增脚本、分支类型或发布流程时，应先更新本文件，再在 PR 中说明原因。
