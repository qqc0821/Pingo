import type { TaskEventEnvelope } from "./types.js"

export interface TaskEventCursor {
  requestId: string
  taskId: string | null
  sequence: number
}

export function advanceTaskEventCursor(
  cursor: TaskEventCursor,
  incoming: TaskEventEnvelope,
): TaskEventCursor | null {
  if (incoming.requestId !== cursor.requestId) return null
  if (cursor.taskId && incoming.taskId !== cursor.taskId) return null
  if (incoming.sequence <= cursor.sequence) return null
  return { requestId: cursor.requestId, taskId: incoming.taskId, sequence: incoming.sequence }
}
