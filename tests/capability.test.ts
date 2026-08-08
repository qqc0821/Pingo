import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { ApprovalBroker } from "../src/main/security/approvalBroker.js"
import { CapabilityManager } from "../src/main/security/capabilityManager.js"
import type { OperationPlan } from "../src/shared/types.js"

test("capability grants are scoped, window-bound, expiring, and revocable", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-grant-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "index.ts"), "ok")
  const manager = new CapabilityManager("session-a")
  const grant = manager.grant({
    capabilities: ["workspace.read"],
    scopeRoots: [root],
    duration: "session",
    sourceWindowId: "window-a",
  })

  assert.doesNotThrow(() =>
    manager.assertAllowed("workspace.read", [join(root, "src")], "window-a"),
  )
  assert.throws(() => manager.assertAllowed("workspace.write", [join(root, "src")], "window-a"))
  assert.throws(() => manager.assertAllowed("workspace.read", [join(root, "src")], "window-b"))
  assert.equal(manager.revoke(grant.grantId), true)
  assert.throws(() => manager.assertAllowed("workspace.read", [join(root, "src")], "window-a"))
})

test("approval broker rejects replay and cross-window decisions", async () => {
  const broker = new ApprovalBroker()
  const plan: OperationPlan = {
    operationId: "operation-a",
    taskId: "task-a",
    sourceWindowId: "window-a",
    kind: "write_file",
    capability: "workspace.write",
    risk: "R2",
    riskReason: "test",
    targets: ["/tmp/pingo.txt"],
    preview: "preview",
    preconditions: [{ path: "/tmp/pingo.txt", exists: false }],
    digest: broker.createPlanDigest({ operationId: "operation-a", content: "fixed" }),
    createdAt: Date.now(),
    expiresAt: Date.now() + 2_000,
    reversible: true,
  }
  let requested = false
  const waiting = broker.waitForDecision(plan, () => {
    requested = true
  })
  assert.equal(
    broker.decide("window-b", {
      taskId: "task-a",
      operationId: "operation-a",
      decision: "approve",
    }),
    false,
  )
  assert.equal(
    broker.decide("window-a", {
      taskId: "task-a",
      operationId: "operation-a",
      decision: "approve",
    }),
    true,
  )
  const decision = await waiting
  assert.equal(requested, true)
  assert.equal(decision.decision, "approve")
  broker.consumeApproval(plan, decision.token, {
    sourceWindowId: "window-a",
    taskId: "task-a",
    operationId: "operation-a",
  })
  assert.throws(() =>
    broker.consumeApproval(plan, decision.token, {
      sourceWindowId: "window-a",
      taskId: "task-a",
      operationId: "operation-a",
    }),
  )
})
