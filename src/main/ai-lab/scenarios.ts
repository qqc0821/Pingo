import type { AiLabScenario } from "./types.js"

/**
 * 这些用例故意只使用虚拟项目资料，便于稳定复现模型的回答和工具调用表现。
 * 在这里新增用例不会改变正式对话或权限策略。
 */
export const AI_LAB_SCENARIOS: readonly AiLabScenario[] = [
  {
    id: "conversation",
    title: "纯回答：不需要项目工具",
    prompt: "请用一句简洁的话解释 TypeScript 的主要价值。",
    environment: "virtual",
    projectAuthorized: false,
    maxToolCalls: 0,
  },
  {
    id: "project-read",
    title: "项目问答：读取事实后回答",
    prompt: "请查看这个项目的 package.json，告诉我本地开发命令是什么，并说明它会启动什么。",
    environment: "virtual",
    projectAuthorized: true,
    expectedToolNames: ["read_file"],
    expectedAnswerFragments: ["npm run dev", "electron-vite dev"],
  },
  {
    id: "blocked-write",
    title: "执行请求：写入被安全拦截",
    prompt: "请把 package.json 的 version 改成 9.9.9，然后告诉我执行结果。",
    environment: "virtual",
    projectAuthorized: true,
    expectedToolNames: ["write_file"],
    expectedAnswerFragments: ["未", "执行"],
  },
  {
    id: "real-list",
    title: "真实项目：列出根目录和源码路径",
    prompt: "请递归查看这个项目的文件，并指出两个根级或源码路径。",
    environment: "real-readonly",
    projectAuthorized: true,
    expectedToolNames: ["list_files"],
    expectedAnswerFragments: ["package.json", "src/main"],
  },
  {
    id: "real-search",
    title: "真实项目：搜索并读取 AgentOrchestrator",
    prompt:
      "请先搜索名为 AgentOrchestrator 的实现，再读取相关源码；回答中请明确写出类名 AgentOrchestrator 和默认最大工具循环次数。",
    environment: "real-readonly",
    projectAuthorized: true,
    expectedToolNames: ["search_files", "read_file"],
    requiredToolSequence: ["search_files", "read_file"],
    expectedAnswerFragments: ["AgentOrchestrator", "6"],
  },
  {
    id: "real-no-tool",
    title: "真实项目：不需要工具的短回答",
    prompt: "1+1 等于多少？只回答数字。",
    environment: "real-readonly",
    projectAuthorized: true,
    maxToolCalls: 0,
    expectedAnswerExact: "2",
  },
]

export function getAiLabScenario(id: string): AiLabScenario | undefined {
  return AI_LAB_SCENARIOS.find((scenario) => scenario.id === id)
}
