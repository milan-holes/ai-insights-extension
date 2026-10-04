# `aiStructureAnalyzer` - AI Structure Scanner

[src/core/aiStructureAnalyzer.ts](../../src/core/aiStructureAnalyzer.ts) · webview: [src/webview/aiStructureView.ts](../../src/webview/aiStructureView.ts)

Deep scan of the open workspace's AI-tooling configuration, shown in the **Repository** panel (`aiInsights.showAIStructure`, formerly labeled "AI Setup"). Unlike [repositoryHygiene.md](repositoryHygiene.md) (a compact per-workspace score card across every recent workspace, used on the dashboard), this scans only the current workspace root but goes much further: which providers it's set up for, per-file instruction scope, skills, custom agents, and MCP servers.

## Public API

| Export               | Signature                             | Purpose                          |
| --------------------- | -------------------------------------- | --------------------------------- |
| `analyzeAIStructure`  | `(rootPath) → Promise<AIStructureReport>` | Scan one workspace root           |

## `AIStructureReport`

| Field         | Type                  | Description                                                            |
| ------------- | --------------------- | ------------------------------------------------------------------------ |
| `providers`   | `DetectedProvider[]`  | One entry per known tool (`claudeCode`, `copilot`, `cursor`, `windsurf`, `cline`, `codex`, `antigravity`, `agentsMd`), with `detected` + the file/dir `signals` that triggered it |
| `instructions`| `InstructionFile[]`   | Every instruction file found, with scope + quality (see below)          |
| `skills`      | `SkillInfo[]`         | `.claude/skills/*/SKILL.md` and `.claude/commands/*.md`                 |
| `agents`      | `AgentInfo[]`         | `.claude/agents/*.md` and `.github/agents/*.agent.md`                   |
| `mcpServers`  | `MCPServerInfo[]`     | Servers found in `.mcp.json`, `.vscode/mcp.json`, `.claude/settings*.json` |

## Provider detection

A provider is `detected` if any of its owned instruction/agent files exist, or its config directory is non-empty (`.claude/`, `.cursor/`, `.windsurf/`, `.github/`). Detection also reads the **first heading** of every instruction file and matches other provider names against it — e.g. this repo's `.cursorrules` opens with `# AI Assistant Instructions - Antigravity / Cursor / Windsurf`, so it is attributed to `cursor`, `windsurf`, **and** `antigravity`, not just the file it physically is.

## Instruction scope

| Scope       | Meaning                                                                 | Sources                                                                 |
| ----------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `repo-wide` | Applies to every file in the repo                                       | `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.codex`, `AGENTS.md` (root), `GEMINI.md`, `.github/copilot-instructions.md` |
| `scoped`    | Applies only to a glob / subtree, taken from frontmatter or file location | `.github/instructions/*.instructions.md` (`applyTo` frontmatter), `.cursor/rules/*.mdc` (`globs` frontmatter), `.windsurf/rules/*.md` (`globs` frontmatter), nested `AGENTS.md` (scoped to its own directory subtree) |

Word count / quality bucketing (`stub` < 50w, `basic` < 200w, `good` < 500w, `rich` ≥ 500w) reuses the same thresholds as `repositoryHygiene.ts`.

## Frontmatter parsing

`parseFrontmatter()` is a minimal YAML-subset reader for `---\nkey: value\n---` blocks — handles single-line scalars, block sequences (`- item` per line), and flow sequences (`[...]`, including when the `[` starts on the line *after* the key, as in `.github/agents/*.agent.md`'s `tools:` field). It is not a general YAML parser; it only supports the shapes actually used by Claude Code / Copilot agent frontmatter.

## MCP servers

Reads `mcpServers` (Claude Code convention) or `servers` (VS Code `mcp.json` convention) from each candidate file. Only `command`/`args`/`url`/`type` and env var **key names** are surfaced — env var values are never read into the report.

## Webview

`AIStructureViewProvider` (panel id `aiInsights.aiStructure`, command `aiInsights.showAIStructure`, nav tab "Repository", second tab in the nav bar) re-scans on open and on the "↺ Re-scan" button. Clicking any file path (`.file-link` / `.sig-chip`) posts `{ command: 'openFile', relativePath }` back to the extension, which opens that file beside the panel via `vscode.workspace.openTextDocument`.
