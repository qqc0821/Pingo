import type { OperationKind } from "../../shared/types.js"

export interface UndoAction {
  undoId: string
  taskId: string
  sourceWindowId: string
  kind: OperationKind
  targets: string[]
  preview: string
  run: () => Promise<void>
  expiresAt?: number
}

const MAX_UNDO_ACTIONS = 64
const UNDO_TTL_MS = 30 * 60 * 1_000

export class UndoManager {
  private readonly actions = new Map<string, UndoAction>()

  register(action: UndoAction): void {
    this.prune()
    this.actions.set(action.undoId, {
      ...action,
      targets: [...action.targets],
      expiresAt: Date.now() + UNDO_TTL_MS,
    })
    while (this.actions.size > MAX_UNDO_ACTIONS) {
      const oldest = this.actions.keys().next().value
      if (oldest) this.actions.delete(oldest)
    }
  }

  get(undoId: string, taskId: string, sourceWindowId: string): UndoAction | undefined {
    this.prune()
    const action = this.actions.get(undoId)
    if (!action || action.taskId !== taskId || action.sourceWindowId !== sourceWindowId)
      return undefined
    return action
  }

  remove(undoId: string): void {
    this.actions.delete(undoId)
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, action] of this.actions) {
      if ((action.expiresAt ?? 0) <= now) this.actions.delete(id)
    }
  }
}
