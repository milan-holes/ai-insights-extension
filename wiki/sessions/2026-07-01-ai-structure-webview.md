# Session: AI Structure webview - 2026-07-01

## What was done

- Added a new "AI Setup" panel (`aiInsights.showAIStructure` command, nav tab) that analyzes the currently open workspace's AI-tooling configuration: which providers it's prepared for, every instruction file with its scope and quality, installed skills/slash commands, custom agents, and configured MCP servers.
- New scanning engine `src/core/aiStructureAnalyzer.ts`, separate from the existing `repositoryHygiene.ts` (which produces a compact 0–100 score card across *every* recently used workspace for the dashboard's Workspace Health tab). The new analyzer goes deep on a single workspace instead of wide across many.
- Registered the command in `extension.ts` and `package.json`, and wired the nav tab / `NAV_COMMANDS` entry in `navShared.ts`.
- Verified the analyzer against this repo itself (ground-truthed by manually inspecting `CLAUDE.md`, `.cursorrules`, `.codex`, `.github/copilot-instructions.md`, `.github/agents/feature-builder.agent.md`, `.claude/skills/update-model-pricing/SKILL.md` beforehand) and verified the exact client-side webview JS (extracted from the template string, template tokens substituted, executed against a stubbed DOM) renders the expected tables without runtime errors. A full Electron GUI screenshot wasn't possible in this headless container — the Extension Development Host would open on the user's actual VS Code client via the remote-cli, not in a capturable local display.

## Files changed

- [src/core/aiStructureAnalyzer.ts](../../src/core/aiStructureAnalyzer.ts) - new. `analyzeAIStructure(rootPath)` returns provider detection, instruction files (repo-wide vs. path/glob-scoped), skills, agents, and MCP servers. Includes a minimal YAML-subset frontmatter parser (`parseFrontmatter`) for `SKILL.md` / `*.agent.md` files.
- [src/webview/aiStructureView.ts](../../src/webview/aiStructureView.ts) - new. `AIStructureViewProvider` panel; re-scans on open and on "↺ Re-scan"; clicking a file path opens it beside the panel via a new `openFile` postMessage command.
- [src/extension.ts](../../src/extension.ts) - imported `AIStructureViewProvider`, registered `aiInsights.showAIStructure`.
- [src/webview/navShared.ts](../../src/webview/navShared.ts) - added `aiStructure` to `NavTab`, a visible "AI Setup" tab, and the `NAV_COMMANDS` entry.
- [package.json](../../package.json) - added the `aiInsights.showAIStructure` command contribution.
- [CHANGELOG.md](../../CHANGELOG.md) - new entry under `[Unreleased]`.
- [wiki/core/aiStructureAnalyzer.md](../core/aiStructureAnalyzer.md) - new wiki page.

## Decisions made

- Kept this as a **separate module** from `repositoryHygiene.ts` rather than extending it — hygiene reports intentionally stay lightweight (boolean file-exists checks) because they run for every recently-used workspace on every dashboard load; this analyzer does much richer parsing (frontmatter, glob scope, MCP server details) but only ever runs once, on-demand, for the single open workspace.
- Provider detection also scans the **first heading** of each instruction file for other providers' names, not just the owning file's own path — this repo's `.cursorrules` opens with "AI Assistant Instructions - Antigravity / Cursor / Windsurf", so it's correctly attributed to all three tools instead of just Cursor (the file extension's nominal owner).
- MCP server entries surface env var **key names only**, never values, since these are frequently API tokens/secrets.
- Made the tab visible in the nav bar (unlike the existing Repo Graph/Agent Handoff tab, which stays command-palette-only) since this feature needs no API key or heavy computation to be useful.

## Follow-up / known gaps

- Scoped-instruction detection covers the well-known conventions (`.github/instructions/*.instructions.md`, `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, nested `AGENTS.md`) but not every tool's custom-instructions format (e.g. JetBrains AI `.aiassistant/rules/`) — `src/providers/jetbrainsAI.ts` and `visualStudio.ts` track *usage*, not repo config, and were intentionally left out of the provider list since those tools don't have their own repo-scoped instruction file convention distinct from Copilot's.
- No export/handoff document generation yet (unlike Repo Graph's "Export handoff.md") — could be added if useful for onboarding a new AI tool to an existing repo's conventions.
