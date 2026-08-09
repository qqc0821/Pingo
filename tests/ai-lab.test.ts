import assert from "node:assert/strict"
import test from "node:test"
import { getAiLabScenario } from "../src/main/ai-lab/scenarios.js"
import { runAiLabScenario } from "../src/main/ai-lab/runner.js"

test("AI Lab 在虚拟项目中验证读取后的事实回答", async () => {
  const scenario = getAiLabScenario("project-read")
  assert.ok(scenario)
  let calls = 0
  const client = {
    async completeWithTools() {
      calls += 1
      if (calls === 1) {
        return {
          content: "",
          toolCalls: [
            { id: "read-package", name: "read_file", arguments: '{"path":"package.json"}' },
          ],
        }
      }
      return { content: "本地开发命令是 npm run dev，它会运行 electron-vite dev。", toolCalls: [] }
    },
  }

  const report = await runAiLabScenario({ scenario, client })

  assert.equal(report.safeMode, true)
  assert.equal(report.passed, true)
  assert.deepEqual(
    report.toolTraces.map((trace) => trace.name),
    ["read_file"],
  )
  assert.match(report.toolTraces[0]?.content ?? "", /electron-vite dev/)
})

test("AI Lab 记录写入请求但不会实际执行", async () => {
  const scenario = getAiLabScenario("blocked-write")
  assert.ok(scenario)
  let calls = 0
  const client = {
    async completeWithTools() {
      calls += 1
      if (calls === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "write-package",
              name: "write_file",
              arguments: JSON.stringify({
                path: "package.json",
                content: JSON.stringify({ version: "9.9.9" }),
              }),
            },
          ],
        }
      }
      return { content: "写入未执行，真实项目没有改动。", toolCalls: [] }
    },
  }

  const report = await runAiLabScenario({ scenario, client })

  assert.equal(report.passed, true)
  assert.equal(report.toolTraces.length, 1)
  assert.equal(report.toolTraces[0]?.mutating, true)
  assert.match(report.toolTraces[0]?.content ?? "", /ai_lab_safe_mode/)
})
