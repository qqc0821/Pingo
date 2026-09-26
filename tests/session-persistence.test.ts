import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ConversationStore } from "../src/main/tasks/conversationStore.js"
import { FileSessionPersistence } from "../src/main/tasks/sessionPersistence.js"

test("persisted conversation continues after a new store instance without replaying tools", () => {
  const directory = mkdtempSync(join(tmpdir(), "pingo-session-"))
  const persistence = new FileSessionPersistence(directory)
  const first = new ConversationStore(persistence)
  const session = first.current("desktop", "/project")
  first.begin("desktop", session.id, "文件在哪")
  first.complete("desktop", session.id, [
    { role: "user", content: "文件在哪" },
    { role: "assistant", content: "在 src/main" },
  ])
  const restored = new ConversationStore(persistence)
  assert.equal(restored.current("desktop", "/project").id, session.id)
  assert.deepEqual(restored.messagesFor("desktop", "/project", "继续"), [
    { role: "user", content: "文件在哪" },
    { role: "assistant", content: "在 src/main" },
    { role: "user", content: "继续" },
  ])
})

test("restart marks a pending turn interrupted and never replays it", () => {
  const directory = mkdtempSync(join(tmpdir(), "pingo-interrupted-"))
  const persistence = new FileSessionPersistence(directory)
  const first = new ConversationStore(persistence)
  const session = first.current("desktop", "/project")
  first.begin("desktop", session.id, "写入文件")
  const restored = new ConversationStore(persistence)
  assert.equal(restored.interrupted("desktop", "/project"), "写入文件")
  const messages = restored.messagesFor("desktop", "/project", "现在状态如何")
  assert.match(String(messages[1]?.content), /中断.*未自动重试/)
  assert.equal(new ConversationStore(persistence).current("desktop", "/project").pending, undefined)
})

test("corrupt storage is isolated and new session deletion removes old content", () => {
  const directory = mkdtempSync(join(tmpdir(), "pingo-corrupt-"))
  const persistence = new FileSessionPersistence(directory)
  const first = new ConversationStore(persistence)
  const session = first.current("desktop", "/project")
  const file = join(directory, `session-${session.id}.json`)
  writeFileSync(file, "{broken")
  const recovered = new ConversationStore(persistence)
  assert.notEqual(recovered.current("desktop", "/project").id, session.id)
  const newId = recovered.current("desktop", "/project").id
  recovered.clear("desktop")
  assert.equal(
    readdirSync(directory).some((name) => name === `session-${newId}.json`),
    false,
  )
  assert.equal(readFileSync(file, "utf8"), "{broken")
})

test("session files redact credential-shaped content", () => {
  const directory = mkdtempSync(join(tmpdir(), "pingo-redaction-"))
  const persistence = new FileSessionPersistence(directory)
  const store = new ConversationStore(persistence)
  const session = store.current("desktop", "/project")
  store.complete("desktop", session.id, [
    { role: "user", content: '检查 {"api_key":"sensitive-value"}' },
    { role: "assistant", content: "已检查" },
  ])
  const raw = readFileSync(join(directory, `session-${session.id}.json`), "utf8")
  assert.doesNotMatch(raw, /sensitive-value/)
  assert.match(raw, /\[redacted\]/)
})
