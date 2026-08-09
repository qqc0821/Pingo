import assert from "node:assert/strict"
import test from "node:test"
import { extractInlineToolCalls, stripSentinels } from "../src/main/agent/toolCallFallback.js"

const KNOWN = new Set(["read_file", "search_files", "write_file"])
const isKnownTool = (name: string) => KNOWN.has(name)

test("恢复被写进 content 的裸 JSON 调用并去掉结束哨兵", () => {
  const content = '{"name":"read_file","parameters":{"path":"note.txt"}}<|eot_id|>'
  const calls = extractInlineToolCalls(content, isKnownTool)
  assert.deepEqual(calls, [{ name: "read_file", arguments: '{"path":"note.txt"}' }])
})

test("恢复 markdown 代码块中的调用，并忽略前后自然语言", () => {
  const content = [
    "我先读取一下这个文件：",
    "```json",
    '{"name": "read_file", "arguments": {"path": "src/index.ts"}}',
    "```",
    "读完再告诉你结论。",
  ].join("\n")
  const calls = extractInlineToolCalls(content, isKnownTool)
  assert.deepEqual(calls, [{ name: "read_file", arguments: '{"path":"src/index.ts"}' }])
})

test("支持嵌套 function 形状并可恢复同一段文本中的多个调用", () => {
  const content =
    '{"function":{"name":"search_files","arguments":{"query":"login"}}} 然后 ' +
    '{"name":"read_file","parameters":{"path":"a.ts"}}'
  const calls = extractInlineToolCalls(content, isKnownTool)
  assert.deepEqual(calls, [
    { name: "search_files", arguments: '{"query":"login"}' },
    { name: "read_file", arguments: '{"path":"a.ts"}' },
  ])
})

test("忽略未注册的工具名、非调用 JSON 和纯文本", () => {
  assert.deepEqual(extractInlineToolCalls('{"name":"rm_rf","parameters":{}}', isKnownTool), [])
  assert.deepEqual(extractInlineToolCalls('{"path":"note.txt"}', isKnownTool), [])
  assert.deepEqual(extractInlineToolCalls("我打算先看一下项目结构。", isKnownTool), [])
  assert.deepEqual(extractInlineToolCalls("", isKnownTool), [])
})

test("字符串内的花括号不会破坏 JSON 边界识别", () => {
  const content = '{"name":"search_files","parameters":{"query":"function {x}"}}'
  const calls = extractInlineToolCalls(content, isKnownTool)
  assert.deepEqual(calls, [{ name: "search_files", arguments: '{"query":"function {x}"}' }])
})

test("stripSentinels 移除模型特殊标记", () => {
  assert.equal(stripSentinels("done<|eot_id|><|im_end|>"), "done")
})
