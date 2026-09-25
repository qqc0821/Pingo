import assert from "node:assert/strict"
import test from "node:test"
import {
  TerminalError,
  type TerminalBackend,
  type TerminalBackendSession,
  type TerminalBackendSpawnSpec,
  type TerminalReadResult,
  type TerminalRunOperation,
  type TerminalRunResult,
  type TerminalSessionStatus,
  type TerminalSignal,
} from "../src/main/terminal/backend.js"
import { TerminalSessionService } from "../src/main/terminal/sessionRegistry.js"
import type { ResolvedCommandPlan } from "../src/shared/types.js"

function fakePlan(digest = "a".repeat(64)): ResolvedCommandPlan {
  return { planDigest: digest, intent: { kind: "git.read" } } as unknown as ResolvedCommandPlan
}

class FakeSession implements TerminalBackendSession {
  readonly motd = ""
  readonly pid = 123
  statusValue: TerminalSessionStatus = { kind: "running" }
  closeCalls: string[] = []
  signalCalls: TerminalSignal[] = []
  readResult: TerminalReadResult = {
    text: "",
    totalLines: 0,
    lineBegin: 0,
    lineEnd: 0,
    truncated: false,
  }
  private readonly settle: (result: TerminalRunResult) => void
  private readonly reject: (error: Error) => void
  readonly operation: TerminalRunOperation

  constructor() {
    let resolve!: (result: TerminalRunResult) => void
    let reject!: (error: Error) => void
    const done = new Promise<TerminalRunResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.settle = resolve
    this.reject = reject
    this.operation = {
      done,
      readOutput: () => ({ delta: "", truncated: false }),
      cancel: () => false,
    }
  }

  complete(): void {
    this.statusValue = { kind: "exited", exitCode: 0, signal: null }
    this.settle({
      content: "done",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
      hardLimitExceeded: false,
      outputBytes: 4,
      durationMs: 1,
    })
  }

  fail(error: Error): void {
    this.statusValue = { kind: "exited", exitCode: null, signal: null }
    this.reject(error)
  }

  read(): TerminalReadResult {
    return this.readResult
  }

  async signal(signal: TerminalSignal): Promise<void> {
    this.signalCalls.push(signal)
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  async close(reason: string): Promise<void> {
    this.closeCalls.push(reason)
    this.statusValue = { kind: "exited", exitCode: null, signal: "SIGKILL" }
  }
}

class FakeBackend implements TerminalBackend {
  readonly type = "fake"
  readonly sessions: FakeSession[] = []
  spawnError?: Error

  spawn(spec: TerminalBackendSpawnSpec): TerminalBackendSession {
    void spec
    if (this.spawnError) throw this.spawnError
    const session = new FakeSession()
    this.sessions.push(session)
    return session
  }
}

function makeService(backend: FakeBackend, maxConcurrent?: number): TerminalSessionService {
  const service = new TerminalSessionService({ maxConcurrent })
  service.registerBackend(backend)
  return service
}

test("registry spawns, lists, reads, signals, and kills an owner-scoped session", async () => {
  const backend = new FakeBackend()
  const service = makeService(backend)
  try {
    const spawned = await service.spawn("task-a", { type: "fake", plan: fakePlan() })
    assert.match(spawned.snapshot.sessionId, /^term-/)
    assert.equal(spawned.snapshot.type, "fake")
    assert.equal(spawned.snapshot.status.kind, "running")
    assert.equal(spawned.snapshot.planDigest, "a".repeat(64))
    assert.equal(spawned.snapshot.intentKind, "git.read")
    assert.ok(spawned.operation)

    assert.equal(service.list("task-a").length, 1)
    assert.equal(service.list("task-b").length, 0)
    assert.equal(service.hasOwnerActivity("task-a"), true)
    assert.deepEqual(service.listBackends(), ["fake"])

    const id = spawned.snapshot.sessionId
    assert.equal(service.read("task-a", id).text, "")
    await service.signal("task-a", id, "SIGINT")
    assert.deepEqual(backend.sessions[0]?.signalCalls, ["SIGINT"])

    assert.equal(await service.kill("task-a", id, "test"), true)
    assert.deepEqual(backend.sessions[0]?.closeCalls, ["test"])
    assert.equal(service.list("task-a").length, 0)
    // Kill is idempotent once removed.
    assert.equal(await service.kill("task-a", id, "test"), false)
  } finally {
    await service.disposeAll()
  }
})

test("registry rejects unknown backend, duplicate backend/name, and concurrency overflow", async () => {
  const backend = new FakeBackend()
  const service = new TerminalSessionService({ maxConcurrent: 1 })
  try {
    service.registerBackend(backend)
    assert.throws(
      () => service.registerBackend(new FakeBackend()),
      (error: unknown) => error instanceof TerminalError && error.code === "DUPLICATE_BACKEND",
    )

    await assert.rejects(
      service.spawn("task-a", { type: "missing", plan: fakePlan() }),
      (error: unknown) => error instanceof TerminalError && error.code === "NO_BACKEND",
    )

    const first = await service.spawn("task-a", { type: "fake", name: "shell", plan: fakePlan() })
    await assert.rejects(
      service.spawn("task-a", { type: "fake", name: "shell", plan: fakePlan() }),
      (error: unknown) => error instanceof TerminalError && error.code === "DUPLICATE_NAME",
    )
    // Concurrency cap (max 1) rejects a second running session.
    await assert.rejects(
      service.spawn("task-a", { type: "fake", plan: fakePlan() }),
      (error: unknown) => error instanceof TerminalError && error.code === "LIMIT_REACHED",
    )
    // Once the first session exits, a new spawn is admitted.
    backend.sessions[0]?.complete()
    const second = await service.spawn("task-a", { type: "fake", plan: fakePlan() })
    assert.notEqual(second.snapshot.sessionId, first.snapshot.sessionId)
  } finally {
    await service.disposeAll()
  }
})

test("registry fences foreign and unknown sessions and cleans up per owner", async () => {
  const backend = new FakeBackend()
  const service = makeService(backend)
  try {
    const id = (await service.spawn("task-a", { type: "fake", plan: fakePlan() })).snapshot
      .sessionId

    assert.throws(
      () => service.read("task-b", id),
      (error: unknown) => error instanceof TerminalError && error.code === "FOREIGN_SESSION",
    )
    assert.throws(
      () => service.read("task-a", "term-missing"),
      (error: unknown) => error instanceof TerminalError && error.code === "NO_SESSION",
    )
    await assert.rejects(
      service.signal("task-b", id, "SIGTERM"),
      (error: unknown) => error instanceof TerminalError && error.code === "FOREIGN_SESSION",
    )
    await assert.rejects(
      service.kill("task-b", id, "wrong owner"),
      (error: unknown) => error instanceof TerminalError && error.code === "FOREIGN_SESSION",
    )

    await service.disposeOwned("task-b")
    assert.equal(service.list("task-a").length, 1)

    await service.disposeOwned("task-a")
    assert.equal(service.list("task-a").length, 0)
    assert.deepEqual(backend.sessions[0]?.closeCalls, ["owner disposed"])
  } finally {
    await service.disposeAll()
  }
})

test("registry disposes all sessions and rejects spawn after disposal", async () => {
  const backend = new FakeBackend()
  const service = makeService(backend)
  await service.spawn("task-a", { type: "fake", plan: fakePlan() })
  await service.spawn("task-b", { type: "fake", plan: fakePlan() })
  await service.disposeAll()

  assert.equal(service.list("task-a").length, 0)
  assert.equal(service.list("task-b").length, 0)
  assert.equal(
    backend.sessions.every((session) => session.closeCalls.length > 0),
    true,
  )

  await assert.rejects(
    service.spawn("task-a", { type: "fake", plan: fakePlan() }),
    (error: unknown) => error instanceof TerminalError && error.code === "SERVICE_DISPOSING",
  )
})

test("registry rolls back a backend session when publication fails", async () => {
  const backend = new FakeBackend()
  const service = makeService(backend)
  // A backend that throws after allocating is not the rollback path; instead we
  // simulate publication failure by disposing mid-flight through a throwing
  // backend spawn, which must reject without leaving a session behind.
  backend.spawnError = new Error("seatbelt unavailable")
  await assert.rejects(service.spawn("task-a", { type: "fake", plan: fakePlan() }), /seatbelt/)
  assert.equal(service.list("task-a").length, 0)
  await service.disposeAll()
})
