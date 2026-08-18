import { listFiles } from "./listFiles.js"
import { readFile } from "./readFile.js"
import { searchFiles } from "./searchFiles.js"
import type { ToolDefinition, ToolExecution } from "./types.js"
import {
  buildTerminalIntentSchema,
  getEnabledIntentPackDefinitions,
} from "../terminal/intentPacks.js"

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出当前项目目录中的项目文件路径。不要猜测绝对路径。",
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
      description: "在当前项目内搜索文件名或文本内容。",
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
      description: "读取当前项目内文本文件的有限行范围。不要读取密钥、环境变量或二进制文件。",
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
      description: "在当前项目目录内创建一个目录。",
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
      description: "创建或原子修改当前项目目录内的文本文件。",
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
      description: "对当前项目目录内的文本文件应用 unified diff。",
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
      description: "移动或重命名当前项目目录内的路径。",
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
      description: "将当前项目目录内的路径移入可恢复废纸篓。",
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
      description: `提出受限 TerminalIntent。可用清单：${getEnabledIntentPackDefinitions()
        .map((definition) => definition.kind)
        .join("、")}；executable、argv、环境、风险和沙箱由 Pingo 主进程决定。`,
      parameters: buildTerminalIntentSchema(),
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
      content: "当前项目目录不可用，请检查项目位置后重试。",
      detail: "项目目录不可用",
    }
  }

  try {
    if (!READ_ONLY_TOOL_NAMES.has(name)) {
      return {
        content: `工具 ${name} 不支持直接执行。`,
        detail: `已阻止未接入执行器的工具 ${name}`,
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
    return { content: describeToolFailure(error, message), detail: `读取被拒绝：${message}` }
  }
}

/**
 * 文件系统错误直接回给模型时不应被误读为整个项目目录不可用。
 * 这里把 errno 翻译成只描述单个目标的提示，并保留下一步动作。
 */
function describeToolFailure(error: unknown, fallbackMessage: string): string {
  switch (getErrorCode(error)) {
    case "ENOENT":
      return "工具未执行：这个相对路径在当前项目中不存在。项目目录本身仍然可用，请先用 list_files 确认真实路径再重试。"
    case "EACCES":
    case "EPERM":
      return "工具未执行：这个路径没有读取权限，已跳过。项目目录本身仍然可用，请改用目录内的其他路径。"
    case "EISDIR":
      return "工具未执行：这个路径是目录而不是文件，请改用 list_files 查看它的内容。"
    case "ENOTDIR":
      return "工具未执行：这个路径是文件而不是目录，请改用 read_file 读取它。"
    default:
      return `工具未执行：${fallbackMessage}`
  }
}

function getErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return ""
  const code = (error as { code: unknown }).code
  return typeof code === "string" ? code : ""
}

function getPathArg(value: unknown): string {
  if (typeof value !== "object" || value === null) return "目标文件"
  const path = (value as { path?: unknown }).path
  return typeof path === "string" ? path : "目标文件"
}
