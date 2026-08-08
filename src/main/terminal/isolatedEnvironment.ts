import { mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ResolvedCommandPlan } from "../../shared/types.js"

export function prepareIsolatedDirectories(plan: ResolvedCommandPlan): void {
  mkdirSync(join(plan.sandbox.tempRoot, "home"), { recursive: true, mode: 0o700 })
  mkdirSync(join(plan.sandbox.tempRoot, "tmp"), { recursive: true, mode: 0o700 })
  mkdirSync(join(plan.sandbox.tempRoot, "npm-cache"), { recursive: true, mode: 0o700 })
  const npmrc = join(plan.sandbox.tempRoot, "home", ".npmrc")
  writeFileSync(npmrc, "cache=${TMPDIR}/npm-cache\nupdate-notifier=false\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  chmodSync(npmrc, 0o600)
}

export function buildIsolatedEnvironment(plan: ResolvedCommandPlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: fixedPath(plan),
    HOME: join(plan.sandbox.tempRoot, "home"),
    TMPDIR: join(plan.sandbox.tempRoot, "tmp"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_PAGER: "cat",
    GIT_EXTERNAL_DIFF: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EXEC_PATH: "/Library/Developer/CommandLineTools/usr/libexec/git-core",
    DEVELOPER_DIR: "/Library/Developer/CommandLineTools",
    npm_config_userconfig: join(plan.sandbox.tempRoot, "home", ".npmrc"),
    npm_config_cache: join(plan.sandbox.tempRoot, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  }
  return env
}

function fixedPath(plan: ResolvedCommandPlan): string {
  const nodeVersionRoot =
    plan.executable.displayName === "npm"
      ? dirname(dirname(dirname(dirname(dirname(plan.executable.realPath)))))
      : ""
  return [
    nodeVersionRoot ? join(nodeVersionRoot, "bin") : "",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    process.env.PATH?.split(":").find((entry) => entry.includes("/.nvm/")) ?? "",
  ]
    .filter(Boolean)
    .join(":")
}
