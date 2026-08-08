import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { compileTerminalIntent, revalidateTerminalPlan } from "../src/main/terminal/intentPolicy.js"
import { TerminalRunner } from "../src/main/terminal/runner.js"

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
    const outputPlan = { ...outputBase, limits: { ...outputBase.limits, outputBytes: 1_024 } }
    const outputRunner = new TerminalRunner()
    const outputResult = await outputRunner.run(outputPlan)
    assert.equal(outputResult.truncated, true)
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
