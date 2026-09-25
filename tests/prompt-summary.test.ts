import assert from "node:assert/strict"
import test from "node:test"
import { summarizePromptContent } from "../src/shared/promptSummary.js"

test("数量问题的摘要只保留总数，不带分类明细", () => {
  const content =
    "Pingo 项目里共有 25 张图片，其中 23 张 PNG，2 张 GIF。\n\n具体分布：\n- src/assets/：4 张"

  assert.equal(summarizePromptContent(content, "项目里有多少张图片？"), "共有 25 张图片。")
})

test("数量问题支持其他量词", () => {
  assert.equal(
    summarizePromptContent("桌面共有 12 个文件夹。后面还有详细列表。", "桌面有多少个文件夹？"),
    "共有 12 个文件夹。",
  )
})

test("用户明确要求分类时不强制压成总数", () => {
  assert.equal(
    summarizePromptContent(
      "共有 25 张图片，其中 23 张 PNG，2 张 GIF。",
      "项目里的 PNG 和 GIF 分别有多少张？",
    ),
    "共有 25 张图片，其中 23 张 PNG，2 张 GIF。",
  )
})

test("非数量问题仍使用首个结论句", () => {
  assert.equal(
    summarizePromptContent(
      "编译失败，原因是类型不匹配。\n\n详细位置在 src/App.tsx。",
      "编译为什么失败？",
    ),
    "编译失败，原因是类型不匹配。",
  )
})
