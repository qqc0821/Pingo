export interface ObservationBudget {
  maxCharsPerTool: number
  maxTotalToolCharsPerLoop: number
}

export interface FormattedObservation {
  content: string
  truncated: boolean
  omitted: boolean
}

export const DEFAULT_OBSERVATION_BUDGET: ObservationBudget = {
  maxCharsPerTool: 8_000,
  maxTotalToolCharsPerLoop: 24_000,
}

const BUDGET_EXCEEDED_MESSAGE = "[observation budget exceeded; content omitted]"

export function createObservationTracker(budget: ObservationBudget = DEFAULT_OBSERVATION_BUDGET): {
  readonly totalChars: number
  readonly budgetExceeded: boolean
  format(content: string): FormattedObservation
} {
  let totalChars = 0
  let budgetExceeded = false

  return {
    get totalChars() {
      return totalChars
    },
    get budgetExceeded() {
      return budgetExceeded
    },
    format(content: string): FormattedObservation {
      if (budgetExceeded || totalChars >= budget.maxTotalToolCharsPerLoop) {
        budgetExceeded = true
        return { content: BUDGET_EXCEEDED_MESSAGE, truncated: false, omitted: true }
      }

      const remaining = budget.maxTotalToolCharsPerLoop - totalChars
      const limit = Math.min(budget.maxCharsPerTool, remaining)
      if (content.length <= limit) {
        totalChars += content.length
        if (totalChars >= budget.maxTotalToolCharsPerLoop) budgetExceeded = true
        return { content, truncated: false, omitted: false }
      }

      const sliced = content.slice(0, limit)
      const omittedChars = content.length - sliced.length
      totalChars += limit
      if (totalChars >= budget.maxTotalToolCharsPerLoop) budgetExceeded = true
      return {
        content: `${sliced}\n…[truncated ${omittedChars} chars]`,
        truncated: true,
        omitted: false,
      }
    },
  }
}
