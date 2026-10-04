# Sessions List Webview

| Item     | Value                                                            |
| -------- | ---------------------------------------------------------------- |
| File     | [src/webview/sessionsList.ts](../../src/webview/sessionsList.ts) |
| Class    | `SessionsListProvider`                                           |
| Panel ID | `aiInsights.sessionsList`                                        |
| Command  | `aiInsights.showSessions`                                        |

## Purpose

Shows a pageable, filterable table of every individual `Session` record in `allSessions`, giving users a per-session breakdown rather than the aggregated totals on the dashboard.

## Columns

| Column       | Notes                                                       |
| ------------ | ----------------------------------------------------------- |
| Date         | Formatted relative (Today / Yesterday / Mon 12 …) with time |
| Provider     | Colour-coded badge (Copilot / Antigravity / Claude Code)    |
| Workspace    | Basename of the workspace path; full path in tooltip        |
| Tokens       | Total tokens (compact K/M)                                  |
| Input        | Input tokens                                                |
| Output       | Output tokens                                               |
| Interactions | Number of interactions in the session                       |
| Models       | Each unique model as a small tag                            |
| Duration     | Derived from `endTime − startTime`                          |

Sortable columns: **Date**, **Tokens**, **Interactions** (click header to toggle asc/desc).

## Filters

| Control             | Values                                                  |
| ------------------- | ------------------------------------------------------- |
| Provider dropdown   | All · GitHub Copilot · Antigravity · Claude Code        |
| Date range dropdown | All Time · Today · Last 7 Days · Last 30 Days           |
| Free-text search    | Matches workspace path or model name (case-insensitive) |

Filtering and sorting are performed entirely client-side in-browser via `ALL_SESSIONS`.

## Navigation

- **← Dashboard** button sends `showDashboard` message → `aiInsights.showDashboard` command.
- Dashboard nav has a **📋 Sessions** button that posts `showSessions` to open this panel.

## Data flow

```
extension.ts: allSessions[]
    └─► SessionsListProvider.createPanel(context, allSessions)
            └─► getHtml(sessions)
                    ├─ serialises to safeJson (JSON with </script> escaped)
                    ├─ injects: <script>window.__INITIAL_SESSIONS__ = safeJson;</script>
                    └─ main script reads window.__INITIAL_SESSIONS__ into ALL_SESSIONS
```

Sessions are pre-sorted newest-first before serialisation. `Date` objects are explicitly converted to ISO strings before serialisation to avoid `[object Object]` round-trip bugs.

## Debug banner

A blue diagnostic banner above the table shows `N sessions loaded - provider: count · ...`. Helps diagnose empty-table issues without needing developer tools.

## Known bugs fixed (2026-05-01)

| Bug                                  | Root cause                                                                                                                                                                                     | Fix                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Sessions screen always empty         | `showSessions()` only called `refresh()` when `allSessions.length === 0`; sessions created between auto-refresh ticks were missed                                                              | Always `await refresh()` before calling `createPanel`                    |
| Data not reaching webview            | `Buffer.from(sessionsJson).toString('base64')` inside a template literal was compiled to a single-quoted string by esbuild, so the `${...}` never evaluated; webview received the literal text | Switched to `window.__INITIAL_SESSIONS__ = ${safeJson}` inline injection |
| Provider filter confusing when empty | No explanation when filtered provider has 0 sessions                                                                                                                                           | Provider-specific empty-state message directing user to "All Providers"  |
