import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { compileTerminalIntent, revalidateTerminalPlan } from "../src/main/terminal/intentPolicy.js"
import { readableFingerprint } from "../src/main/tasks/taskManager.js"
import { detectSandboxDenial, TERMINAL_POLICY_CATALOG } from "../src/main/terminal/policyCatalog.js"
import {
  TERMINAL_TRUST_DECAY_MS,
  TERMINAL_TRUST_MAX_USES,
  TerminalTrustManager,
} from "../src/main/security/terminalTrust.js"

test("structured intents resolve executable identity, script body/hash, effects, and sandbox spec", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-plan-"))
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node tests/probe.js" } }),
    )
    const plan = compileTerminalIntent(
      {
        kind: "project.script",
        packageManager: "npm",
        script: "test",
        forwardedArgs: [],
        cwd: ".",
      },
      {
        taskId: "task-a",
        operationId: "operation-a",
        sourceWindowId: "window-a",
        projectRoot: root,
      },
    )
    assert.equal(plan.executable.displayName, "npm")
    assert.ok(plan.executable.realPath.endsWith("npm-cli.js"))
    assert.equal(plan.projectScript?.body, "node tests/probe.js")
    assert.equal(plan.effects.projectCodeExecution, true)
    assert.equal(plan.effects.network, "none")
    assert.equal(plan.sandbox.network, "deny")
    assert.equal(plan.risk, "R3")
    assert.equal(plan.planDigest.length, 64)
    assert.ok(Object.isFrozen(plan))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("git grammar rejects path/config/pager/external diff escape parameters", () => {
  const root = process.cwd()
  const rejected = [
    ["status", ["/tmp/out"]],
    ["status", [".."]],
    ["diff", ["--no-index", "a", "b"]],
    ["diff", ["--output=/tmp/out"]],
    ["diff", ["--ext-diff"]],
    ["diff", ["--textconv"]],
    ["log", ["-c", "core.pager=cat"]],
    ["log", ["--config-env=GIT_CONFIG_GLOBAL=HOME/.gitconfig"]],
    ["log", ["--pager=less"]],
  ] as const
  for (const [action, args] of rejected) {
    assert.throws(() =>
      compileTerminalIntent(
        { kind: "git.read", action, args, cwd: "." },
        {
          taskId: "task",
          operationId: `op-${action}-${args[0]}`,
          sourceWindowId: "window",
          projectRoot: root,
        },
      ),
    )
  }
})

test("legacy shell, interpreter, privilege, delete, install, download, and remote operations never compile", () => {
  const root = process.cwd()
  const forbidden = [
    { executable: "/bin/sh", args: ["-c", "git status"] },
    { executable: "/usr/bin/sudo", args: ["git", "status"] },
    { executable: "/usr/bin/rm", args: ["-rf", "."] },
    { executable: "/usr/bin/curl", args: ["https://example.com"] },
    { executable: "/usr/bin/git", args: ["push"] },
    { executable: "/usr/bin/npm", args: ["install"] },
    { executable: "/usr/bin/node", args: ["-e", "process.exit()"] },
  ]
  for (const value of forbidden) {
    assert.throws(() =>
      compileTerminalIntent(value, {
        taskId: "task",
        operationId: "operation-forbidden",
        sourceWindowId: "window",
        projectRoot: root,
      }),
    )
  }
})

test("new read-only intent packs compile with read-only sandbox and reject path/flag escapes", () => {
  const root = process.cwd()
  const show = compileTerminalIntent(
    { kind: "git.inspect", action: "show", args: ["HEAD", "--", "package.json"], cwd: "." },
    {
      taskId: "task-inspect",
      operationId: "op-inspect",
      sourceWindowId: "window",
      projectRoot: root,
    },
  )
  assert.deepEqual(show.argv, ["--no-pager", "show", "HEAD", "--", "package.json"])
  assert.equal(show.sandbox.tier, "read-only")
  assert.equal(show.effects.workspace, "read")

  const runtime = compileTerminalIntent(
    { kind: "runtime.info", action: "node", cwd: "." },
    {
      taskId: "task-runtime",
      operationId: "op-runtime",
      sourceWindowId: "window",
      projectRoot: root,
    },
  )
  assert.equal(runtime.executable.displayName, "node")
  assert.deepEqual(runtime.argv, ["--version"])
  assert.equal(runtime.sandbox.network, "deny")

  const audit = compileTerminalIntent(
    { kind: "pkg.audit", action: "ls", packageManager: "auto", cwd: "." },
    { taskId: "task-audit", operationId: "op-audit", sourceWindowId: "window", projectRoot: root },
  )
  assert.equal(audit.executable.displayName, "npm")
  assert.deepEqual(audit.argv, ["ls", "--depth=0", "--offline"])
  assert.equal(audit.sandbox.tier, "read-only")

  assert.throws(() =>
    compileTerminalIntent(
      { kind: "git.inspect", action: "show", args: ["--output=/tmp/out"], cwd: "." },
      {
        taskId: "task-escape",
        operationId: "op-escape",
        sourceWindowId: "window",
        projectRoot: root,
      },
    ),
  )
  assert.throws(() =>
    compileTerminalIntent(
      { kind: "git.inspect", action: "blame", args: ["package.json"], cwd: "." },
      { taskId: "task-path", operationId: "op-path", sourceWindowId: "window", projectRoot: root },
    ),
  )

})

test("directory.list compiles an allowlisted read-only command", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-directory-list-"))
  try {
    writeFileSync(join(root, "visible-marker.txt"), "marker\n")
    const plan = compileTerminalIntent(
      { kind: "directory.list", action: "list", cwd: "." },
      {
        taskId: "task-directory-list",
        operationId: "operation-directory-list",
        sourceWindowId: "window",
        projectRoot: root,
      },
    )
    assert.equal(plan.executable.displayName, "ls")
    assert.deepEqual(plan.argv, ["-1"])
    assert.equal(plan.effects.workspace, "read")
    assert.equal(plan.sandbox.network, "deny")

  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("session trust is limited to read-only R1, decays, caps at 20 uses, and is revocable", () => {
  const root = process.cwd()
  const readPlan = compileTerminalIntent(
    { kind: "git.read", action: "status", args: [], cwd: "." },
    { taskId: "task-trust", operationId: "op-trust", sourceWindowId: "window", projectRoot: root },
  )
  const scriptPlan = compileTerminalIntent(
    { kind: "project.script", packageManager: "npm", script: "test", forwardedArgs: [], cwd: "." },
    {
      taskId: "task-script-trust",
      operationId: "op-script-trust",
      sourceWindowId: "window",
      projectRoot: root,
    },
  )
  const manager = new TerminalTrustManager("session-trust")
  const now = Date.now()
  assert.throws(() => manager.grant(scriptPlan, "window", now), /read-only|R1/)
  manager.grant(readPlan, "window", now)
  for (let count = 0; count < TERMINAL_TRUST_MAX_USES; count += 1) {
    assert.equal(manager.consumeIfAllowed(readPlan, "window", now + count), true)
  }
  assert.equal(
    manager.consumeIfAllowed(readPlan, "window", now + TERMINAL_TRUST_MAX_USES + 1),
    false,
  )

  const freshManager = new TerminalTrustManager("session-trust-fresh")
  freshManager.grant(readPlan, "window", now)
  assert.equal(
    freshManager.consumeIfAllowed(readPlan, "window", now + TERMINAL_TRUST_DECAY_MS + 1),
    false,
  )
  freshManager.grant(readPlan, "window", now)
  assert.equal(freshManager.list(now).length, 1)
  freshManager.revokeAll(now)
  assert.deepEqual(freshManager.list(now), [])
})

test("readable fingerprint collisions never replace the full plan digest", () => {
  const leftDigest = "0".repeat(64)
  const rightDigest = "0".repeat(24) + "f".repeat(40)
  assert.notEqual(leftDigest, rightDigest)
  assert.deepEqual(readableFingerprint(leftDigest), readableFingerprint(rightDigest))
})

test("terminal policy catalog is exhaustive and explains Seatbelt denials", () => {
  const codes = [
    "user_denied",
    "approval_expired",
    "sandbox_unavailable",
    "sandbox_denied_fs",
    "sandbox_denied_network",
    "plan_changed",
    "script_changed",
    "executable_changed",
    "command_forbidden",
    "timed_out",
    "cancelled",
    "output_limit_exceeded",
  ] as const
  assert.deepEqual(Object.keys(TERMINAL_POLICY_CATALOG).sort(), [...codes].sort())
  const filesystem = detectSandboxDenial(
    `sandbox-exec: deny(1) file-write-data "/private/tmp/pingo-secret.txt"`,
  )
  assert.equal(filesystem?.code, "sandbox_denied_fs")
  assert.match(filesystem?.message ?? "", /pingo-secret\.txt/)
  const network = detectSandboxDenial("sandbox-exec: deny(1) network-outbound")
  assert.equal(network?.code, "sandbox_denied_network")
})

test("approved project script is revalidated when package.json or script body changes", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-script-change-"))
  try {
    const packagePath = join(root, "package.json")
    writeFileSync(packagePath, JSON.stringify({ scripts: { test: "node tests/probe.js" } }))
    const plan = compileTerminalIntent(
      {
        kind: "project.script",
        packageManager: "npm",
        script: "test",
        forwardedArgs: [],
        cwd: ".",
      },
      { taskId: "task", operationId: "operation", sourceWindowId: "window", projectRoot: root },
    )
    writeFileSync(packagePath, JSON.stringify({ scripts: { test: "node tests/changed.js" } }))
    assert.throws(() => revalidateTerminalPlan(root, plan), /script|package.json|变化/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
