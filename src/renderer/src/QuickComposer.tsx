import type { FormEvent, KeyboardEvent, ReactElement, RefObject } from "react"

interface QuickComposerProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  isSending: boolean
  placeholder: string
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onNewSession: () => void
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
}

export function QuickComposer(props: QuickComposerProps): ReactElement {
  return (
    <form className="quick-composer" onSubmit={props.onSubmit}>
      <label className="visually-hidden" htmlFor="pingo-message">
        输入给 Pingo 的消息
      </label>
      <div className="quick-composer-shell">
        <button
          className="quick-composer-new-session"
          type="button"
          aria-label="开始新对话"
          title="开始新对话"
          disabled={props.isSending}
          onClick={props.onNewSession}
        >
          新对话
        </button>
        <textarea
          ref={props.textareaRef}
          id="pingo-message"
          name="message"
          rows={1}
          value={props.draft}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={props.onKeyDown}
          onCompositionStart={props.onCompositionStart}
          onCompositionEnd={props.onCompositionEnd}
          placeholder={props.placeholder}
          autoComplete="off"
        />
        <button type="submit" disabled={!props.draft.trim() || props.isSending}>
          {props.isSending ? "处理中…" : "发送"}
        </button>
      </div>
    </form>
  )
}
