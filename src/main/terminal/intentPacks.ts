import type {
  ActionGrammar,
  IntentPackDefinition,
  TerminalExecutableName,
  TerminalIntent,
  TerminalSandboxTier,
} from "../../shared/types.js"
import { QUALITY_SCRIPT_NAMES } from "./projectScript.js"

const SAFE_ACTION = (action: string, allowedFlags: string[] = []): ActionGrammar => ({
  argv: [action],
  slots: {},
  allowedFlags,
  pathArgsAfterDoubleDash: true,
})

const READ_EFFECTS = {
  workspace: "read" as const,
  projectCodeExecution: false,
  network: "none" as const,
  externalPaths: [],
}

const WRITE_EFFECTS = {
  workspace: "write" as const,
  projectCodeExecution: true,
  network: "none" as const,
  externalPaths: [],
}

export const INTENT_PACK_DEFINITIONS: readonly IntentPackDefinition[] = [
  {
    kind: "git.read",
    version: 1,
    executable: "git",
    actions: {
      status: {
        argv: ["--no-pager", "status"],
        slots: {},
        allowedFlags: ["--short", "--porcelain", "--branch", "--untracked-files=no"],
        pathArgsAfterDoubleDash: true,
      },
      diff: {
        argv: ["--no-pager", "diff"],
        slots: {},
        allowedFlags: [
          "--cached",
          "--staged",
          "--stat",
          "--name-only",
          "--name-status",
          "--no-color",
          "--minimal",
        ],
        pathArgsAfterDoubleDash: true,
      },
      log: {
        argv: ["--no-pager", "log"],
        slots: {},
        allowedFlags: [
          "--oneline",
          "--decorate",
          "--stat",
          "--no-color",
          "--first-parent",
          "-n",
          "--max-count",
        ],
        pathArgsAfterDoubleDash: true,
      },
    },
    sandboxTier: "read-only",
    effects: READ_EFFECTS,
    risk: "R1",
    preservesColor: false,
    enabled: true,
  },
  {
    kind: "project.script",
    version: 1,
    executable: "npm",
    packageManager: "auto",
    actions: {
      run: {
        argv: ["run", "${script}"],
        slots: {
          script: { type: "string", enum: [...QUALITY_SCRIPT_NAMES], maxLength: 32 },
        },
        allowedFlags: [],
        pathArgsAfterDoubleDash: false,
      },
    },
    sandboxTier: "workspace-write",
    effects: WRITE_EFFECTS,
    risk: "R3",
    limits: { timeoutMs: 30_000, outputBytes: 8 * 1024 * 1024, softOutputBytes: 128_000 },
    preservesColor: false,
    enabled: true,
  },
  {
    kind: "git.inspect",
    version: 1,
    executable: "git",
    actions: {
      show: {
        argv: ["--no-pager", "show"],
        slots: {},
        allowedFlags: ["--stat", "--name-only", "--name-status", "--no-color", "--format=short"],
        pathArgsAfterDoubleDash: true,
      },
      blame: {
        argv: ["--no-pager", "blame"],
        slots: {},
        allowedFlags: ["--line-porcelain", "--porcelain", "-L"],
        pathArgsAfterDoubleDash: true,
      },
      "stash list": {
        argv: ["--no-pager", "stash", "list"],
        slots: {},
        allowedFlags: ["--stat", "--oneline"],
        pathArgsAfterDoubleDash: false,
      },
    },
    sandboxTier: "read-only",
    effects: READ_EFFECTS,
    risk: "R1",
    preservesColor: false,
    enabled: true,
  },
  {
    kind: "runtime.info",
    version: 1,
    executable: "node",
    actions: {
      node: SAFE_ACTION("--version"),
      npm: SAFE_ACTION("--version"),
    },
    sandboxTier: "read-only",
    effects: READ_EFFECTS,
    risk: "R1",
    preservesColor: false,
    enabled: true,
  },
  {
    kind: "pkg.audit",
    version: 1,
    executable: "npm",
    packageManager: "auto",
    actions: {
      ls: SAFE_ACTION("ls"),
      outdated: SAFE_ACTION("outdated"),
    },
    sandboxTier: "read-only",
    effects: READ_EFFECTS,
    risk: "R1",
    preservesColor: false,
    enabled: true,
  },
] as const

const PACK_FLAGS: Record<string, string> = {
  "git.read": "PINGO_INTENT_PACK_GIT_READ_ENABLED",
  "project.script": "PINGO_INTENT_PACK_PROJECT_SCRIPT_ENABLED",
  "git.inspect": "PINGO_INTENT_PACK_GIT_INSPECT_ENABLED",
  "runtime.info": "PINGO_INTENT_PACK_RUNTIME_INFO_ENABLED",
  "pkg.audit": "PINGO_INTENT_PACK_PKG_AUDIT_ENABLED",
}

for (const definition of INTENT_PACK_DEFINITIONS) validateIntentPackDefinition(definition)

export function getIntentPackDefinition(kind: string): IntentPackDefinition | undefined {
  const definition = INTENT_PACK_DEFINITIONS.find((candidate) => candidate.kind === kind)
  if (!definition || !isIntentPackEnabled(definition)) return undefined
  return definition
}

export function getEnabledIntentPackDefinitions(): IntentPackDefinition[] {
  return INTENT_PACK_DEFINITIONS.filter(isIntentPackEnabled).map((definition) => definition)
}

export function isIntentPackEnabled(definition: IntentPackDefinition): boolean {
  if (!definition.enabled || process.env.PINGO_TERMINAL_V2_ENABLED === "0") return false
  if (definition.kind === "project.script" && process.env.PINGO_PROJECT_SCRIPTS_ENABLED === "0") {
    return false
  }
  const flag = PACK_FLAGS[definition.kind]
  return !flag || process.env[flag] !== "0"
}

export function validateIntentPackDefinition(definition: IntentPackDefinition): void {
  if (!definition.kind || definition.version !== 1) throw new Error("Intent pack metadata invalid")
  if (!isAllowedExecutableName(definition.executable)) {
    throw new Error("Intent pack executable is not allowed")
  }
  if (!isAllowedSandboxTier(definition.sandboxTier)) {
    throw new Error("Intent pack sandbox tier is not allowed")
  }
  if (
    (definition.effects.workspace === "read" && definition.sandboxTier !== "read-only") ||
    (definition.effects.workspace === "write" && definition.sandboxTier === "read-only") ||
    definition.effects.network !== "none" ||
    definition.effects.externalPaths.length > 0
  ) {
    throw new Error("Intent pack effects do not match the sandbox contract")
  }
  if (Object.keys(definition.actions).length === 0) throw new Error("Intent pack has no actions")
  for (const [action, grammar] of Object.entries(definition.actions)) {
    if (!action || grammar.argv.length === 0) throw new Error("Intent pack action is empty")
    for (const argument of grammar.argv) {
      if (argument.startsWith("/") || argument.split("/").includes("..")) {
        throw new Error("Intent pack argv contains a path escape")
      }
      const withoutDeclaredSlots = argument.replace(/\$\{[A-Za-z][A-Za-z0-9_]*\}/g, "")
      if (/[;&|<>$`()\n\r]/.test(withoutDeclaredSlots)) {
        throw new Error("Intent pack argv contains shell syntax")
      }
      for (const slot of argument.matchAll(/\$\{([^}]+)\}/g)) {
        const slotName = slot[1]
        if (!slotName || !grammar.slots[slotName]) {
          throw new Error("Intent pack references an undeclared slot")
        }
      }
    }
    for (const flag of grammar.allowedFlags) {
      if (!flag.startsWith("-") || /[;&|<>$`()\n\r]/.test(flag)) {
        throw new Error("Intent pack allowed flag is invalid")
      }
    }
  }
}

export function buildTerminalIntentSchema(): Record<string, unknown> {
  const definitions = getEnabledIntentPackDefinitions()
  const actions = [...new Set(definitions.flatMap((definition) => Object.keys(definition.actions)))]
  const packageManagers = definitions.some((definition) => definition.packageManager)
    ? ["npm", "auto"]
    : []
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: definitions.map((definition) => definition.kind) },
      action: { type: "string", enum: actions },
      args: { type: "array", items: { type: "string" } },
      packageManager: { type: "string", enum: packageManagers },
      script: { type: "string", enum: [...QUALITY_SCRIPT_NAMES] },
      forwardedArgs: { type: "array", items: { type: "string" } },
      cwd: { type: "string", description: "workspace 内相对工作目录" },
    },
    required: ["kind", "cwd"],
    additionalProperties: false,
  }
}

export function intentKind(value: unknown): value is TerminalIntent["kind"] {
  return (
    typeof value === "string" &&
    INTENT_PACK_DEFINITIONS.some((definition) => definition.kind === value)
  )
}

function isAllowedExecutableName(value: string): value is TerminalExecutableName {
  return ["git", "npm", "node", "pnpm", "yarn", "bun"].includes(value)
}

function isAllowedSandboxTier(value: string): value is TerminalSandboxTier {
  return ["read-only", "workspace-write", "network-allowlist"].includes(value)
}
