# `repositoryHygiene` - Repository Config Scanner

[src/core/repositoryHygiene.ts](../../src/core/repositoryHygiene.ts)

Scans workspace directories for AI-tool configuration files and produces a scored hygiene report shown in the Workspace Health tab of the Usage Analysis panel.

## Public API

| Export                    | Signature                                                                          | Purpose                                                         |
| ------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `scanRepository`          | `(repoPath, name, sessions, interactions, lastActivity) → RepositoryHygieneReport` | Scan one directory                                              |
| `decodeClaudeProjectPath` | `(encodedName) → string \| null`                                                   | Decode a Claude Code project directory name to an absolute path |
| `buildHygieneReports`     | `(sessions, vscodeWorkspaceFolders) → RepositoryHygieneReport[]`                   | Build reports for all last-30d workspaces                       |

## Hygiene Score

Each of 5 config categories contributes to a 0–100 score:

| Points | Condition                                       |
| ------ | ----------------------------------------------- |
| 20     | File/dir exists **and** modified within 30 days |
| 10     | File/dir exists but older than 30 days (stale)  |
| 0      | Missing                                         |

## Config Categories

| Category          | Checks                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **Instructions**  | `CLAUDE.md`, `claude.md`, `.github/copilot-instructions.md`, `.cursorrules`, `.clinerules` |
| **Agent Setup**   | `.claude/settings.json`, `.claude/settings.local.json`                                     |
| **MCP Config**    | `.mcp.json` _or_ `mcpServers` key present in `.claude/settings.json`                       |
| **Skill Files**   | `.claude/commands/` directory (non-empty)                                                  |
| **Custom Agents** | `AGENTS.md` _or_ `.claude/agents/` directory (non-empty)                                   |

## Instruction Content Quality

`scanRepository` also reads and analyses every found instruction file (`CLAUDE.md`, `copilot-instructions.md`, `.cursorrules`, `.clinerules`, `AGENTS.md`) and returns an `InstructionQuality[]` array with per-file metrics:

| Field        | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `file`       | Display label (e.g. `CLAUDE.md`, `AGENTS.md`)                  |
| `wordCount`  | Total word count                                               |
| `hasSections`| `true` if the file contains `##`/`###` Markdown headers        |
| `quality`    | `stub` (<50w) · `basic` (50–199w) · `good` (200–499w) · `rich` (≥500w) |

Shown in the **📝 Instruction Content Quality** section of the Workspace Health tab.

## Path Resolution Order

`buildHygieneReports` tries three strategies to map an encoded workspace name to a real path:

1. **VS Code workspace folders** - matched by basename or display name (case-insensitive)
2. **Claude Code path decode** - encoded name like `-home-user-dev-foo` → `/home/user/dev/foo` (only works when no directory in the path contains a dash)
3. **Common prefixes** - tries `~/dev/<name>`, `~/projects/<name>`, `~/<name>`

If no path is resolved, the report is still shown but with `repoPath: null` and all file statuses as missing.
