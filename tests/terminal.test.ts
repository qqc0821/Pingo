import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { IntentPackDefinition } from "../src/shared/types.js"
import { compileTerminalIntent } from "../src/main/terminal/intentPolicy.js"
import { validateCommand } from "../src/main/terminal/commandPolicy.js"
import {
  buildTerminalIntentSchema,
  validateIntentPackDefinition,
} from "../src/main/terminal/intentPacks.js"
import { detectPackageManager } from "../src/main/terminal/projectScript.js"
import { TerminalRunner } from "../src/main/terminal/runner.js"
import { foldOutput, StreamRedactor } from "../src/main/terminal/streamRedactor.js"

test("stream redactor masks credentials split across chunks and flushes its hold buffer", () => {
  const redactor = new StreamRedactor()
  const output = [redactor.push("Bearer abc."), redactor.push("def"), redactor.flush()].join("")
  assert.match(output, /Bearer \[redacted\]/)
  assert.doesNotMatch(output, /abc\.def/)

  const keyRedactor = new StreamRedactor()
  const keyOutput = [
    keyRedactor.push("api_key=xx"),
    keyRedactor.push("x"),
    keyRedactor.flush(),
  ].join("")
  assert.equal(keyOutput, "api_key=[redacted]")
})

test("foldOutput keeps head and tail while reporting the folded byte count", () => {
  const output = foldOutput("HEAD-" + "x".repeat(120) + "-TAIL", 32)
  assert.match(output, /^HEAD-/)
  assert.match(output, /\[\.\.\. 已折叠 \d+ 字节 \.\.\.\]/)
  assert.match(output, /-TAIL$/)
})

test("intent packs preserve the fixed V1 command plan shape", () => {
  const root = process.cwd()
  const compile = (value: unknown, operationId: string) =>
    compileTerminalIntent(value, {
      taskId: "task-pack-equivalence",
      operationId,
      sourceWindowId: "window",
      projectRoot: root,
    })
  const snapshot = [
    compile({ kind: "git.read", action: "status", args: [], cwd: "." }, "op-status"),
    compile({ kind: "git.read", action: "diff", args: ["--stat"], cwd: "." }, "op-diff"),
    compile({ kind: "git.read", action: "log", args: ["--oneline"], cwd: "." }, "op-log"),
    ...(["lint", "typecheck", "format:check", "test", "build"] as const).map((script) =>
      compile(
        { kind: "project.script", packageManager: "npm", script, forwardedArgs: [], cwd: "." },
        `op-${script}`,
      ),
    ),
  ].map((plan) => ({
    intent: plan.intent,
    executable: plan.executable.displayName,
    argv: plan.argv,
    cwd: plan.cwd.relativePath,
    workspace: plan.effects.workspace,
    projectCodeExecution: plan.effects.projectCodeExecution,
    network: plan.sandbox.network,
    tier: plan.sandbox.tier,
    risk: plan.risk,
  }))
  assert.deepEqual(snapshot, [
    {
      intent: { kind: "git.read", action: "status", args: [], cwd: "." },
      executable: "git",
      argv: ["--no-pager", "status"],
      cwd: ".",
      workspace: "read",
      projectCodeExecution: false,
      network: "deny",
      tier: "read-only",
      risk: "R1",
    },
    {
      intent: { kind: "git.read", action: "diff", args: ["--stat"], cwd: "." },
      executable: "git",
      argv: ["--no-pager", "diff", "--stat"],
      cwd: ".",
      workspace: "read",
      projectCodeExecution: false,
      network: "deny",
      tier: "read-only",
      risk: "R1",
    },
    {
      intent: { kind: "git.read", action: "log", args: ["--oneline"], cwd: "." },
      executable: "git",
      argv: ["--no-pager", "log", "--oneline"],
      cwd: ".",
      workspace: "read",
      projectCodeExecution: false,
      network: "deny",
      tier: "read-only",
      risk: "R1",
    },
    ...(["lint", "typecheck", "format:check", "test", "build"] as const).map((script) => ({
      intent: {
        kind: "project.script",
        packageManager: "npm",
        script,
        forwardedArgs: [],
        cwd: ".",
      },
      executable: "npm",
      argv: ["run", script],
      cwd: ".",
      workspace: "write",
      projectCodeExecution: true,
      network: "deny",
      tier: "workspace-write",
      risk: "R3",
    })),
  ])
})

test("intent pack validator rejects executable, argv, slot, and effects escalation", () => {
  const base: IntentPackDefinition = {
    kind: "test.pack",
    version: 1,
    executable: "git",
    actions: {
      inspect: {
        argv: ["show"],
        slots: {},
        allowedFlags: [],
        pathArgsAfterDoubleDash: true,
      },
    },
    sandboxTier: "read-only",
    effects: {
      workspace: "read",
      projectCodeExecution: false,
      network: "none",
      externalPaths: [],
    },
    risk: "R1",
    enabled: true,
  }
  assert.doesNotThrow(() => validateIntentPackDefinition(base))
  assert.throws(() => validateIntentPackDefinition({ ...base, executable: "sh" as never }))
  assert.throws(() =>
    validateIntentPackDefinition({
      ...base,
      actions: { inspect: { ...base.actions.inspect, argv: ["/tmp/out"] } },
    }),
  )
  assert.throws(() =>
    validateIntentPackDefinition({
      ...base,
      actions: { inspect: { ...base.actions.inspect, argv: ["${missing}"] } },
    }),
  )
  assert.throws(() => validateIntentPackDefinition({ ...base, sandboxTier: "workspace-write" }))
})

test("generated schema and parser share enabled enums", () => {
  const original = process.env.PINGO_INTENT_PACK_RUNTIME_INFO_ENABLED
  try {
    delete process.env.PINGO_INTENT_PACK_RUNTIME_INFO_ENABLED
    const enabledSchema = buildTerminalIntentSchema()
    const enabledKinds = (enabledSchema.properties as { kind: { enum: string[] } }).kind.enum
    assert.ok(enabledKinds.includes("runtime.info"))
    process.env.PINGO_INTENT_PACK_RUNTIME_INFO_ENABLED = "0"
    const disabledSchema = buildTerminalIntentSchema()
    const disabledKinds = (disabledSchema.properties as { kind: { enum: string[] } }).kind.enum
    assert.equal(disabledKinds.includes("runtime.info"), false)
    assert.throws(() =>
      compileTerminalIntent(
        { kind: "runtime.info", action: "node", cwd: "." },
        {
          taskId: "task-disabled-pack",
          operationId: "op-disabled-pack",
          sourceWindowId: "window",
          projectRoot: process.cwd(),
        },
      ),
    )
  } finally {
    if (original === undefined) delete process.env.PINGO_INTENT_PACK_RUNTIME_INFO_ENABLED
    else process.env.PINGO_INTENT_PACK_RUNTIME_INFO_ENABLED = original
  }
})

test("auto package-manager detection fails closed for zero or multiple lockfiles", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-lockfiles-"))
  try {
    assert.throws(() => detectPackageManager(root), /lockfile/)
    writeFileSync(join(root, "package-lock.json"), "{}")
    assert.equal(detectPackageManager(root), "npm")
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9")
    assert.throws(() => detectPackageManager(root), /多个 lockfile/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
