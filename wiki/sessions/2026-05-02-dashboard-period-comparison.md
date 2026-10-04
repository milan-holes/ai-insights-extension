# Session: Dashboard period-over-period comparison - 2026-05-02

## What was done

- Added `yesterday` and `yesterdayByProvider` fields to `AggregatedMetrics`
- Computed yesterday sessions in `sessionAggregator.ts` (date key filter, same pattern as `today`)
- Added `fmtDiff(current, previous)` helper in `dashboard.ts` that returns a coloured `↑ N%` / `↓ N%` badge (green/red)
- Updated three summary cards to show previous-period value and % change:
  - **Tokens Today** - vs yesterday
  - **This Month** - vs last month (tokens)
  - **Copilot AI Credits** - vs last month (credits)

## Files changed

- [`src/types.ts`](../../src/types.ts) - added `yesterday`, `yesterdayByProvider` to `AggregatedMetrics`
- [`src/core/sessionAggregator.ts`](../../src/core/sessionAggregator.ts) - compute `yesterdayMetrics` and `yesterdayByProvider`, include in return value
- [`src/webview/dashboard.ts`](../../src/webview/dashboard.ts) - `fmtDiff` helper + badge HTML on three cards

## Decisions made

- Green = higher, red = lower (neutral framing - more tokens = more work done, not a warning)
- Previous value shown in muted parentheses next to the badge so the user can see the absolute reference
- No change to the detailed "Token Usage by Period" table - the cards already give the quick answer

## Follow-up / known gaps

- Could add yesterday Copilot credits line (needs `yesterdayByProvider.copilot`) but not requested
