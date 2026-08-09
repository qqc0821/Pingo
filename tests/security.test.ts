import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { listFiles } from "../src/main/tools/listFiles.js"
import { readFile } from "../src/main/tools/readFile.js"
import { executeTool } from "../src/main/tools/registry.js"
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

test("授权目录内存在不可读子目录时，扫描跳过它而不是整体失败", () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-eperm-"))
  const lockedDirectory = join(root, "locked")
  try {
    mkdirSync(lockedDirectory)
    writeFileSync(join(lockedDirectory, "hidden.txt"), "unreachable\n")
    writeFileSync(join(root, "visible.ts"), "export const answer = 42\n")
    chmodSync(lockedDirectory, 0o000)

    const listed = listFiles(root, {})
    assert.match(listed, /visible\.ts/)
    assert.doesNotMatch(listed, /hidden\.txt/)
    assert.match(searchFiles(root, { query: "answer" }), /visible\.ts/)
  } finally {
    chmodSync(lockedDirectory, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

test("工具失败时回给模型的提示只描述单个目标，不泄漏 errno", async () => {
  const root = mkdtempSync(join(tmpdir(), "pingo-errno-"))
  try {
    const missing = await executeTool(root, "list_files", { directory: "does-not-exist" })
    assert.doesNotMatch(missing.content, /ENOENT/)
    assert.match(missing.content, /list_files/)

    const notAFile = await executeTool(root, "read_file", { path: "." })
    assert.doesNotMatch(notAFile.content, /ENOENT|EISDIR|EPERM|ENOTDIR/)
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
