# claudeAccountView — Claude Panel

[src/webview/claudeAccountView.ts](../../src/webview/claudeAccountView.ts)

## Purpose

Shows plan info, usage-limit windows (real live quota when available, local estimate otherwise), local Claude Code usage statistics, token breakdown, and per-model breakdown for the connected account.

> **2026-08-25 correction**: this doc previously described a password-input "connect your Anthropic API key" flow with `pushRateLimitInfo()`/`GET /v1/models` rate-limit cards. That UI (`connectedApiSection`/`disconnectedApiSection`/`collapsedApiSection`) was already dead code with no caller (flagged in `docs/dead-code-audit.md`) and has now been removed. See [claudeQuota.md](../core/claudeQuota.md) for the real replacement: zero-config live plan-quota via the OAuth token Claude Code already has on disk, no API key entry required.

## Command

`aiInsights.showClaudeAccount` — opens or reveals the panel.

## Usage Limits section

Two cards (5h session window, 7d weekly window), sourced from whichever of these is available - **live is preferred over estimate**:

| Source | When shown | Badge |
|--------|------------|-------|
| [claudeQuota.ts](../core/claudeQuota.md) real plan-quota % | `claudeQuota` snapshot available (credentials file present, setting on, fetch succeeded) | `live · Anthropic API` |
| `calcWindow()` local session-log estimate (this file) | No live snapshot | `session files` |

`calcWindow(sessions, windowMs)` sums `totalTokens`/`outputTokens`/interaction counts for `claudeCode` sessions inside a rolling window and derives a reset estimate from the oldest in-window interaction; `WindowConfig` (persisted in `context.globalState` under `aiInsights.windowConfig`) lets the user manually override the session/weekly reset time to match what `claude.ai → Limits` actually shows, via the gear-icon config form (`saveWindowConfig` message, surgical `postMessage` update - no full page reload).

## Local Usage

Drawn from `AggregatedMetrics.currentMonthByProvider.claudeCode` and `todayByProvider.claudeCode`:

- Today tokens + cost
- This-month tokens + cost
- Cache hit rate + savings USD
- Sessions + interactions count
- Token breakdown (input/output/cache read/cache write/thinking)
- Per-model breakdown (`modelUsage` map → sorted table, `buildModelRows()`)

## Plan selector

Chips for `free`/`pro`/`max5x`/`max20x`/`api` (`PLAN_LABELS`/`PLAN_COLOR`), persisted via `setPlan` message to `context.globalState` under `aiInsights.claudePlan`. Purely cosmetic today (affects only the accent color and badge label) - not wired to any billing/quota calculation.

## Message Protocol

| Direction | Command / Type | Payload |
|-----------|---------------|---------|
| Webview → ext | `setPlan` | `{ plan: ClaudePlan }` |
| Webview → ext | `saveWindowConfig` | `{ sessionResetTime, weeklyResetDay, weeklyResetHour }` |
| Webview → ext | `refresh` | — |
| Webview → ext | nav commands | handled via `NAV_COMMANDS` map |
| Ext → webview | `windowConfigSaved` | recalculated session/weekly card values (surgical DOM update, no reload) |

## Params (`createPanel` / `getHtml` / `pushMetrics`)

`(context, metrics, sessions, claudeQuota?)` — `claudeQuota` is threaded from `extension.ts`'s module-level state (see [claudeQuota.md](../core/claudeQuota.md)'s "Integration" section) through every re-render path (`setPlan`, `saveWindowConfig` recompute keeps the existing snapshot since that message only patches the window cards, initial `createPanel`).
