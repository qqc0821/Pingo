import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ConversationStore } from "../src/main/conversations/conversationStore.js"

function createStore(): ConversationStore {
  return new ConversationStore(mkdtempSync(join(tmpdir(), "pingo-conversations-")))
}

test("conversation store persists a turn and builds Main-owned context", () => {
  const store = createStore()
  try {
    const conversation = store.create()
    const submitted = store.submit({
      conversationId: conversation.conversationId,
      clientRequestId: "request-one",
      expectedRevision: conversation.revision,
      expectedContextEpochId: conversation.activeContextEpochId,
      content: "总结当前项目",
    })
    store.recordTaskEvent(submitted.taskId, { type: "chunk", content: "项目目前稳定。" })
    store.recordTaskEvent(submitted.taskId, { type: "done" })

    assert.deepEqual(store.getContextForRun(submitted.taskId), [
      { role: "user", content: "总结当前项目" },
      { role: "assistant", content: "项目目前稳定。" },
    ])
    const reloaded = store.get(conversation.conversationId)
    assert.equal(reloaded?.items.filter((item) => item.kind === "message").length, 2)
    assert.equal(reloaded?.items.at(-1)?.status, "complete")
  } finally {
    store.close()
  }
})

test("clear context keeps the timeline but excludes prior epoch from future model input", () => {
  const store = createStore()
  try {
    const conversation = store.create()
    const first = store.submit({
      conversationId: conversation.conversationId,
      clientRequestId: "request-clear-one",
      expectedRevision: conversation.revision,
      expectedContextEpochId: conversation.activeContextEpochId,
      content: "旧上下文",
    })
    store.recordTaskEvent(first.taskId, { type: "chunk", content: "旧回复" })
    store.recordTaskEvent(first.taskId, { type: "done" })
    const beforeClear = store.get(conversation.conversationId)
    assert.ok(beforeClear)
    const cleared = store.clearContext({
      conversationId: conversation.conversationId,
      expectedRevision: beforeClear.revision,
    })
    const second = store.submit({
      conversationId: cleared.conversationId,
      clientRequestId: "request-clear-two",
      expectedRevision: cleared.revision,
      expectedContextEpochId: cleared.activeContextEpochId,
      content: "新上下文",
    })

    assert.deepEqual(store.getContextForRun(second.taskId), [{ role: "user", content: "新上下文" }])
    assert.equal(
      store.get(conversation.conversationId)?.items.some((item) => item.kind === "context-cleared"),
      true,
    )
  } finally {
    store.close()
  }
})

test("clear context can be undone until the next turn", () => {
  const store = createStore()
  try {
    const conversation = store.create()
    const cleared = store.clearContext({
      conversationId: conversation.conversationId,
      expectedRevision: conversation.revision,
    })
    const restored = store.undoClearContext(conversation.conversationId)
    assert.equal(restored?.activeContextEpochId, conversation.activeContextEpochId)
    assert.equal(
      restored?.items.some((item) => item.kind === "context-cleared"),
      false,
    )
    assert.notEqual(cleared.activeContextEpochId, restored?.activeContextEpochId)
  } finally {
    store.close()
  }
})

test("startup recovery marks unfinished streaming responses as interrupted", () => {
  const directory = mkdtempSync(join(tmpdir(), "pingo-conversation-recovery-"))
  const initial = new ConversationStore(directory)
  const conversation = initial.create()
  initial.submit({
    conversationId: conversation.conversationId,
    clientRequestId: "request-recovery",
    expectedRevision: conversation.revision,
    expectedContextEpochId: conversation.activeContextEpochId,
    content: "会中断的回答",
  })
  initial.close()

  const recovered = new ConversationStore(directory)
  try {
    const assistant = recovered
      .get(conversation.conversationId)
      ?.items.find((item) => item.role === "assistant")
    assert.equal(assistant?.status, "interrupted")
  } finally {
    recovered.close()
  }
})

test("legacy renderer cache is imported exactly once", () => {
  const store = createStore()
  try {
    const imported = store.importLegacy([
      { id: "old-user", role: "user", content: "旧问题" },
      { id: "old-assistant", role: "assistant", content: "旧回答" },
    ])
    const retry = store.importLegacy([{ id: "ignored", role: "user", content: "不应重复导入" }])
    assert.equal(imported?.conversationId, retry?.conversationId)
    assert.equal(retry?.items.filter((item) => item.kind === "message").length, 2)
  } finally {
    store.close()
  }
})

test("client request retry returns the existing run without starting a second turn", () => {
  const store = createStore()
  try {
    const conversation = store.create()
    const request = {
      conversationId: conversation.conversationId,
      clientRequestId: "request-idempotent",
      expectedRevision: conversation.revision,
      expectedContextEpochId: conversation.activeContextEpochId,
      content: "只执行一次",
    }
    const first = store.submit(request)
    const retry = store.submit(request)
    assert.equal(first.started, true)
    assert.equal(retry.started, false)
    assert.equal(retry.taskId, first.taskId)
    assert.equal(retry.conversation.items.filter((item) => item.kind === "message").length, 2)
  } finally {
    store.close()
  }
})
