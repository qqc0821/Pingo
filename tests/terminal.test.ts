import assert from "node:assert/strict"
import test from "node:test"
import { compileTerminalIntent } from "../src/main/terminal/intentPolicy.js"
import { validateCommand } from "../src/main/terminal/commandPolicy.js"
import { TerminalRunner } from "../src/main/terminal/runner.js"

test("terminal policy accepts only structured read commands and blocks shell semantics", async () => {
  const root = process.cwd()
  const command = compileTerminalIntent(
    { kind: "git.read", action: "status", args: [], cwd: "." },
    {
      taskId: "task-terminal",
      operationId: "operation-terminal",
      sourceWindowId: "window-a",
      projectRoot: root,
    },
  )
  assert.equal(command.executable.displayName, "git")
  assert.deepEqual(command.argv, ["--no-pager", "status"])
  assert.equal(command.cwd.relativePath, ".")

  assert.throws(
    () => validateCommand(root, { executable: "/bin/sh", args: ["-c", "pwd"], cwd: "." }),
    /未知或未允许的可执行文件/,
  )
  assert.throws(
    () =>
      validateCommand(root, {
        executable: "/usr/bin/git",
        args: ["-c", "x=y", "status"],
        cwd: ".",
      }),
    /只开放 status、diff、log/,
  )
  assert.throws(
    () => validateCommand(root, { executable: "/usr/bin/npm", args: ["install"], cwd: "." }),
    /npm run/,
  )

  const result = await new TerminalRunner().run(command)
  assert.equal(result.exitCode, 0)
  assert.match(result.content, /On branch|working tree|Changes|nothing to commit/i)
})
