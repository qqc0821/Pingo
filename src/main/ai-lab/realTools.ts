import { getRealProjectRoot } from "../security/pathGuard.js"
import { executeTool, READ_ONLY_TOOL_NAMES } from "../tools/registry.js"
import type { ToolExecution } from "../tools/types.js"
import type { AiLabToolTrace } from "./types.js"

export interface RealToolExecutor {
  projectPath: string
  execute: (name: string, args: unknown) => Promise<ToolExecution>
}

/**
 * AI Lab's real mode is deliberately a narrow gateway: it reuses the production
 * read tool dispatcher after canonicalizing the authorized project root.
 */
export function createRealToolExecutor(
  projectPath: string,
  traces: AiLabToolTrace[],
): RealToolExecutor {
  const canonicalProjectPath = getRealProjectRoot(projectPath)
  return {
    projectPath: canonicalProjectPath,
    execute: async (name, args) => {
      if (!READ_ONLY_TOOL_NAMES.has(name)) {
        const result = {
          content: `[ai_lab_readonly] 工具 ${name} 不属于真实只读 runtime，已拒绝；没有文件或进程副作用。`,
          detail: `AI Lab：已拒绝非只读工具 ${name}`,
        }
        traces.push({ name, args, ...result, mutating: true })
        return result
      }

      const result = await executeTool(canonicalProjectPath, name, args)
      traces.push({ name, args, ...result, mutating: false })
      return result
    },
  }
}
