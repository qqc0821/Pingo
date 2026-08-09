import assert from "node:assert/strict"
import test from "node:test"
import { buildToolConversation } from "../src/main/agent/contextBuilder.js"
import { AgentOrchestrator } from "../src/main/agent/orchestrator.js"
import type { ChatStreamEvent } from "../src/shared/types.js"

test("已授权时把目录绝对路径写入 system 上下文", () => {
  const conversation = buildToolConversation([{ role: "user", content: "Pingo 的路径是什么" }], {
    projectAuthorized: true,
    projectName: "Pingo",
    projectPath: "/Users/demo/Projects/Pingo",
  })

  const system = conversation.at(0)
  assert.equal(system?.role, "system")
  assert.match(String(system?.content), /\/Users\/demo\/Projects\/Pingo/)
})

test("未授权时不注入任何绝对路径", () => {
  const conversation = buildToolConversation([{ role: "user", content: "Pingo 的路径是什么" }], {
    projectAuthorized: false,
    projectPath: "/Users/demo/Projects/Pingo",
  })

  assert.doesNotMatch(String(conversation.at(0)?.content), /\/Users\/demo/)
})

test("无 toolCalls 时直接结束并发出最终内容和步骤", async () => {
  const events: ChatStreamEvent[] = []
  const client = {
    async completeWithTools() {
      return { content: "你好", toolCalls: [] }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async () => ({ content: "", detail: "" }),
    isReadOnlyTool: () => true,
    emit: (event) => events.push(event),
    isCancelled: () => false,
    maxToolLoops: 3,
  })

  await orchestrator.run([{ role: "user", content: "hi" }])

  assert.ok(events.some((event) => event.type === "chunk" && event.content === "你好"))
  assert.ok(events.some((event) => event.type === "agent-step" && event.phase === "model"))
  assert.ok(events.some((event) => event.type === "agent-step" && event.phase === "summarizing"))
})

test("同轮多个只读工具并行执行，仍按原始调用顺序回填", async () => {
  let concurrent = 0
  let maxConcurrent = 0
  const observedToolDetails: string[] = []
  const client = {
    calls: 0,
    conversations: [] as unknown[][],
    async completeWithTools(messages: unknown[]) {
      this.calls += 1
      this.conversations.push(messages)
      if (this.calls === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "1", name: "read_file", arguments: '{"path":"a"}' },
            { id: "2", name: "read_file", arguments: '{"path":"b"}' },
          ],
        }
      }
      return { content: "done", toolCalls: [] }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async (_name, args) => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((resolve) => setTimeout(resolve, 20))
      concurrent -= 1
      const path = (args as { path: string }).path
      return { content: `content-${path}`, detail: `read-${path}` }
    },
    isReadOnlyTool: (name) => name === "read_file",
    emit: (event) => {
      if (event.type === "tool") observedToolDetails.push(event.detail)
    },
    isCancelled: () => false,
  })

  await orchestrator.run([{ role: "user", content: "read both" }])

  assert.equal(maxConcurrent, 2)
  assert.deepEqual(observedToolDetails, ["read-a", "read-b"])
  const finalConversation = client.conversations[1] as Array<Record<string, unknown>>
  assert.deepEqual(finalConversation.slice(-2), [
    { role: "tool", tool_call_id: "1", content: "content-a" },
    { role: "tool", tool_call_id: "2", content: "content-b" },
  ])
})

test("变更类工具按原始调用顺序串行执行", async () => {
  const order: string[] = []
  let callCount = 0
  const client = {
    async completeWithTools() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "a", name: "write_file", arguments: '{"id":"a"}' },
            { id: "b", name: "write_file", arguments: '{"id":"b"}' },
          ],
        }
      }
      return { content: "done", toolCalls: [] }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async (_name, args) => {
      const id = (args as { id: string }).id
      order.push(`${id}-start`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`${id}-end`)
      return { content: id, detail: id }
    },
    isReadOnlyTool: () => false,
    emit: () => {},
    isCancelled: () => false,
  })

  await orchestrator.run([{ role: "user", content: "write both" }])

  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"])
})

test("取消后不再调用下一轮模型", async () => {
  let cancelled = false
  let callCount = 0
  const client = {
    async completeWithTools() {
      callCount += 1
      return {
        content: "",
        toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }],
      }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async () => {
      cancelled = true
      return { content: "ok", detail: "ok" }
    },
    isReadOnlyTool: () => true,
    emit: () => {},
    isCancelled: () => cancelled,
  })

  await orchestrator.run([{ role: "user", content: "read" }])

  assert.equal(callCount, 1)
})

test("超出工具循环预算时发出友好错误", async () => {
  const events: ChatStreamEvent[] = []
  const client = {
    async completeWithTools() {
      return {
        content: "",
        toolCalls: [{ id: crypto.randomUUID(), name: "read_file", arguments: "{}" }],
      }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async () => ({ content: "ok", detail: "ok" }),
    isReadOnlyTool: () => true,
    emit: (event) => events.push(event),
    isCancelled: () => false,
    maxToolLoops: 2,
  })

  await orchestrator.run([{ role: "user", content: "loop" }])

  assert.ok(
    events.some(
      (event) => event.type === "error" && event.message === "模型连续请求工具次数过多，已停止本次对话。",
    ),
  )
})

test("单轮观察预算耗尽时省略后续内容并发出步骤", async () => {
  const events: ChatStreamEvent[] = []
  let callCount = 0
  const client = {
    async completeWithTools(messages: Array<Record<string, unknown>>) {
      callCount += 1
      if (callCount === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "1", name: "read_file", arguments: "{}" },
            { id: "2", name: "read_file", arguments: "{}" },
          ],
        }
      }
      const observations = messages.filter((message) => message.role === "tool")
      assert.equal(observations.length, 2)
      assert.equal(observations[1]?.content, "[observation budget exceeded; content omitted]")
      return { content: "done", toolCalls: [] }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async (_name, args) => ({
      content: (args as { value?: string }).value ?? "1234567890",
      detail: "read",
    }),
    isReadOnlyTool: () => true,
    emit: (event) => events.push(event),
    isCancelled: () => false,
    observationBudget: { maxCharsPerTool: 100, maxTotalToolCharsPerLoop: 10 },
  })

  await orchestrator.run([{ role: "user", content: "read" }])

  assert.ok(events.some((event) => event.type === "agent-step" && event.phase === "budget_exceeded"))
})

test("有 toolCalls 时中间 content 不进入聊天气泡", async () => {
  const chunks: string[] = []
  let callCount = 0
  const client = {
    async completeWithTools() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: "我先读取文件",
          toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }],
        }
      }
      return { content: "最终答案", toolCalls: [] }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async () => ({ content: "file", detail: "read" }),
    isReadOnlyTool: () => true,
    emit: (event) => {
      if (event.type === "chunk") chunks.push(event.content)
    },
    isCancelled: () => false,
  })

  await orchestrator.run([{ role: "user", content: "read" }])

  assert.deepEqual(chunks, ["最终答案"])
})

test("模型把只读调用写成文本时结构化恢复，且不把伪调用显示给用户", async () => {
  const toolDefinitions = [
    {
      type: "function" as const,
      function: { name: "read_file", description: "read", parameters: { type: "object" } },
    },
  ]
  const chunks: string[] = []
  const executed: unknown[] = []
  let callCount = 0
  const client = {
    async completeWithTools() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: '{"name":"read_file","parameters":{"path":"note.txt"}}<|eot_id|>',
          toolCalls: [],
        }
      }
      return { content: "文件内容是 hello", toolCalls: [] }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: toolDefinitions as never,
    executeTool: async (name, args) => {
      executed.push({ name, args })
      return { content: "hello", detail: "read note.txt" }
    },
    isReadOnlyTool: () => true,
    emit: (event) => {
      if (event.type === "chunk") chunks.push(event.content)
    },
    isCancelled: () => false,
  })

  await orchestrator.run([{ role: "user", content: "读 note.txt" }])

  assert.deepEqual(executed, [{ name: "read_file", args: { path: "note.txt" } }])
  assert.deepEqual(chunks, ["文件内容是 hello"])
})

test("文本里的变更类调用不被直接执行，改为要求重新发起 tool_calls", async () => {
  const toolDefinitions = [
    {
      type: "function" as const,
      function: { name: "write_file", description: "write", parameters: { type: "object" } },
    },
  ]
  const executed: string[] = []
  let callCount = 0
  const client = {
    async completeWithTools() {
      callCount += 1
      if (callCount === 1) {
        return {
          content: '{"name":"write_file","parameters":{"path":"a.txt","content":"x"}}',
          toolCalls: [],
        }
      }
      return { content: "好的，我不再直接改文件。", toolCalls: [] }
    },
  }
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: toolDefinitions as never,
    executeTool: async (name) => {
      executed.push(name)
      return { content: "", detail: "" }
    },
    isReadOnlyTool: () => false,
    emit: () => {},
    isCancelled: () => false,
  })

  await orchestrator.run([{ role: "user", content: "写文件" }])

  assert.deepEqual(executed, [])
  assert.equal(callCount, 2)
})

test("已授权项目且只说计划未调工具时强制重试一次", async () => {
  let callCount = 0
  const client = {
    async completeWithTools() {
      callCount += 1
      if (callCount === 1) {
        return { content: "我先搜索一下相关代码", toolCalls: [] }
      }
      if (callCount === 2) {
        return {
          content: "",
          toolCalls: [{ id: "1", name: "search_files", arguments: '{"query":"x"}' }],
        }
      }
      return { content: "总结", toolCalls: [] }
    },
  }
  const toolNames: string[] = []
  const chunks: string[] = []
  const orchestrator = new AgentOrchestrator({
    taskId: "task-1",
    client: client as never,
    toolDefinitions: [],
    executeTool: async (name) => {
      toolNames.push(name)
      return { content: "hit", detail: name }
    },
    isReadOnlyTool: () => true,
    emit: (event) => {
      if (event.type === "chunk") chunks.push(event.content)
    },
    isCancelled: () => false,
    projectAuthorized: true,
    projectName: "Pingo",
  })

  await orchestrator.run([{ role: "user", content: "找登录逻辑" }])

  assert.equal(callCount, 3)
  assert.deepEqual(toolNames, ["search_files"])
  assert.deepEqual(chunks, ["总结"])
})
