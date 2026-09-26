import type { OperationKind } from "../../shared/types.js"

/** A policy description, not an authorization bypass. Path and Seatbelt checks still run. */
export interface ExecutionPolicy {
  workspace: "active-project"
  actions: Record<"read" | "file-change" | "terminal", "automatic" | "confirm">
  allowProcessCwdFallback: boolean
}

export const DESKTOP_EXECUTION_POLICY: ExecutionPolicy = {
  workspace: "active-project",
  actions: { read: "automatic", "file-change": "automatic", terminal: "automatic" },
  allowProcessCwdFallback: true,
}

export const INTERACTIVE_EXECUTION_POLICY: ExecutionPolicy = {
  workspace: "active-project",
  actions: { read: "confirm", "file-change": "confirm", terminal: "confirm" },
  allowProcessCwdFallback: false,
}

export function actionClass(kind: OperationKind): keyof ExecutionPolicy["actions"] {
  return kind === "terminal.execute" ? "terminal" : "file-change"
}
