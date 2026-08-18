import type { Capability, OperationKind, RiskLevel } from "../../shared/types.js"

export interface RiskClassification {
  risk: RiskLevel
  capability: Capability
  reason: string
  reversible: boolean
  requiresApproval: boolean
}

const CLASSIFICATIONS: Record<OperationKind, RiskClassification> = {
  create_directory: {
    risk: "R2",
    capability: "workspace.write",
    reason: "将在授权目录内创建目录",
    reversible: true,
    requiresApproval: true,
  },
  write_file: {
    risk: "R2",
    capability: "workspace.write",
    reason: "将原子替换或创建文本文件",
    reversible: true,
    requiresApproval: true,
  },
  apply_patch: {
    risk: "R2",
    capability: "workspace.write",
    reason: "将按精确补丁修改文本文件",
    reversible: true,
    requiresApproval: true,
  },
  move_path: {
    risk: "R2",
    capability: "workspace.write",
    reason: "将移动或重命名授权目录内的路径",
    reversible: true,
    requiresApproval: true,
  },
  trash_path: {
    risk: "R3",
    capability: "workspace.write",
    reason: "将路径移入可恢复的废纸篓",
    reversible: true,
    requiresApproval: true,
  },
  "terminal.execute": {
    risk: "R3",
    capability: "terminal.execute",
    reason: "Terminal 命令可能执行仓库代码或产生系统副作用",
    reversible: false,
    requiresApproval: true,
  },
}

export function classifyOperation(kind: OperationKind): RiskClassification {
  const classification = CLASSIFICATIONS[kind]
  if (!classification) throw new Error("未知操作类型")
  return { ...classification }
}
