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

test("model client executes a bounded tool loop before final answer", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  try {
    process.env.MODEL_API_KEY = "test-key"
    let callCount = 0
    const requestBodies: unknown[] = []
    globalThis.fetch = async (_input, init) => {
      callCount += 1
      requestBodies.push(JSON.parse(String(init?.body)))
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name: "list_files", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "项目已读取" } }] }), {
        status: 200,
      })
    }

    const events: string[] = []
    await new ModelClient().stream(
      [{ role: "user", content: "看看项目" }],
      (event) => events.push(event.type),
      async () => ({ content: "package.json", detail: "正在列出项目文件…" }),
      toolDefinitions,
    )
    assert.equal(callCount, 2)
    assert.deepEqual(events, ["start", "tool", "chunk", "done"])
    const secondRequest = requestBodies[1] as {
      messages: Array<Record<string, unknown>>
    }
    assert.deepEqual(secondRequest.messages.slice(-2), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "list_files", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "package.json" },
    ])
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})
