import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { listFiles } from "../src/main/tools/listFiles.js"
import { readFile } from "../src/main/tools/readFile.js"
import { searchFiles } from "../src/main/tools/searchFiles.js"

test("read-only tools allow project files and reject sensitive or escaping paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-tools-"))
  const outside = mkdtempSync(join(tmpdir(), "pingo-outside-"))
  try {
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "package.json"), '{"name":"demo"}\n')
    writeFileSync(join(root, "src", "index.ts"), "export const answer = 42\n")
    writeFileSync(join(root, ".env"), "SECRET=value\n")
    writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]))
    writeFileSync(join(outside, "secret.txt"), "outside\n")
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"))

    assert.match(readFile(root, { path: "package.json" }), /demo/)
    assert.match(searchFiles(root, { query: "answer" }), /src\/index\.ts/)
    const listed = listFiles(root, {})
    assert.match(listed, /package\.json/)
    assert.doesNotMatch(listed, /\.env/)
    assert.doesNotMatch(listed, /escape\.txt/)

    assert.throws(() => readFile(root, { path: "../pingo-outside" }), /\.\./)
    assert.throws(() => readFile(root, { path: ".env" }), /安全原因/)
    assert.throws(() => readFile(root, { path: "escape.txt" }), /授权目录/)
    assert.throws(() => readFile(root, { path: "binary.bin" }), /二进制/)
    assert.throws(() => readFile(root, { path: "package.json", startLine: 0 }), /正整数/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
