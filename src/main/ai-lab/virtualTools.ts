import type { ToolExecution } from "../tools/types.js"
import type { AiLabToolTrace } from "./types.js"

const VIRTUAL_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "pingo-ai-lab-fixture",
      version: "0.1.0",
      scripts: { dev: "electron-vite dev", test: "tsx --test tests/*.test.ts" },
    },
    null,
    2,
  ),
  "README.md": "# AI Lab Fixture\n\nThis project starts locally with `npm run dev`.\n",
  "src/main/index.ts": "app.whenReady().then(() => createPetWindow(store))\n",
}

const READ_ONLY_TOOLS = new Set(["list_files", "search_files", "read_file"])

export function isAiLabReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

/**
 * 仅模拟工具结果：不读取工作区、不创建进程、不写入磁盘。
 * 即使模型请求 write_file / terminal_intent，也只返回明确的策略拒绝。
 */
export async function executeAiLabTool(
  name: string,
  args: unknown,
  traces: AiLabToolTrace[],
): Promise<ToolExecution> {
  const result = executeVirtualTool(name, args)
  traces.push({
    name,
    args,
    detail: result.detail,
    content: result.content,
    mutating: !isAiLabReadOnlyTool(name),
  })
  return result
}

function executeVirtualTool(name: string, args: unknown): ToolExecution {
  if (name === "list_files") {
    return {
      content: Object.keys(VIRTUAL_FILES).join("\n"),
      detail: "AI Lab：已列出虚拟项目文件",
    }
  }

  if (name === "read_file") {
    const path = stringArg(args, "path")
    const content = path ? VIRTUAL_FILES[path] : undefined
    return content === undefined
      ? { content: `虚拟文件不存在：${path || "(未提供路径)"}`, detail: "AI Lab：读取失败" }
      : { content, detail: `AI Lab：已读取虚拟文件 ${path}` }
  }

  if (name === "search_files") {
    const query = stringArg(args, "query").toLowerCase()
    const matches = Object.entries(VIRTUAL_FILES)
      .filter(
        ([path, content]) =>
          path.toLowerCase().includes(query) || content.toLowerCase().includes(query),
      )
      .map(([path]) => path)
    return {
      content: matches.length > 0 ? matches.join("\n") : "未找到匹配的虚拟文件。",
      detail: "AI Lab：已搜索虚拟项目",
    }
  }

  return {
    content:
      "[ai_lab_safe_mode] 此测试台不会执行写入、删除或终端操作；请求已记录，但真实项目没有任何改动。",
    detail: `AI Lab：已安全拦截 ${name}`,
  }
}

function stringArg(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return ""
  const candidate = (value as Record<string, unknown>)[key]
  return typeof candidate === "string" ? candidate : ""
}
