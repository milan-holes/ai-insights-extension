# Sessions View Webview (v2)

| Item     | Value                                                            |
| -------- | ---------------------------------------------------------------- |
| File     | [src/webview/sessionsView.ts](../../src/webview/sessionsView.ts) |
| Class    | `SessionsViewProvider`                                           |
| Panel ID | `aiInsights.sessionsView`                                        |
| Command  | `aiInsights.showSessionsView`                                    |

## Purpose

Replacement sessions panel that uses VS Code's `postMessage` API instead of template-literal data injection. The webview loads a fully static skeleton HTML and receives session data as a live message from the extension - avoiding all esbuild compilation issues that affected the v1 panel.

## Data flow

```
Extension                              Webview
─────────────────────────────────────────────────────────
createPanel(context, getSessions)
  │  renders static skeleton HTML
  │  registers onDidReceiveMessage handler
  │                                  ← sends {command:'ready'}
  ↓
getSessions()
  └─► refresh() → allSessions
panel.webview.postMessage(
  {command:'sessions', data:[...]})  → renders table
```

Refresh button sends `{command:'refresh'}` → same flow repeats.

## Columns

Same as v1 Sessions panel: Date · Provider · Workspace · Tokens · Breakdown (stacked bar) · Interactions · Models · Duration.

## Filters

Provider · Date range (30d default) · Free-text search (workspace / model). All client-side.

## Info bar

Blue bar below filters shows "Loaded N sessions - claudeCode: X · copilot: Y" after data arrives. Shows warning/error styling on failure.

## Repository/workspace naming (`repoName(s)`)

`s.workspace` is a resolved directory path for most providers, but Antigravity falls back to a raw conversation-id substring (e.g. `48dc5ecf`) when it can't resolve a real workspace path from brain data (see [providers/antigravity.md](../providers/antigravity.md)). `repoName(s)` is the single place that turns `workspace` into a display name; it collapses any bare 6-10 char hex id (optionally with a trailing `...`) to `"Unknown"` so unresolvable Antigravity sessions don't show up as one-off fake "repositories" in the Workspace breakdown chart, the repo-activity view, or the Workspaces stat count. Used by `updateStats`, `updateCharts` (workspace breakdown donut), and `renderRepositoryActivity`.

## Navigation

- **Refresh** button triggers re-fetch and re-render
- **← Dashboard** button opens `aiInsights.showDashboard`
- Dashboard nav has **Sessions v2** button that opens this panel
