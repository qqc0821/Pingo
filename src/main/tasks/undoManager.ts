import type { OperationKind } from "../../shared/types.js"

export interface UndoAction {
  undoId: string
  taskId: string
  sourceWindowId: string
  kind: OperationKind
  targets: string[]
  preview: string
  run: () => Promise<void>
}

export class UndoManager {
  private readonly actions = new Map<string, UndoAction>()

  register(action: UndoAction): void {
    this.actions.set(action.undoId, { ...action, targets: [...action.targets] })
  }

  get(undoId: string, taskId: string, sourceWindowId: string): UndoAction | undefined {
    const action = this.actions.get(undoId)
    if (!action || action.taskId !== taskId || action.sourceWindowId !== sourceWindowId)
      return undefined
    return action
  }

  remove(undoId: string): void {
    this.actions.delete(undoId)
  }
}
