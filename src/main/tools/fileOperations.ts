import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import type {
  FileStatePrecondition,
  OperationKind,
  OperationPlan,
  OperationResult,
} from "../../shared/types.js"
import {
  isBinaryBuffer,
  MAX_BATCH_ITEMS,
  MAX_FILE_BYTES,
  MAX_WRITE_BYTES,
  resolveProjectPath,
  resolveProjectTarget,
} from "../security/pathGuard.js"
import { classifyOperation } from "../security/riskClassifier.js"

const MAX_PREVIEW_CHARS = 24_000

export interface FileOperationArgs {
  path?: unknown
  content?: unknown
  patch?: unknown
  from?: unknown
  to?: unknown
  expectedHash?: unknown
  expectedMtimeMs?: unknown
}

export interface FileExecutionOptions {
  trashItem?: (path: string) => Promise<void>
  isCancelled?: () => boolean
}

export interface PlannedFileOperation {
  plan: OperationPlan
  undoId?: string
  undo?: () => Promise<void>
  execute: (options?: FileExecutionOptions) => Promise<OperationResult>
}

export function planFileOperation(
  projectPath: string,
  taskId: string,
  sourceWindowId: string,
  kind: Exclude<OperationKind, "terminal.execute">,
  args: unknown,
  digest: (value: unknown) => string,
  now = Date.now(),
): PlannedFileOperation {
  const parsed = parseArgs(args)
  const classification = classifyOperation(kind)
  const operationId = randomUUID()
  const expiresAt = now + 30_000

  if (kind === "create_directory") {
    const requestedPath = requiredString(parsed.path, "path")
    const target = resolveProjectTarget(projectPath, requestedPath)
    if (exists(target)) throw new Error("目标目录已存在")
    const preconditions = [{ path: target, exists: false }]
    const undoId = randomUUID()
    const plan = makePlan(
      operationId,
      taskId,
      sourceWindowId,
      kind,
      classification,
      [target],
      `创建目录：${target}`,
      preconditions,
      digest,
      expiresAt,
      now,
    )
    return {
      plan,
      execute: async (options = {}) => {
        assertNotCancelled(options)
        const currentTarget = resolveProjectTarget(projectPath, requestedPath)
        assertPreconditions(preconditions)
        mkdirSync(currentTarget, { recursive: false })
        return completedResult(plan, `已创建目录 ${target}`, true, undoId)
      },
      undoId,
      undo: async () => rmSync(target, { recursive: false, force: false }),
    }
  }

  if (kind === "write_file" || kind === "apply_patch") {
    const requestedPath = requiredString(parsed.path, "path")
    const target = resolveProjectTarget(projectPath, requestedPath)
    const previous = readTextIfPresent(target)
    const nextContent =
      kind === "write_file"
        ? parseWriteContent(parsed.content)
        : applyTextPatch(previous?.content ?? "", requiredString(parsed.patch, "patch"))
    const preconditions = [snapshot(target)]
    assertExpected(preconditions[0]!, parsed)
    const undoId = randomUUID()
    const preview = makeTextDiff(previous?.content ?? "", nextContent, target)
    const plan = makePlan(
      operationId,
      taskId,
      sourceWindowId,
      kind,
      classification,
      [target],
      preview,
      preconditions,
      digest,
      expiresAt,
      now,
    )
    return {
      plan,
      execute: async (options = {}) => {
        assertNotCancelled(options)
        const currentTarget = resolveProjectTarget(projectPath, requestedPath)
        assertSamePath(target, currentTarget)
        assertPreconditions(preconditions)
        atomicWrite(currentTarget, nextContent, previous?.mode)
        return completedResult(plan, `已写入 ${target}`, true, undoId)
      },
      undoId,
      undo: async () => {
        if (previous) atomicWrite(target, previous.content, previous.mode)
        else rmSync(target, { force: false })
      },
    }
  }

  if (kind === "move_path") {
    const from = requiredString(parsed.from, "from")
    const to = requiredString(parsed.to, "to")
    const source = resolveProjectPath(projectPath, from)
    const target = resolveProjectTarget(projectPath, to)
    if (exists(target)) throw new Error("移动目标已存在")
    const preconditions = [snapshot(source), { path: target, exists: false }]
    assertExpected(preconditions[0]!, parsed)
    const undoId = randomUUID()
    const plan = makePlan(
      operationId,
      taskId,
      sourceWindowId,
      kind,
      classification,
      [source, target],
      `移动：${source}\n→ ${target}`,
      preconditions,
      digest,
      expiresAt,
      now,
    )
    return {
      plan,
      execute: async (options = {}) => {
        assertNotCancelled(options)
        const currentSource = resolveProjectPath(projectPath, from)
        const currentTarget = resolveProjectTarget(projectPath, to)
        assertSamePath(source, currentSource)
        assertSamePath(target, currentTarget)
        assertPreconditions(preconditions)
        renameSync(currentSource, currentTarget)
        return completedResult(plan, `已移动 ${source} 到 ${target}`, true, undoId)
      },
      undoId,
      undo: async () => {
        if (exists(source) || !exists(target)) throw new Error("撤销移动的路径前置条件不满足")
        renameSync(target, source)
      },
    }
  }

  if (kind === "trash_path") {
    const requestedPath = requiredString(parsed.path, "path")
    const target = resolveProjectPath(projectPath, requestedPath)
    const preconditions = [snapshot(target)]
    assertExpected(preconditions[0]!, parsed)
    let trashLocation: string | undefined
    const undoId = randomUUID()
    const plan = makePlan(
      operationId,
      taskId,
      sourceWindowId,
      kind,
      classification,
      [target],
      `移入废纸篓（可恢复）：${target}`,
      preconditions,
      digest,
      expiresAt,
      now,
    )
    return {
      plan,
      execute: async (options = {}) => {
        assertNotCancelled(options)
        const currentTarget = resolveProjectPath(projectPath, requestedPath)
        assertSamePath(target, currentTarget)
        assertPreconditions(preconditions)
        const trashItem = options.trashItem ?? defaultTrashItem
        await trashItem(currentTarget)
        trashLocation = findTrashLocation(target)
        return completedResult(
          plan,
          `已将 ${target} 移入废纸篓`,
          true,
          trashLocation ? undoId : undefined,
        )
      },
      undoId,
      undo: async () => {
        if (!trashLocation || !exists(trashLocation) || exists(target)) {
          throw new Error("没有找到可恢复的废纸篓项目")
        }
        renameSync(trashLocation, target)
      },
    }
  }

  throw new Error("不支持的结构化文件操作")
}

export function applyTextPatch(source: string, patch: string): string {
  if (!patch.trim() || patch.length > MAX_WRITE_BYTES) throw new Error("补丁为空或过大")
  const lines = normalizePatch(patch)
  const hunks = lines.filter((line) => line.startsWith("@@"))
  if (hunks.length === 0) throw new Error("补丁必须包含 unified diff hunk")

  const sourceLines = source.split("\n")
  const result: string[] = []
  let sourceIndex = 0
  let lineIndex = 0
  for (const header of hunks) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)
    if (!match) throw new Error("补丁 hunk 标头无效")
    const start = Number(match[1]) - 1
    while (sourceIndex < start) {
      result.push(sourceLines[sourceIndex] ?? "")
      sourceIndex += 1
    }
    lineIndex = lines.indexOf(header, lineIndex) + 1
    while (lineIndex < lines.length && !(lines[lineIndex] ?? "").startsWith("@@")) {
      const line = lines[lineIndex]
      if (line === undefined || line === "" || line.startsWith("\\ No newline")) {
        lineIndex += 1
        continue
      }
      if (line.startsWith(" ")) {
        const expected = line.slice(1)
        if (sourceLines[sourceIndex] !== expected) throw new Error("补丁上下文与当前文件不匹配")
        result.push(expected)
        sourceIndex += 1
      } else if (line.startsWith("-")) {
        const expected = line.slice(1)
        if (sourceLines[sourceIndex] !== expected) throw new Error("补丁上下文与当前文件不匹配")
        sourceIndex += 1
      } else if (line.startsWith("+")) {
        result.push(line.slice(1))
      } else {
        throw new Error("补丁行格式无效")
      }
      lineIndex += 1
    }
  }
  while (sourceIndex < sourceLines.length) {
    result.push(sourceLines[sourceIndex] ?? "")
    sourceIndex += 1
  }
  const output = result.join("\n")
  return source.endsWith("\n") && !output.endsWith("\n") ? `${output}\n` : output
}

function parseArgs(value: unknown): FileOperationArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("文件操作参数必须是对象")
  }
  const candidate = value as FileOperationArgs
  if (Object.keys(candidate).length > MAX_BATCH_ITEMS) throw new Error("参数数量超过限制")
  return candidate
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_WRITE_BYTES) {
    throw new Error(`${name} 必须是有效字符串`)
  }
  return value
}

function parseWriteContent(value: unknown): string {
  if (typeof value !== "string") throw new Error("content 必须是字符串")
  if (Buffer.byteLength(value, "utf8") > MAX_WRITE_BYTES) throw new Error("写入内容过大")
  if (value.includes("\u0000")) throw new Error("文本文件不能包含二进制空字节")
  return value
}

function readTextIfPresent(path: string): { content: string; mode: number } | undefined {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) throw new Error("目标路径不是普通文件")
    if (stats.size > MAX_FILE_BYTES) throw new Error("目标文件过大")
    const buffer = readFileSync(path)
    if (isBinaryBuffer(buffer)) throw new Error("二进制文件默认不可写")
    return { content: buffer.toString("utf8"), mode: lstatSync(path).mode }
  } catch (error) {
    if (isMissingError(error)) return undefined
    throw error
  }
}

function snapshot(path: string): FileStatePrecondition {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) throw new Error("符号链接默认不可操作")
    return {
      path,
      exists: true,
      sha256: sha256(readFileSync(path)),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    }
  } catch (error) {
    if (isMissingError(error)) return { path, exists: false }
    throw error
  }
}

function assertExpected(snapshotValue: FileStatePrecondition, args: FileOperationArgs): void {
  if (args.expectedHash !== undefined && args.expectedHash !== snapshotValue.sha256) {
    throw new Error("expectedHash 与当前文件不匹配")
  }
  if (args.expectedMtimeMs !== undefined && args.expectedMtimeMs !== snapshotValue.mtimeMs) {
    throw new Error("expectedMtimeMs 与当前文件不匹配")
  }
}

function assertPreconditions(preconditions: FileStatePrecondition[]): void {
  for (const expected of preconditions) {
    const current = snapshot(expected.path)
    if (current.exists !== expected.exists || current.sha256 !== expected.sha256) {
      throw new Error(`预览后文件已变化：${expected.path}`)
    }
    if (expected.mtimeMs !== undefined && current.mtimeMs !== expected.mtimeMs) {
      throw new Error(`预览后文件时间已变化：${expected.path}`)
    }
  }
}

function atomicWrite(path: string, content: string, mode = 0o600): void {
  const parent = dirname(path)
  const temporaryPath = join(parent, `.pingo-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode })
    chmodSync(temporaryPath, mode & 0o777)
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      // Keep the original error and never replace the original file with a partial write.
    }
    throw error
  }
}

function makePlan(
  operationId: string,
  taskId: string,
  sourceWindowId: string,
  kind: Exclude<OperationKind, "terminal.execute">,
  classification: ReturnType<typeof classifyOperation>,
  targets: string[],
  preview: string,
  preconditions: FileStatePrecondition[],
  digest: (value: unknown) => string,
  expiresAt: number,
  now: number,
): OperationPlan {
  const planInput = {
    operationId,
    sourceWindowId,
    taskId,
    kind,
    capability: classification.capability,
    risk: classification.risk,
    targets,
    preview,
    preconditions,
    reversible: classification.reversible,
  }
  const digestInput = {
    taskId,
    kind,
    capability: classification.capability,
    risk: classification.risk,
    targets,
    preview,
    preconditions,
    reversible: classification.reversible,
  }
  return {
    ...planInput,
    riskReason: classification.reason,
    digest: digest(digestInput),
    createdAt: now,
    expiresAt,
  }
}

function completedResult(
  plan: OperationPlan,
  detail: string,
  reversible: boolean,
  undoId?: string,
): OperationResult {
  return {
    operationId: plan.operationId,
    status: "completed",
    content: detail,
    detail,
    reversible,
    undoId: reversible ? undoId : undefined,
  }
}

function makeTextDiff(before: string, after: string, path: string): string {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const output = [`修改文件：${path}`, "--- 当前", "+++ 修改后"]
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < max; index += 1) {
    const oldLine = beforeLines[index]
    const newLine = afterLines[index]
    if (oldLine === newLine) output.push(`  ${oldLine ?? ""}`)
    else {
      if (oldLine !== undefined) output.push(`- ${oldLine}`)
      if (newLine !== undefined) output.push(`+ ${newLine}`)
    }
    if (output.join("\n").length > MAX_PREVIEW_CHARS) {
      output.push("（预览已截断）")
      break
    }
  }
  return output.join("\n")
}

function normalizePatch(patch: string): string[] {
  return patch
    .replace(/^\*\*\* Begin Patch\s*/m, "")
    .replace(/^\*\*\* Update File:.*$/gm, "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "))
}

async function defaultTrashItem(path: string): Promise<void> {
  const { shell } = await import("electron")
  await shell.trashItem(path)
}

function assertNotCancelled(options: FileExecutionOptions): void {
  if (options.isCancelled?.()) throw new Error("任务已取消")
}

function assertSamePath(expected: string, actual: string): void {
  if (expected !== actual) throw new Error("路径在确认后发生变化")
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isMissingError(error)) return false
    throw error
  }
}

function findTrashLocation(originalPath: string): string | undefined {
  const candidate = join(homedir(), ".Trash", basename(originalPath))
  return exists(candidate) ? candidate : undefined
}

function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}
