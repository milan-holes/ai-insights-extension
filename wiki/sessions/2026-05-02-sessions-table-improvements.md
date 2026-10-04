# Session: Sessions Table Improvements - 2026-05-02

## What was done

- Fixed Antigravity sessions all showing today's date (timestamp bug)
- Added session title column (Claude Code ai-title + Antigravity first user line)
- Added Cost / Credits column (AI credits for Copilot, USD for all)
- Fixed table horizontal scroll (columns were cut off on the right)
- Removed v1 sessionsList.ts; `aiInsights.showSessions` now routes to sessionsView.ts

## Files changed

- [`src/providers/antigravity.ts`](../../src/providers/antigravity.ts) - `parseOverview` now parses `created_at` from JSON lines; falls back to file mtime; extracts title from first USER_INPUT line
- [`src/providers/claudeCode.ts`](../../src/providers/claudeCode.ts) - extracts `aiTitle` from `type:"ai-title"` events; computes `estimatedCostUsd` via `calculateCost()`
- [`src/types.ts`](../../src/types.ts) - added `title?: string` and `estimatedCostUsd?: number` to `Session`
- [`src/webview/sessionsView.ts`](../../src/webview/sessionsView.ts) - new title + credits columns; horizontal scroll; `toRows()` adds `aiCredits`
- [`src/webview/dashboard.ts`](../../src/webview/dashboard.ts) - removed "Sessions v2" button (merged into "Sessions"); fixed unused `cost` variable
- [`src/extension.ts`](../../src/extension.ts) - removed `SessionsListProvider` import and `showSessions`/`refreshSessions` commands; `showSessions` now delegates to `showSessionsView`
- `src/webview/sessionsList.ts` - **deleted**
- [`CHANGELOG.md`](../../CHANGELOG.md) - documented all changes

## Root cause: Antigravity date bug

`parseOverview` created all interactions with `timestamp: new Date()`:

```typescript
// Before (broken)
interactions.push({
  timestamp: new Date(),  // ← always today's time at parse time
  ...
});

// After (fixed)
const ts = entry.created_at ? new Date(entry.created_at) : null;
```

The Antigravity `overview.txt` is JSON-lines where each entry has `"created_at": "2026-04-29T16:29:39Z"`. Parsing this gives real timestamps per turn.

## AI Credits calculation

`1 AI credit = $0.01 USD` (GitHub's billing rate from `costEstimation.ts` `USD_PER_AI_CREDIT`).

```typescript
aiCredits: Math.round(cost * 100 * 100) / 100; // cost / 0.01, rounded to 2dp
```

Copilot sessions show a green badge: `"X.XX cr"` + `"$0.0000"`. Other providers show just the USD cost.

## Decisions made

- Title truncated to 80 chars in Antigravity; Claude Code titles are already short
- Cost column shows for all providers (useful for Claude Code which has real pricing); Copilot gets the credit badge on top
- `min-width: 1100px` on table forces scroll rather than squishing columns

## Follow-up / known gaps

- Copilot AI credits use calculated cost ÷ $0.01 - this is an estimate; actual GitHub billing may differ based on the plan and model multipliers
- Antigravity token counts are still estimated (no real token data in `created_at` events); real counts require a different data source
