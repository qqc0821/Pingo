# Pingo

[中文](./README.zh-CN.md) | **English**

Pingo is a macOS-only Electron desktop companion: an AI pet with its own personality that lives on your screen edge, chats with you, and helps with day-to-day tasks. It reads and edits files inside your chosen project directory under a strict approval model, so it feels helpful without acting like an open terminal.

> MVP status: the app is a working early version. Chat context lives in memory only and starts fresh on every launch.

## Features

- **Living pet** — idle video animation plus happy/thinking/gentle states, draggable on screen, tray support.
- **Project assistant** — structured file tools (`list_files`, `search_files`, `read_file`, `write_file`, `apply_patch`, move/trash) scoped to the directory you authorize.
- **Approval-first security** — every write and terminal command is planned in the main process, risk-classified (R0–R4), and confirmed one at a time with an operation preview. Nothing runs silently.
- **Trusted Workspace** — optionally mark one directory as trusted so its structured file operations skip repeated confirmation across restarts (terminal commands still confirm).
- **Intent whitelist terminal** — only structured `executable + args` intents (read-only git, project quality scripts) can run; `shell: false`, sandboxed on macOS via Seatbelt, no shell/interpreters/sudo/network.
- **Audit & undo** — every operation is logged to a redacted JSONL audit trail (0600); destructive file changes can be recovered from a trash-style undo.
- **Terminal run history** — browse past runs, re-run, and diff outputs.
- **Configurable model** — DeepSeek by default; any Chat Completions-compatible endpoint and model name can be set in the settings page.

## Architecture

- Electron + React + TypeScript (electron-vite), SCSS for styling.
- Renderer stays `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; it only receives task state, approval cards, and operation previews through the preload whitelist.
- Authorization, risk classification, approval tokens, path re-validation, and real execution all live in the main process.
- The pet window is a transparent, frameless always-on-top window; a tray menu controls quit and visibility.

## Requirements

- macOS (arm64; packaging targets macOS arm64)
- Node.js 20+

## Getting Started (development)

```bash
npm install
cp .env.example .env
# Fill in MODEL_API_KEY in .env
npm run dev
```

Default model is `deepseek-chat`; base URL and model name can be changed in the settings page (any Chat Completions-compatible endpoint works).

### Packaged app keys

When launched from Finder, the packaged app reads keys from the macOS user configuration directory:

```bash
mkdir -p "$HOME/Library/Application Support/pingo"
cp .env.example "$HOME/Library/Application Support/pingo/.env"
# Edit "$HOME/Library/Application Support/pingo/.env" and set MODEL_API_KEY
chmod 600 "$HOME/Library/Application Support/pingo/.env"
```

## Validation & Packaging

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run pack:mac
```

Artifacts are written to `dist/`. The app is unsigned for now — macOS will ask to allow it on first launch; configure Developer ID signing and notarization before public distribution.

### Standalone directory test

Checks a single directory without running other tests or executing terminal commands:

```bash
PINGO_INSPECT_DIRECTORY="$HOME/Documents" npm run test:directory

# Optional: assert that a relative file exists inside the directory
PINGO_INSPECT_DIRECTORY="$HOME/Documents" \
PINGO_INSPECT_EXPECT="notes/today.txt" \
npm run test:directory
```

### AI terminal end-to-end test

Sends your raw question to the real model and lets it decide whether to call a read-only terminal intent; only the capability/confirmation flow is automated. The authorized directory defaults to the current working directory:

```bash
npm run test:ai-terminal -- --prompt "List the files under src in the current project"
```

If the question does not need the terminal, allow the test to just verify the final answer:

```bash
npm run test:ai-terminal -- --allow-no-terminal --prompt "Briefly introduce this project"
```

See [ai-terminal-directory.ts](scripts/ai-terminal-directory.ts) for the test cases.

## Mini Agent (CLI loop)

`scripts/mini-agent.ts` is a standalone agent that verifies "can the model call tools and answer from real files" without any UI. It exposes `list_files`, `read_file`, and `run_command`, and needs `MODEL_API_KEY` in `.env`:

```bash
npm run agent -- "What does the dev script in package.json do?"
npm run agent -- --debug "What git branch is this project on?"
```

It does **no permission enforcement**: commands run directly, paths are not restricted to the project, and hidden files are visible. Only context-blowup guards remain (20K chars per file read, 200 entries per listing, 60s command timeout, 6 tool-loop max). Since `.env` is visible to it, the model may send `MODEL_API_KEY` to the model service — add `.env` to `NOISY_DIRECTORIES` in the script if you mind.

## Security Model

- Structured file tools accept only relative paths inside the authorized directory; `..`, absolute paths, backslashes, symlink escapes, `.env`, secret files, sensitive directories, binaries, and oversized files are rejected by default.
- Standard mode requires per-action "allow once" confirmation for writes, patches, moves, trash, and all terminal commands; Trusted Workspace skips repeated confirmation for structured file operations only, while keeping atomic replacement, path/file state re-validation, auditing, and recoverable trash.
- Terminal accepts only structured `executable + args + cwd` intents, forcing `shell: false`, a minimal environment, timeouts, output caps, and cancellation; shell, interpreters, sudo, installs, network clients, and permanent deletes are always blocked.
- Operation history is stored in a `0600` redacted JSONL file under the app data directory; API keys, full prompts, file contents, and unredacted output are never persisted.
- Capability grants never survive an app restart; a Trusted Workspace persists only the directory choice, not any command or file grant.

## Docs

Detailed plans live under `docs/` (Chinese):

- [Architecture alignment & feature priorities](docs/ARCHITECTURE_ALIGNMENT.md)
- [Controlled file & terminal capability plan](docs/TERMINAL_CAPABILITY_PLAN.md)
- [Git management rules](docs/GIT_MANAGEMENT.md)

## License

MIT
