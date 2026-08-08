import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { planFileOperation, applyTextPatch } from "../src/main/tools/fileOperations.js"

const digest = (value: unknown) => JSON.stringify(value)

test("structured file operations preview, atomically write, guard races, move, and trash", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-ops-"))
  const sourcePath = join(root, "note.txt")
  writeFileSync(sourcePath, "before\n")

  const write = planFileOperation(
    root,
    "task-a",
    "window-a",
    "write_file",
    {
      path: "note.txt",
      content: "after\n",
    },
    digest,
  )
  assert.match(write.plan.preview, /before/)
  writeFileSync(sourcePath, "changed elsewhere\n")
  await assert.rejects(() => write.execute(), /预览后文件已变化/)

  const writeAgain = planFileOperation(
    root,
    "task-a",
    "window-a",
    "write_file",
    {
      path: "note.txt",
      content: "after\n",
    },
    digest,
  )
  const result = await writeAgain.execute()
  assert.equal(result.status, "completed")
  assert.equal(readFileSync(sourcePath, "utf8"), "after\n")

  assert.throws(
    () =>
      planFileOperation(
        root,
        "task-a",
        "window-a",
        "apply_patch",
        {
          path: "note.txt",
          patch: "@@ -1,1 +1,1 @@\n-before\n+patched\n",
        },
        digest,
      ),
    /补丁上下文/,
  )
  assert.equal(
    applyTextPatch("one\ntwo\n", "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n"),
    "one\nchanged\n",
  )

  writeFileSync(join(root, "move.txt"), "move me")
  const move = planFileOperation(
    root,
    "task-a",
    "window-a",
    "move_path",
    {
      from: "move.txt",
      to: "moved.txt",
    },
    digest,
  )
  await move.execute()
  assert.equal(existsSync(join(root, "moved.txt")), true)

  const trash = planFileOperation(
    root,
    "task-a",
    "window-a",
    "trash_path",
    {
      path: "moved.txt",
    },
    digest,
  )
  let trashed = ""
  await trash.execute({
    trashItem: async (path) => {
      trashed = path
    },
  })
  assert.equal(trashed, realpathSync.native(join(root, "moved.txt")))
})
