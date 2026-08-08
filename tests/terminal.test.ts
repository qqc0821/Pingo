import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { validateCommand } from "../src/main/terminal/commandPolicy.js"
import { TerminalRunner } from "../src/main/terminal/runner.js"

test("terminal policy accepts only structured read commands and blocks shell semantics", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-terminal-"))
  const command = validateCommand(root, { executable: "/bin/pwd", args: [], cwd: "." })
  assert.equal(command.plan.executable, "/bin/pwd")
  assert.deepEqual(command.plan.args, [])
  assert.equal(command.plan.cwd.endsWith("/"), false)

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

  const result = await new TerminalRunner().run(command.plan)
  assert.equal(result.exitCode, 0)
  assert.match(result.content, /pingo-terminal-/)
})
