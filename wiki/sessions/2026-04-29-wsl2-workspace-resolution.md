# Session: WSL2 workspace path resolution - 2026-04-29

## What was done

- Fixed `decodeClaudeProjectPath` to use greedy filesystem traversal instead of naive `-`→`/` replacement, so directory names containing dashes (e.g. `ai-insights`, `signal-app`, `english-tutor`) now resolve correctly
- Fixed `AntigravityProvider` to parse the `Active Document:` field from `overview.txt` (first `USER_INPUT` entry) and walk up to the nearest git/package root - UUID workspace fragments replaced with real paths
- Fixed `CopilotProvider` to detect WSL2 (`/proc/version` contains "microsoft") and scan Windows-side AppData (`/mnt/c/Users/{user}/AppData/Roaming/{variant}/User/workspaceStorage`) in addition to Linux paths
- Fixed `CopilotProvider.extractWorkspace` to read `workspace.json` from each hash directory and decode `file:///` and `vscode-remote://wsl…` URIs into plain Linux paths
- Fixed `buildHygieneReports` to: (1) accept absolute path workspace keys directly, (2) derive `displayName` from the resolved path basename rather than the last dash-segment, (3) deduplicate by resolved path to merge sessions across providers pointing to the same repo

## Files changed

- [`src/core/repositoryHygiene.ts`](../../src/core/repositoryHygiene.ts) - greedy `decodeClaudeProjectPath`, reworked `buildHygieneReports` resolution chain
- [`src/providers/antigravity.ts`](../../src/providers/antigravity.ts) - `extractWorkspaceFromOverview` parses overview.txt for Active Document path
- [`src/providers/copilot.ts`](../../src/providers/copilot.ts) - WSL2 Windows path discovery, `workspace.json` reading, `resolveVSCodeUri` for `vscode-remote://` URIs

## Decisions made

- Greedy shortest-first matching (try 1 segment, then 2, …) is correct for path reconstruction: it greedily finds the shallowest directory that exists before trying longer names, which matches how real paths are structured
- Antigravity sessions use the first `USER_INPUT` entry's `Active Document` because that is always the session's working context; the walk-up-to-git-root heuristic prevents using a deep file path as the workspace name
- WSL2 Windows user discovery uses `/mnt/c/Users` and skips system accounts (Public, Default, etc.); picks up all human user profiles without requiring configuration

## Follow-up / known gaps

- If a project directory has been deleted, it correctly shows "path unknown" - no fix needed
- `bg-removal` correctly resolves to `/home/twd/dev/tools/bg-removal` (it lives inside a `tools/` parent) - greedy algorithm handles this naturally
- Copilot `workspace.json` URI `vscode-vfs://github/...` (GitHub Codespaces) is left as-is (no Linux path to resolve)
