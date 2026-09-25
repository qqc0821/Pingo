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

test("model client completes one tool-aware request without executing tools", async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.MODEL_API_KEY
  try {
    process.env.MODEL_API_KEY = "test-key"
    const requestBodies: unknown[] = []
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "",
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
        {
          status: 200,
        },
      )
    }

    const result = await new ModelClient().completeWithTools(
      [{ role: "user", content: "看看项目" }],
      toolDefinitions,
    )
    assert.deepEqual(result, {
      content: "",
      toolCalls: [{ id: "call-1", name: "list_files", arguments: "{}" }],
    })
    const request = requestBodies[0] as {
      stream: boolean
      tools: ToolDefinition[]
      tool_choice: string
    }
    assert.equal(request.stream, false)
    assert.deepEqual(request.tools, toolDefinitions)
    assert.equal(request.tool_choice, "auto")
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
  }
})
