import type { ChatStreamEvent, PetState, TaskState } from "../../shared/types.js"
import type { UpsertPromptItemOptions } from "../../shared/promptStack.js"
import { summarizePromptContent } from "../../shared/promptSummary.js"

export interface TaskProjectionState {
  response: string
  operationResult: string
  request: string
}

export interface TaskProjection {
  state: TaskProjectionState
  patch?: UpsertPromptItemOptions
  petState?: PetState
  terminal?: boolean
  sending?: boolean
}

export function projectTaskEvent(
  state: TaskProjectionState,
  event: ChatStreamEvent,
): TaskProjection {
  if (event.type === "start")
    return {
      state: { ...state, response: "", operationResult: "" },
      patch: { tone: "progress", label: "分析中", content: "正在理解目标并确定下一步。" },
      petState: "thinking",
      sending: true,
    }
  if (event.type === "chunk")
    return { state: { ...state, response: state.response + event.content } }
  if (event.type === "agent-step") {
    const detail =
      event.detail ??
      (event.toolNames?.length ? `正在使用:${event.toolNames.join("、")}` : "Pingo 正在继续处理。")
    return {
      state,
      patch: {
        tone:
          event.status === "failed"
            ? "error"
            : event.phase === "awaiting_approval"
              ? "warning"
              : "progress",
        label:
          event.status === "failed"
            ? "步骤失败"
            : event.phase === "awaiting_approval"
              ? "需要注意"
              : "处理中",
        content: detail === event.title ? event.title : `${event.title}\n${detail}`,
        expandable: event.status === "failed",
      },
    }
  }
  if (event.type === "task-state") return { state, patch: promptForTaskState(event.state) }
  if (event.type === "tool") {
    if (event.detail.startsWith("读取被拒绝:"))
      return {
        state,
        patch: {
          tone: "warning",
          label: "需要处理",
          content: `无法读取项目目录。\n${event.detail}\n请检查项目目录后再试。`,
          expandable: true,
        },
      }
    const isMcp = event.name.startsWith("mcp__")
    return {
      state,
      patch: {
        tone: "progress",
        label: isMcp ? "MCP 工具" : "工具运行中",
        content: isMcp
          ? `正在使用 ${event.name} 工具。`
          : event.detail || `正在使用 ${event.name}。`,
      },
    }
  }
  if (event.type === "operation-progress")
    return {
      state,
      patch: {
        tone: "progress",
        label: "执行中",
        content: event.stream === "stderr" ? "正在检查命令反馈。" : "命令正在执行。",
      },
    }
  if (event.type === "capability-request" || event.type === "approval-request")
    return {
      state,
      patch: {
        tone: "warning",
        label: "需要注意",
        content: "等待你的确认。请选择是否继续此操作。",
        kind: "approval",
      },
    }
  if (event.type === "operation-result") {
    const result = event.result.content || event.result.detail
    return {
      state: { ...state, operationResult: result || state.operationResult },
      ...(event.result.status !== "completed"
        ? {
            patch: {
              tone: "error" as const,
              label: "操作未完成",
              content: result || "未能完成当前操作。请检查权限或调整任务后再试一次。",
              summary: summarizePromptContent(
                result || "未能完成当前操作。请检查权限或调整任务后再试一次。",
              ),
              expandable: true,
            },
          }
        : {}),
    }
  }
  if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
    const result = state.response.trim() || state.operationResult.trim()
    const content =
      event.type === "done"
        ? result || "请求已处理完毕,暂未返回额外说明。"
        : event.type === "error"
          ? `${event.message}\n请检查设置或调整任务后再试。`
          : "任务已取消,没有继续执行操作。你可以随时重新开始。"
    return {
      state,
      terminal: true,
      sending: false,
      petState: event.type === "done" ? "happy" : "worried",
      patch: {
        kind: "result",
        tone: event.type === "done" ? "success" : event.type === "error" ? "error" : "neutral",
        label: event.type === "done" ? "已完成" : event.type === "error" ? "未完成" : "已取消",
        content,
        summary: summarizePromptContent(content, event.type === "done" ? state.request : undefined),
        expandable: true,
        sticky: false,
      },
    }
  }
  return { state }
}

function promptForTaskState(state: TaskState): UpsertPromptItemOptions {
  switch (state) {
    case "proposed":
      return { tone: "progress", label: "准备中", content: "正在检查执行环境与项目上下文。" }
    case "planning":
      return { tone: "progress", label: "分析中", content: "正在拆解目标并规划下一步。" }
    case "awaiting_permission":
    case "awaiting_confirmation":
      return { tone: "warning", label: "需要注意", content: "等待你的确认。请选择是否继续此操作。" }
    case "executing":
      return { tone: "progress", label: "执行中", content: "正在应用已确认的操作。" }
    case "completed":
      return { tone: "progress", label: "整理中", content: "操作已结束,正在整理最终结果。" }
    case "failed":
      return {
        tone: "error",
        label: "需要处理",
        content: "未能完成该请求。请检查任务描述或项目权限,调整后再试一次。",
      }
    case "cancelled":
      return {
        tone: "neutral",
        label: "已取消",
        content: "没有继续执行操作。你可以随时重新输入任务。",
      }
  }
}
