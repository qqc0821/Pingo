import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { loadDotEnv } from "../src/main/env.js"

test("environment loader finds the packaged app configuration directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-env-"))
  const missingDirectory = join(root, "missing")
  const userDataDirectory = join(root, "Library", "Application Support", "pingo")
  const previousKey = process.env.MODEL_API_KEY

  try {
    mkdirSync(userDataDirectory, { recursive: true })
    writeFileSync(join(userDataDirectory, ".env"), 'MODEL_API_KEY="packaged-test-key"\n')
    delete process.env.MODEL_API_KEY

    loadDotEnv([missingDirectory, userDataDirectory])

    assert.equal(process.env.MODEL_API_KEY, "packaged-test-key")
  } finally {
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
    rmSync(root, { recursive: true, force: true })
  }
})

test("environment loader keeps an existing non-empty key", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-env-precedence-"))
  const previousKey = process.env.MODEL_API_KEY

  try {
    writeFileSync(join(root, ".env"), "MODEL_API_KEY=file-key\n")
    process.env.MODEL_API_KEY = "runtime-key"

    loadDotEnv([root])

    assert.equal(process.env.MODEL_API_KEY, "runtime-key")
  } finally {
    if (previousKey === undefined) delete process.env.MODEL_API_KEY
    else process.env.MODEL_API_KEY = previousKey
    rmSync(root, { recursive: true, force: true })
  }
})
