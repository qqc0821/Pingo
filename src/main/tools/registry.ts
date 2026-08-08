import { listFiles } from "./listFiles.js"
import { readFile } from "./readFile.js"
import { searchFiles } from "./searchFiles.js"
import type { ToolDefinition, ToolExecution } from "./types.js"

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出用户已经授权的项目目录中的文本文件路径。不要猜测绝对路径。",
      parameters: {
        type: "object",
        properties: {
          directory: { type: "string", description: "项目内的相对目录，默认为根目录" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "在已授权项目内搜索文件名或文本内容。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜索的文件名片段或文本" },
          directory: { type: "string", description: "项目内的相对目录，默认为根目录" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取已授权项目内文本文件的有限行范围。不要读取密钥、环境变量或二进制文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对文件路径" },
          startLine: { type: "number", description: "起始行号，默认为 1" },
          endLine: { type: "number", description: "结束行号，最多读取 300 行" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "在已经授权的目录内创建一个目录；执行前必须确认预览。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "项目内相对目录路径" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或原子修改授权目录内的文本文件；执行前必须确认 diff。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对文件路径" },
          content: { type: "string", description: "完整文本内容" },
          expectedHash: { type: "string", description: "预览时的文件 sha256，可选" },
          expectedMtimeMs: { type: "number", description: "预览时的 mtime，可选" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "对授权目录内的文本文件应用 unified diff；执行前必须确认 diff。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对文件路径" },
          patch: { type: "string", description: "unified diff 补丁" },
          expectedHash: { type: "string", description: "预览时的文件 sha256，可选" },
        },
        required: ["path", "patch"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_path",
      description: "移动或重命名授权目录内的路径；执行前必须确认完整路径。",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "项目内原相对路径" },
          to: { type: "string", description: "项目内目标相对路径" },
          expectedHash: { type: "string", description: "预览时的来源 sha256，可选" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trash_path",
      description: "将授权目录内的路径移入可恢复废纸篓；执行前必须强确认。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "项目内相对路径" },
          expectedHash: { type: "string", description: "预览时的 sha256，可选" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "terminal_intent",
      description:
        "提出受限 TerminalIntent。只能使用 git.read(status/diff/log) 或 project.script(lint/typecheck/format:check/test/build)；executable、argv、环境、风险和沙箱由 Pingo 主进程决定。每条命令都要用户运行一次确认。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["git.read", "project.script"] },
          action: { type: "string", enum: ["status", "diff", "log"] },
          args: { type: "array", items: { type: "string" } },
          packageManager: { type: "string", enum: ["npm"] },
          script: { type: "string", enum: ["lint", "typecheck", "format:check", "test", "build"] },
          forwardedArgs: { type: "array", items: { type: "string" } },
          cwd: { type: "string", description: "workspace 内相对工作目录" },
        },
        required: ["kind", "cwd"],
        additionalProperties: false,
      },
    },
  },
]

export const READ_ONLY_TOOL_NAMES = new Set(["list_files", "search_files", "read_file"])

export async function executeTool(
  projectPath: string | undefined,
  name: string,
  args: unknown,
): Promise<ToolExecution> {
  if (!projectPath) {
    return {
      content: "用户尚未选择项目目录，请先让用户授权一个项目目录。",
      detail: "未选择项目目录",
    }
  }

  try {
    if (!READ_ONLY_TOOL_NAMES.has(name)) {
      return {
        content: `工具 ${name} 必须经过 Pingo 的权限和逐次确认流程。`,
        detail: `已阻止未接入 broker 的工具 ${name}`,
      }
    }
    switch (name) {
      case "list_files":
        return { content: listFiles(projectPath, args), detail: "正在列出项目文件…" }
      case "search_files":
        return { content: searchFiles(projectPath, args), detail: "正在搜索项目文件…" }
      case "read_file": {
        const path = getPathArg(args)
        return { content: readFile(projectPath, args), detail: `正在读取 ${path}` }
      }
      default:
        return { content: `不允许执行工具：${name}`, detail: `已拒绝未知工具 ${name}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "工具执行失败"
    return { content: `工具未执行：${message}`, detail: `读取被拒绝：${message}` }
  }
}

function getPathArg(value: unknown): string {
  if (typeof value !== "object" || value === null) return "目标文件"
  const path = (value as { path?: unknown }).path
  return typeof path === "string" ? path : "目标文件"
}
