# Developer Guide — Session Management & Analytics

This guide explains how `/clear` and `/compact` affect AI Insights analytics, and what developers should do to keep their usage data intact.

---

## TL;DR

| Tool | Provider | Data safe? | Recommendation |
|---|---|---|---|
| `/clear` | **Claude Code** | ✅ Yes | Use freely |
| `/compact` | **Claude Code** | ✅ Yes | Use freely |
| `/clear` | **GitHub Copilot** | ✅ Yes (as of v0.1.8+) | Use freely — snapshots protect you |
| New chat | **GitHub Copilot** | ✅ Yes | Also fine |

---

## How each provider stores data

### Claude Code

Claude Code writes every turn to an **append-only JSONL file** at:

```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

`/clear` resets the in-memory context but **never deletes or truncates the file**. `/compact` appends a summary entry and continues. The extension reads from disk on every refresh, so all historical data is always available.

### GitHub Copilot

Copilot stores each chat as a **mutable JSON or delta-JSONL file** in VS Code's workspace/global storage. Clearing a Copilot chat typically deletes or overwrites that file. Starting a new chat creates a new file.

**Before v0.1.8** of AI Insights, clearing a Copilot session between refresh cycles meant that session was lost from analytics.

**From v0.1.8 onwards**, every parsed Copilot session is automatically snapshotted to extension storage (`SessionSnapshotStore`). Snapshots survive file deletion, VS Code restarts, and workspace switches. The extension merges live files with persisted snapshots on every refresh.

---

## What the snapshot store covers

- **Cleared chats**: session data is preserved up to the last refresh before clearing (default refresh = every 5 min).
- **Data freshness**: if you clear a session and immediately check the dashboard, the snapshot from the previous refresh cycle is shown — not real-time. This is expected.
- **Maximum gap**: at most one refresh interval (5 min by default) of interactions can be lost if a session is cleared between two refreshes.
- **Retention**: snapshots follow the same `sessionLookbackDays` window as live files (default: 400 days).

---

## Recommendations for developers

1. **Use `/compact` freely in Claude Code** — it helps the model stay focused without losing any analytics data.
2. **Use `/clear` freely in Claude Code** — safe at all times.
3. **For Copilot**: clearing is now safe from an analytics perspective. If you need 100% precision for a session that's actively accumulating tokens, wait for the next auto-refresh (or run `AI Insights: Refresh` manually) before clearing.
4. **To force a snapshot before clearing Copilot**: run the `AI Insights: Refresh` command (`Ctrl+Shift+P` → `AI Insights: Refresh`) — this immediately parses and persists all live sessions.

---

## Adjusting the refresh interval

The refresh interval controls how often live sessions are snapshotted. Default is 5 minutes. To change it:

```json
// settings.json
"aiInsights.refreshIntervalMinutes": 1
```

A shorter interval reduces the maximum data-loss window for Copilot clears.
