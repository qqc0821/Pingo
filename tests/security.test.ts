import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { listFiles } from "../src/main/tools/listFiles.js"
import { readFile } from "../src/main/tools/readFile.js"
import { searchFiles } from "../src/main/tools/searchFiles.js"
import { MAX_SCAN_ENTRIES } from "../src/main/security/pathGuard.js"

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

test("递归发现跳过依赖和产物目录，但保留根目录和源码文件", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-scan-"))
  try {
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, "node_modules"))
    mkdirSync(join(root, "out"))
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "package.json"), "{}\n")
    writeFileSync(join(root, "src", "main.ts"), "export const answer = 42\n")
    writeFileSync(join(root, "node_modules", "dependency.js"), "should not appear\n")
    writeFileSync(join(root, "out", "main.js"), "should not appear\n")
    writeFileSync(join(root, "dist", "bundle.js"), "should not appear\n")
    writeFileSync(join(root, ".DS_Store"), "ignored\n")

    const listed = listFiles(root, {})
    assert.match(listed, /package\.json/)
    assert.match(listed, /src\/main\.ts/)
    assert.doesNotMatch(listed, /node_modules|out\/|dist\/|\.DS_Store/)
    assert.match(searchFiles(root, { query: "answer" }), /src\/main\.ts/)
    assert.doesNotMatch(
      searchFiles(root, { query: "should not appear" }),
      /node_modules|out\/|dist\//,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("递归扫描达到预算后明确截断", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-budget-"))
  try {
    for (let index = 0; index < MAX_SCAN_ENTRIES + 5; index += 1) {
      writeFileSync(join(root, `file-${String(index).padStart(5, "0")}.txt`), "content\n")
    }
    const result = searchFiles(root, { query: "__never_matches__" })
    assert.match(result, /扫描已达到安全条目预算/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
