import type { TerminalPolicyCode, TerminalPolicyFailure } from "../../shared/types.js"

export interface TerminalPolicyDescriptor {
  userMessage: string
  nextStep: string
  requiredAction: NonNullable<TerminalPolicyFailure["requiredAction"]>
}

export const TERMINAL_POLICY_CATALOG: Record<TerminalPolicyCode, TerminalPolicyDescriptor> = {
  user_denied: {
    userMessage: "你拒绝了这条终端命令。",
    nextStep: "如需继续，请重新提交并确认命令预览。",
    requiredAction: "change_approach",
  },
  approval_expired: {
    userMessage: "终端确认已过期，命令没有启动。",
    nextStep: "请重新提交，让 Pingo 生成新的确认卡。",
    requiredAction: "ask_user",
  },
  sandbox_unavailable: {
    userMessage: "安全沙箱不可用，终端能力已停用。",
    nextStep: "请修复系统沙箱后再重试。",
    requiredAction: "stop",
  },
  sandbox_denied_fs: {
    userMessage: "命令试图访问沙箱未允许的文件或目录，已被拦截。",
    nextStep: "缩小路径范围，或改用不需要该路径的方案。",
    requiredAction: "change_approach",
  },
  sandbox_denied_network: {
    userMessage: "命令试图访问网络或 socket，已被沙箱拦截。",
    nextStep: "改用离线命令；网络能力不会由 Terminal 自动开启。",
    requiredAction: "change_approach",
  },
  plan_changed: {
    userMessage: "确认后终端计划发生变化，命令没有启动。",
    nextStep: "请重新提交并检查新的命令、路径和脚本摘要。",
    requiredAction: "ask_user",
  },
  script_changed: {
    userMessage: "package.json 或质量脚本在确认后发生变化，命令没有启动。",
    nextStep: "请重新提交并检查脚本正文和 package.json 摘要。",
    requiredAction: "ask_user",
  },
  executable_changed: {
    userMessage: "确认后的可执行文件身份发生变化，命令没有启动。",
    nextStep: "请重新提交并重新确认可执行文件。",
    requiredAction: "ask_user",
  },
  command_forbidden: {
    userMessage: "这条终端命令不在允许的结构化命令范围内。",
    nextStep: "改用已开放的 Terminal intent，不要传入 shell 或解释器参数。",
    requiredAction: "change_approach",
  },
  timed_out: {
    userMessage: "终端命令超过 30 秒，进程树已终止。",
    nextStep: "缩小检查范围，拆分命令后重试。",
    requiredAction: "change_approach",
  },
  cancelled: {
    userMessage: "终端命令已取消，进程树已终止。",
    nextStep: "如需继续，请重新提交命令。",
    requiredAction: "ask_user",
  },
  output_limit_exceeded: {
    userMessage: "终端输出超过硬上限，进程树已终止，中间输出已折叠。",
    nextStep: "缩小命令范围或改为只输出摘要。",
    requiredAction: "change_approach",
  },
}

export function getTerminalPolicyDescriptor(code: TerminalPolicyCode): TerminalPolicyDescriptor {
  return TERMINAL_POLICY_CATALOG[code]
}

/** 只识别带有 Seatbelt 明确标记的拒绝，避免把普通命令失败误报为沙箱失败。 */
export function detectSandboxDenial(output: string): TerminalPolicyFailure | undefined {
  const sample = output.slice(-8_000)
  const hasSeatbeltMarker = /sandbox-exec|seatbelt|deny\s*\(/i.test(sample)
  if (!hasSeatbeltMarker) return undefined
  if (/network-(?:outbound|inbound)|network-bind|system-socket|connect\(/i.test(sample)) {
    const descriptor = getTerminalPolicyDescriptor("sandbox_denied_network")
    return {
      code: "sandbox_denied_network",
      policy_code: "sandbox_denied_network",
      message: `${descriptor.userMessage} 命令想访问网络或 socket；沙箱已拦截。`,
      retryable: true,
      requiredAction: descriptor.requiredAction,
    }
  }
  const path = sample.match(/(?:file-read|file-write)[^\n]*?["']([^"']+)["']/i)?.[1]
  const descriptor = getTerminalPolicyDescriptor("sandbox_denied_fs")
  return {
    code: "sandbox_denied_fs",
    policy_code: "sandbox_denied_fs",
    message: `${descriptor.userMessage}${path ? ` 命令想访问：${path}。` : ""}`,
    retryable: true,
    requiredAction: descriptor.requiredAction,
  }
}
