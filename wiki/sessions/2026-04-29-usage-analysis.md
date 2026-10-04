# Session: Usage Analysis & Repository Hygiene - 2026-04-29

## What was done

- Added `modeBreakdown` field to `ProviderMetrics` tracking interaction counts by normalized mode (ask/edit/agent/plan/customAgent/cli)
- Added `FileStatus` and `RepositoryHygieneReport` types for repository config scanning
- Created `src/core/repositoryHygiene.ts` - scans repos for AI config files and builds hygiene reports
- Created `src/webview/usageAnalysis.ts` - 4-tab usage analysis panel (My Activity / Tools & Integrations / Workspace Health / Repository PRs)
- Registered `aiInsights.showUsageAnalysis` command in extension.ts and package.json

## Files changed

- [`src/types.ts`](../../src/types.ts) - added `modeBreakdown` to `ProviderMetrics`, new `FileStatus` and `RepositoryHygieneReport` interfaces
- [`src/core/sessionAggregator.ts`](../../src/core/sessionAggregator.ts) - `normalizeMode()` helper + `modeBreakdown` in `buildMetrics()`
- [`src/core/repositoryHygiene.ts`](../../src/core/repositoryHygiene.ts) - new module: `scanRepository()`, `decodeClaudeProjectPath()`, `buildHygieneReports()`
- [`src/webview/usageAnalysis.ts`](../../src/webview/usageAnalysis.ts) - new webview: `UsageAnalysisProvider.createPanel()`
- [`src/extension.ts`](../../src/extension.ts) - imports + `showUsageAnalysis()` function + command registration
- [`package.json`](../../package.json) - `aiInsights.showUsageAnalysis` command + editor/title menu entry

## Decisions made

- Mode normalization is provider-aware: all Claude Code interactions → `cli`, all Antigravity → `ask`, Copilot uses the `mode` field from session files
- Repository path discovery tries three strategies in order: VS Code workspace folders (authoritative), Claude Code encoded-path decode, common `~/dev/` and `~/projects/` prefixes
- Claude Code path decode is best-effort - only works for project paths without dashes in directory names (limitation acknowledged)
- Hygiene score: each of 5 config categories contributes 0 (missing), 10 (stale), or 20 (fresh) points → max 100
- MCP tools identified by `mcp_` or `mcp__` prefix; grouped by server name in Tools & Integrations tab
- Known auto-approved tools (Read, Bash, Grep, LS, Glob, Cat) receive an `auto` badge in the tool usage table

## Follow-up / known gaps

- Repository PRs tab is a placeholder - not implemented
- Context References section (from Copilot screenshots) not yet implemented - would require parsing `#file`, `#selection`, etc. patterns from prompt text
- Claude Code project path decode fails for any directory name containing a dash
- Copilot workspace hashes are not decoded - those workspaces appear as "Unknown" and are skipped in hygiene reports
