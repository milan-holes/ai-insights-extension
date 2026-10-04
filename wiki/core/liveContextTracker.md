# LiveContextTracker

[src/core/liveContextTracker.ts](../../src/core/liveContextTracker.ts)

Watches `~/.claude/projects/**/*.jsonl` for writes and emits real-time context health info within ~1.5 s of each Claude Code turn completing. Drives the **live mode** of the VS Code status bar.

## How it works

| Step | Detail |
|------|--------|
| Watch | `vscode.workspace.createFileSystemWatcher` on `~/.claude/projects/**/*.jsonl` (both `onDidCreate` and `onDidChange`) |
| Debounce | 1.5 s per file path — prevents a burst of events from one multi-line JSONL append triggering multiple parses |
| Parse | Full `ClaudeCodeProvider.parseSessionFile()` call on the changed file |
| Liveness check | Last real interaction timestamp must be < 3 min old; stale files are silently ignored |
| Expiry | `setTimeout(3 min)` fires `onUpdate(null)` after inactivity → status bar reverts to aggregate mode |

## `LiveContextInfo` shape

| Field | Type | Meaning |
|-------|------|---------|
| `sessionTitle` | `string \| undefined` | `ai-title` entry from the JSONL if present |
| `lastInputTokens` | `number` | `effectiveContextTokens` of the most recent turn (`input + cacheRead + cacheWrite`) — the real context window usage |
| `contextLimitTokens` | `number` | Resolved per session via [[contextWindow]] — the model's own window, or `aiInsights.context.limitTokens` when set |
| `contextLimitSource` | `'override' \| 'model' \| 'default'` | Where the limit came from; the status-bar tooltip appends `(setting)` or `(default - model unknown)` so a wrong denominator is visible |
| `contextPct` | `number` | `lastInputTokens / contextLimitTokens × 100`, clamped to 100 |
| `healthLabel` | `'healthy' \| 'warning' \| 'stale'` | From `computeContextRotScore()` |
| `healthScore` | `number` | 0–10 rot score |
| `turnsCount` | `number` | Number of non-compaction interactions |
| `totalSessionTokens` | `number` | Cumulative total across the session |
| `cacheEfficiencyPct` | `number` | `cacheReadTokens / totalInputTokens × 100` |

## Integration with extension.ts

`LiveContextTracker` fires a callback into `extension.ts` which sets the module-level `liveContextInfo` variable. `updateStatusBar()` reads this variable each time it runs:

- **Live mode** (info present): `$(pulse) ctx: 45K (22%) $(check) · 1.2M today` + rich tooltip with mini progress bar
- **Aggregate mode** (info null): existing `$(pulse) 1.2M today | 12.3M month | ~2.3h saved` text

## Limitations

- Claude Code only — Copilot/Codex don't expose per-turn context size via log files.
- File system watcher coverage outside the workspace depends on VS Code's watcher service; degrades gracefully (no crash, status bar stays in aggregate mode).
- The 1M window on Claude Sonnet / Opus is a gated opt-in that the session logs do not record, so it cannot be auto-detected; users on it set `aiInsights.context.limitTokens`. See [[contextWindow]].

## Related

- [[liveSessionMonitor]] — detects live sessions for the sessions panel (30 s polling, not file watching)
- [[contextRot]] — provides `computeContextRotScore()` consumed here
- [[contextWindow]] — resolves `contextLimitTokens`
