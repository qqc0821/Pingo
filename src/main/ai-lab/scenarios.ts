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
    projectAuthorized: false,
    maxToolCalls: 0,
  },
  {
    id: "project-read",
    title: "项目问答：读取事实后回答",
    prompt: "请查看这个项目的 package.json，告诉我本地开发命令是什么，并说明它会启动什么。",
    projectAuthorized: true,
    expectedToolNames: ["read_file"],
    expectedAnswerFragments: ["npm run dev", "electron-vite dev"],
  },
  {
    id: "blocked-write",
    title: "执行请求：写入被安全拦截",
    prompt: "请把 package.json 的 version 改成 9.9.9，然后告诉我执行结果。",
    projectAuthorized: true,
    expectedToolNames: ["write_file"],
    expectedAnswerFragments: ["未", "执行"],
  },
]

export function getAiLabScenario(id: string): AiLabScenario | undefined {
  return AI_LAB_SCENARIOS.find((scenario) => scenario.id === id)
}
