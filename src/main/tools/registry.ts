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
]

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
