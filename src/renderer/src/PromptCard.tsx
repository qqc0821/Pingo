import type { ReactElement, ReactNode } from "react"
import type { PetPromptItem, PromptTone } from "../../shared/types.js"
import { normalizePromptContent, summarizePromptContent } from "../../shared/promptSummary.js"

function getPromptSummary(prompt: PetPromptItem): string {
  const derived = summarizePromptContent(prompt.content)
  if (!prompt.summary || prompt.summary === prompt.content) return derived
  return prompt.summary
}

function renderInlinePromptMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenPattern = /(\*\*|__)(.+?)\1|`([^`]+)`/g
  let cursor = 0
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0
    if (index > cursor) nodes.push(text.slice(cursor, index).replace(/\*\*/g, ""))
    if (match[3] !== undefined) {
      nodes.push(
        <code key={`code-${index}`} className="prompt-inline-code">
          {match[3]}
        </code>,
      )
    } else {
      nodes.push(<strong key={`strong-${index}`}>{match[2]}</strong>)
    }
    cursor = index + match[0].length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor).replace(/\*\*/g, ""))
  return nodes
}

function PromptContent({ content, summary }: { content: string; summary: boolean }): ReactElement {
  const lines = normalizePromptContent(content).split("\n")
  const blocks: ReactElement[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? ""
    if (!line) {
      index += 1
      continue
    }
    const orderedMatch = line.match(/^(\d+)\.\s+(.+)$/)
    const unorderedMatch = line.match(/^[-*]\s+(.+)$/)
    if (orderedMatch || unorderedMatch) {
      const ordered = orderedMatch !== null
      const items: string[] = []
      while (index < lines.length) {
        const candidate = lines[index]?.trim() ?? ""
        const match = ordered ? candidate.match(/^\d+\.\s+(.+)$/) : candidate.match(/^[-*]\s+(.+)$/)
        if (!match) break
        if (match[1]) items.push(match[1])
        index += 1
      }
      const ListTag = ordered ? "ol" : "ul"
      blocks.push(
        <ListTag key={`list-${index}`} className="prompt-list">
          {items.map((item, itemIndex) => (
            <li key={`${index}-${itemIndex}`}>{renderInlinePromptMarkdown(item)}</li>
          ))}
        </ListTag>,
      )
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const candidate = lines[index]?.trim() ?? ""
      if (!candidate || /^\d+\.\s+/.test(candidate) || /^[-*]\s+/.test(candidate)) break
      paragraph.push(candidate)
      index += 1
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {paragraph.flatMap((part, partIndex) =>
          partIndex === 0
            ? renderInlinePromptMarkdown(part)
            : [<br key={`br-${partIndex}`} />, ...renderInlinePromptMarkdown(part)],
        )}
      </p>,
    )
  }
  return (
    <div className={`prompt-rich-text ${summary ? "prompt-rich-text--summary" : ""}`}>{blocks}</div>
  )
}

function PromptIcon({ tone }: { tone: PromptTone }): ReactElement {
  if (tone === "success") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7.5 12.5 3 3 6-7" />
      </svg>
    )
  }
  if (tone === "warning") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 8.25v4.5" />
        <path d="M12 16.25h.01" />
        <path d="M10.35 4.5 4.1 16a2 2 0 0 0 1.76 3h12.28a2 2 0 0 0 1.76-3L13.65 4.5a1.88 1.88 0 0 0-3.3 0Z" />
      </svg>
    )
  }
  if (tone === "error") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="7.75" />
        <path d="m9.5 9.5 5 5m0-5-5 5" />
      </svg>
    )
  }
  if (tone === "progress") {
    return (
      <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M19 12a7 7 0 1 1-2.05-4.95" />
        <path d="M17 4.75v3.5h3.5" />
      </svg>
    )
  }
  return (
    <svg className="prompt-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 7.5v5" />
      <path d="M12 16.5h.01" />
      <circle cx="12" cy="12" r="7.75" />
    </svg>
  )
}

export function PromptCard({
  prompt,
  compact,
  detailOpen,
  navigation,
  onToggleDetail,
  onDismiss,
  onCancel,
}: {
  prompt: PetPromptItem
  compact: boolean
  detailOpen: boolean
  navigation?: {
    position: number
    total: number
    onPrevious: () => void
    onNext: () => void
  }
  onToggleDetail: () => void
  onDismiss: () => void
  onCancel?: () => void
}): ReactElement {
  const liveMode = prompt.tone === "error" ? "assertive" : "polite"
  const runningTask = prompt.kind === "task" && prompt.sticky === true
  const summaryContent = getPromptSummary(prompt)
  const fullContent = normalizePromptContent(prompt.content)
  const canShowDetails =
    prompt.expandable === true && Boolean(summaryContent) && summaryContent !== fullContent
  const showSummary = !detailOpen && (compact || canShowDetails)
  const displayedContent = showSummary ? summaryContent : prompt.content
  const detailId = `pingo-prompt-detail-${prompt.id}`

  return (
    <section
      className={`pet-prompt pet-prompt--${prompt.tone} ${compact ? "pet-prompt--compact" : "pet-prompt--current"} ${detailOpen ? "pet-prompt--detail" : ""}`}
      role={prompt.tone === "error" ? "alert" : "status"}
      aria-live={liveMode}
      aria-atomic="false"
    >
      <span className="visually-hidden">Pingo 提示:{prompt.label}。</span>
      <div className="pet-prompt-header">
        <span className="pet-prompt-icon" aria-hidden="true">
          <span className="pet-prompt-icon-motion">
            <PromptIcon tone={prompt.tone} />
          </span>
        </span>
        <div className="pet-prompt-heading">
          <span className="pet-prompt-label">
            {prompt.label}
            {prompt.count !== undefined && prompt.count > 1 ? (
              <span className="prompt-count-badge">×{prompt.count}</span>
            ) : null}
          </span>
          <div id={detailId} className="pet-prompt-content">
            <PromptContent content={displayedContent} summary={showSummary} />
          </div>
          {canShowDetails || navigation ? (
            <div className="pet-prompt-footer">
              {canShowDetails ? (
                <button
                  className="pet-prompt-detail-toggle"
                  type="button"
                  aria-expanded={detailOpen}
                  aria-controls={detailId}
                  onClick={onToggleDetail}
                >
                  <span>{detailOpen ? "收起详情" : "查看详情"}</span>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m4.75 6.25 3.25 3.25 3.25-3.25" />
                  </svg>
                </button>
              ) : null}
              {navigation ? (
                <nav className="pet-prompt-carousel-nav" aria-label="消息切换">
                  <button
                    type="button"
                    aria-label="上一条消息"
                    disabled={navigation.position <= 1}
                    onClick={navigation.onPrevious}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="m9.75 3.75-4.25 4.25 4.25 4.25" />
                    </svg>
                  </button>
                  <span aria-live="polite" aria-atomic="true">
                    {navigation.position} / {navigation.total}
                  </span>
                  <button
                    type="button"
                    aria-label="下一条消息"
                    disabled={navigation.position >= navigation.total}
                    onClick={navigation.onNext}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="m6.25 3.75 4.25 4.25-4.25 4.25" />
                    </svg>
                  </button>
                </nav>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="pet-prompt-actions">
          {runningTask && onCancel ? (
            <button className="pet-prompt-cancel" type="button" onClick={onCancel}>
              取消
            </button>
          ) : null}
          <button
            className="pet-prompt-dismiss"
            type="button"
            aria-label={runningTask ? "关闭当前任务卡" : "关闭当前提示卡"}
            onClick={onDismiss}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
      {prompt.tone === "progress" ? (
        <span className="pet-prompt-progress" aria-hidden="true">
          <span />
        </span>
      ) : null}
    </section>
  )
}
