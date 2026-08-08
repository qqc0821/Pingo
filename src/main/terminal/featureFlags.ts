export interface TerminalFeatureFlags {
  terminalV2Enabled: boolean
  terminalSandboxRequired: true
  projectScriptsEnabled: boolean
}

export function getTerminalFeatureFlags(): TerminalFeatureFlags {
  const terminalV2Enabled = process.env.PINGO_TERMINAL_V2_ENABLED !== "0"
  return {
    terminalV2Enabled,
    terminalSandboxRequired: true,
    projectScriptsEnabled: terminalV2Enabled && process.env.PINGO_PROJECT_SCRIPTS_ENABLED !== "0",
  }
}
