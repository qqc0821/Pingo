import assert from "node:assert/strict"
import test from "node:test"
import { ModelClient } from "../src/main/ai/client.js"
import type { ToolDefinition } from "../src/main/tools/types.js"

const toolDefinitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "list files",
      parameters: { type: "object", properties: {} },
    },
  },
]

test("model client parses streaming chunks and guards missing keys", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  try {
    process.env.MODEL_API_KEY = "test-key"
    globalThis.fetch = async () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )
    const events: string[] = []
    const chunks: string[] = []
    await new ModelClient().stream([{ role: "user", content: "hi" }], (event) => {
      events.push(event.type)
      if (event.type === "chunk") chunks.push(event.content)
    })
    assert.deepEqual(events, ["start", "chunk", "done"])
    assert.deepEqual(chunks, ["你好"])

    delete process.env.MODEL_API_KEY
    const missingKeyEvents: string[] = []
    await new ModelClient().stream([{ role: "user", content: "hi" }], (event) => {
      missingKeyEvents.push(event.type)
    })
    assert.deepEqual(missingKeyEvents, ["error"])
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})

test("model client completes one tool-aware request without executing tools", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  try {
    process.env.MODEL_API_KEY = "test-key"
    const requestBodies: unknown[] = []
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "list_files", arguments: "{}" } }] } }] }), {
        status: 200,
      })
    }

    const result = await new ModelClient().completeWithTools(
      [{ role: "user", content: "看看项目" }],
      toolDefinitions,
    )
    assert.deepEqual(result, {
      content: "",
      toolCalls: [{ id: "call-1", name: "list_files", arguments: "{}" }],
    })
    const request = requestBodies[0] as { stream: boolean; tools: ToolDefinition[]; tool_choice: string }
    assert.equal(request.stream, false)
    assert.deepEqual(request.tools, toolDefinitions)
    assert.equal(request.tool_choice, "auto")
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})
