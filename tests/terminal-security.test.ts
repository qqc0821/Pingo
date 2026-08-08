import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { compileTerminalIntent, revalidateTerminalPlan } from "../src/main/terminal/intentPolicy.js"
import { readableFingerprint } from "../src/main/tasks/taskManager.js"
import { detectSandboxDenial, TERMINAL_POLICY_CATALOG } from "../src/main/terminal/policyCatalog.js"
import { TerminalRunner } from "../src/main/terminal/runner.js"
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

test("Seatbelt unavailable fails closed before any child spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-sandbox-disabled-"))
  try {
    const plan = compileTerminalIntent(
      { kind: "git.read", action: "status", args: [], cwd: "." },
      {
        taskId: "task-disabled",
        operationId: "operation-disabled",
        sourceWindowId: "window",
        projectRoot: root,
      },
    )
    const runner = new TerminalRunner({
      probeSeatbelt: () => ({ available: false, reason: "test probe failed" }),
    })
    await assert.rejects(() => runner.run(plan), /test probe failed/)
    assert.equal(runner.hasActive(plan.operationId), false)
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

test("new read-only intent packs compile with read-only sandbox and reject path/flag escapes", async () => {
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

  const result = await new TerminalRunner().run(runtime)
  assert.equal(result.exitCode, 0)
  assert.match(result.content, /^v\d+/)
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

test("Seatbelt quality script cannot read HOME, workspace secrets, or external markers and has no network", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-sandbox-project-"))
  const outside = mkdtempSync(join(tmpdir(), "pingo-sandbox-outside-"))
  const homeMarker = join(homedir(), `.pingo-home-marker-${Date.now()}`)
  let unixServer: ReturnType<typeof createServer> | undefined
  try {
    const outsideMarker = join(outside, "marker.txt")
    const unixSocket = join(outside, "probe.sock")
    unixServer = createServer((socket) => socket.end("unexpected"))
    await new Promise<void>((resolve) => unixServer?.listen(unixSocket, resolve))
    writeFileSync(outsideMarker, "outside-secret")
    writeFileSync(homeMarker, "home-secret")
    writeFileSync(join(root, ".env"), "workspace-secret")
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node tests/probe.js" } }),
    )
    writeFileSync(
      join(root, "tests-probe.js"),
      `const fs = require("node:fs"); const net = require("node:net");
const read = (p) => { try { fs.readFileSync(p, "utf8"); return "read"; } catch { return "denied"; } };
const attemptNetwork = (options) => new Promise((resolve) => { const req = require("node:http").request(options, () => resolve("connected")); req.on("error", () => resolve("denied")); req.setTimeout(500, () => { req.destroy(); resolve("denied"); }); req.end(); });
const attemptUnix = new Promise((resolve) => { const socket = net.createConnection(${JSON.stringify(unixSocket)}, () => { socket.destroy(); resolve("connected"); }); socket.on("error", () => resolve("denied")); socket.setTimeout(500, () => { socket.destroy(); resolve("denied"); }); });
(async () => { console.log(JSON.stringify({home: read(${JSON.stringify(homeMarker)}), outside: read(${JSON.stringify(outsideMarker)}), env: read(".env"), public: await attemptNetwork({host:"example.com", port:80, path:"/"}), local: await attemptNetwork({host:"127.0.0.1", port:9, path:"/"}), unix: await attemptUnix})); })();`,
    )
    // package.json points at the generated probe using a valid quality script.
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node tests-probe.js" } }),
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
        taskId: "task-sandbox",
        operationId: "operation-sandbox",
        sourceWindowId: "window",
        projectRoot: root,
      },
    )
    const result = await new TerminalRunner().run(plan)
    assert.equal(result.exitCode, 0, result.content)
    const output = result.content.replace(/\s/g, "")
    assert.match(output, /"home":"denied"/)
    assert.match(output, /"outside":"denied"/)
    assert.match(output, /"env":"denied"/)
    assert.match(output, /"public":"denied"/)
    assert.match(output, /"local":"denied"/)
    assert.match(output, /"unix":"denied"/)
  } finally {
    unixServer?.close()
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    rmSync(homeMarker, { force: true })
  }
})

test("timeout, cancellation, output limits, and concurrent operation isolation leave no active child", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-lifecycle-"))
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node lifecycle-ignore.js",
          build: "node lifecycle-output.js",
          lint: "node lifecycle-done.js",
        },
      }),
    )
    writeFileSync(
      join(root, "lifecycle-ignore.js"),
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);',
    )
    writeFileSync(join(root, "lifecycle-output.js"), 'process.stdout.write("x".repeat(500000));')
    writeFileSync(
      join(root, "lifecycle-done.js"),
      'setTimeout(() => process.stdout.write("done"), 250);',
    )
    const compile = (taskId: string, operationId: string, script: "test" | "build" | "lint") =>
      compileTerminalIntent(
        { kind: "project.script", packageManager: "npm", script, forwardedArgs: [], cwd: "." },
        { taskId, operationId, sourceWindowId: "window", projectRoot: root },
      )
    const base = compile("task-timeout", "operation-timeout", "test")
    const timeoutPlan = { ...base, limits: { ...base.limits, timeoutMs: 1_000 } }
    const timeoutRunner = new TerminalRunner()
    const timeoutResult = await timeoutRunner.run(timeoutPlan)
    assert.equal(timeoutResult.timedOut, true)
    assert.equal(timeoutRunner.hasActive(base.operationId), false)

    const outputBase = compile("task-output", "operation-output", "build")
    const outputPlan = {
      ...outputBase,
      limits: { ...outputBase.limits, softOutputBytes: 64, outputBytes: 1_024 },
    }
    const outputRunner = new TerminalRunner()
    const outputResult = await outputRunner.run(outputPlan)
    assert.equal(outputResult.truncated, true)
    assert.equal(outputResult.hardLimitExceeded, true)
    assert.equal(outputRunner.hasActive(outputBase.operationId), false)

    const runner = new TerminalRunner()
    const planA = compile("task-a", "operation-a", "lint")
    const planB = compile("task-b", "operation-b", "lint")
    const runA = runner.run(planA)
    const runB = runner.run(planB)
    const deadline = Date.now() + 2_000
    while (!runner.hasActive(planA.operationId) || !runner.hasActive(planB.operationId)) {
      if (Date.now() > deadline) throw new Error("operations did not start")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(await runner.cancel("task-a", planA.operationId), true)
    const [cancelled, completed] = await Promise.all([runA, runB])
    assert.equal(cancelled.cancelled, true)
    assert.equal(completed.cancelled, false)
    assert.match(completed.content, /done/)
    assert.equal(runner.hasActive(planA.operationId), false)
    assert.equal(runner.hasActive(planB.operationId), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("runner emits ordered split progress and flushes redaction on normal, timeout, and cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-progress-"))
  try {
    writeFileSync(
      join(root, "normal.js"),
      'process.stdout.write("Bearer abc."); process.stderr.write("def");',
    )
    writeFileSync(
      join(root, "timeout.js"),
      'process.stdout.write("api_key=xx"); setInterval(() => {}, 100);',
    )
    writeFileSync(
      join(root, "cancel.js"),
      'process.stderr.write("token=can"); setInterval(() => {}, 100);',
    )
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node normal.js",
          build: "node timeout.js",
          lint: "node cancel.js",
        },
      }),
    )
    const compile = (taskId: string, operationId: string, script: "test" | "build" | "lint") =>
      compileTerminalIntent(
        { kind: "project.script", packageManager: "npm", script, forwardedArgs: [], cwd: "." },
        { taskId, operationId, sourceWindowId: "window", projectRoot: root },
      )

    const normalEvents: Array<{
      stream: string
      seq: number
      operationId: string
      content: string
    }> = []
    const normalResult = await new TerminalRunner().run(
      compile("task-normal", "op-normal", "test"),
      { onProgress: (event) => normalEvents.push(event) },
    )
    assert.equal(normalResult.exitCode, 0)
    assert.deepEqual(
      normalEvents.map((event) => event.seq),
      normalEvents.map((_, index) => index),
    )
    assert.ok(normalEvents.every((event) => event.operationId === "op-normal"))
    assert.ok(normalEvents.some((event) => event.stream === "stdout"))
    assert.ok(normalEvents.some((event) => event.stream === "stderr"))
    assert.doesNotMatch(normalEvents.map((event) => event.content).join(""), /abc\.def/)

    const timeoutEvents: string[] = []
    const timeoutBase = compile("task-timeout-progress", "op-timeout-progress", "build")
    const timeoutPlan = {
      ...timeoutBase,
      limits: { ...timeoutBase.limits, timeoutMs: 500 },
    }
    const timeoutResult = await new TerminalRunner().run(timeoutPlan, {
      onProgress: (event) => timeoutEvents.push(event.content),
    })
    assert.equal(timeoutResult.timedOut, true)
    assert.doesNotMatch(timeoutEvents.join(""), /xx/)

    const cancelRunner = new TerminalRunner()
    const cancelEvents: string[] = []
    const cancelPlan = compile("task-cancel-progress", "op-cancel-progress", "lint")
    const cancelRun = cancelRunner.run(cancelPlan, {
      onProgress: (event) => cancelEvents.push(event.content),
    })
    const deadline = Date.now() + 2_000
    while (!cancelRunner.hasActive(cancelPlan.operationId)) {
      if (Date.now() > deadline) throw new Error("cancel progress operation did not start")
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(await cancelRunner.cancel(cancelPlan.taskId, cancelPlan.operationId), true)
    const cancelResult = await cancelRun
    assert.equal(cancelResult.cancelled, true)
    assert.doesNotMatch(cancelEvents.join(""), /can/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("soft output folding does not terminate a process and preserves its tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-soft-limit-"))
  try {
    writeFileSync(
      join(root, "soft.js"),
      'process.stdout.write("HEAD-" + "x".repeat(200)); setTimeout(() => process.stdout.write("-TAIL"), 250);',
    )
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node soft.js" } }))
    const base = compileTerminalIntent(
      {
        kind: "project.script",
        packageManager: "npm",
        script: "test",
        forwardedArgs: [],
        cwd: ".",
      },
      { taskId: "task-soft", operationId: "op-soft", sourceWindowId: "window", projectRoot: root },
    )
    const result = await new TerminalRunner().run({
      ...base,
      limits: { ...base.limits, softOutputBytes: 32, outputBytes: 1_024 },
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.hardLimitExceeded, false)
    assert.equal(result.truncated, true)
    assert.match(result.content, /已折叠/)
    assert.match(result.content, /-TAIL/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
