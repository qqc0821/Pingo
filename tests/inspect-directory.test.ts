import assert from "node:assert/strict"
import test from "node:test"
import { getRealProjectRoot } from "../src/main/security/pathGuard.js"
import { listFiles } from "../src/main/tools/listFiles.js"

test("inspect the explicitly selected directory with Pingo read-only rules", (context) => {
  const requestedDirectory = process.env.PINGO_INSPECT_DIRECTORY?.trim()
  if (!requestedDirectory) {
    context.skip('未设置 PINGO_INSPECT_DIRECTORY；需要单独运行时请传入目标目录')
    return
  }

  const directory = getRealProjectRoot(requestedDirectory)
  const listing = listFiles(directory, {})
  const expectedEntry = process.env.PINGO_INSPECT_EXPECT?.trim()

  console.log(`\n[inspect-directory] ${directory}`)
  console.log(listing)

  if (expectedEntry) {
    assert.ok(
      listing.split("\n").some((entry) => entry === expectedEntry),
      `目录中没有找到预期文件：${expectedEntry}`,
    )
  }
})
