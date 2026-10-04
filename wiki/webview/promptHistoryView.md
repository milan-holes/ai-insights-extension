# PromptHistoryView

Source: [src/webview/promptHistoryView.ts](../../src/webview/promptHistoryView.ts)

Command: `aiInsights.showPromptHistory` — _AI Insights: Show Prompt-Level Cost History_

## Purpose

Webview panel that shows per-prompt cost, token usage, duration, and model across the last 10–50 AI interactions. Eliminates the need to manually diff accumulated counters.

## Layout

| Section | Content |
|---|---|
| Summary cards | Prompts today, avg cost/prompt, avg tokens (in/out), top model |
| Sparkline | Line chart — cost per prompt across last 50 (oldest → newest) |
| Filter bar | Provider selector, limit selector (10 / 25 / 50) |
| Table | Time, Provider badge, Model tag, Mode badge, Token bar, Cost, Duration, Workspace |

## Data flow

1. `PromptHistoryStore.update(sessions)` builds `PromptRecord[]` on every refresh.
2. `showPromptHistory()` in `extension.ts` calls `PromptHistoryViewProvider.createPanel(context, store.getAll())`.
3. All 50 most-recent records are serialized into `window.__RECORDS__` at build time; client-side JS filters and renders.

## Token bar colors

| Color | Meaning |
|---|---|
| `#007AFF` | Input tokens |
| `#39FF14` | Output tokens |
| `#FF9F0A` | Cache-read tokens |

## Messages handled

| Command | Action |
|---|---|
| `refresh` | Re-executes `aiInsights.showPromptHistory` |
| `showDashboard` | Opens dashboard panel |
| `showSessions` | Opens sessions list panel |
