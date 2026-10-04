# Live Session Monitor — `src/core/liveSessionMonitor.ts`

## Purpose

Detects "live" (currently active) AI sessions from parsed session data and computes real-time burn metrics.

## How liveness is determined

A session is considered live if **either**:
1. Its last `interaction.timestamp` is within the past **3 minutes**, or
2. Its `sourceFile` mtime is within the past **3 minutes** (catches providers that batch-write interactions)

## Key functions

| Function | Returns | Notes |
|----------|---------|-------|
| `detectLiveSessions(sessions, budget, windowCost, windowTokens)` | `LiveSessionState[]` | Main entry point; sorted by session start time descending |
| `aggregateLiveBurnRate(states)` | `number` | Combined tokens/min across all live sessions |

## Burn rate calculation

- Takes interactions from the last **10 minutes** of the session
- `burnRate = totalTokens / windowMinutes`
- Falls back to whole-session average when fewer than 2 interactions fall in the window

## Alert thresholds

| Alert type | Trigger |
|---|---|
| `spike` | burn rate > 6,000 tokens/min (3× `HIGH_BURN_RATE`) |
| `high_burn` | burn rate > 2,000 tokens/min |
| `rate_limit_imminent` | projected exhaustion ≤ 60 min |
| `rate_limit_hit` | budget exhausted (remaining ≤ 0) |
| `high_burn` (budget) | budget window used ≥ 90% |

## Budget window reset times

| Type | Reset |
|---|---|
| `daily` | Next midnight local time |
| `weekly` | Next Sunday midnight |
| `monthly` | First of next month |
| `fixed` | `fixedWindowEnd` from config |

## Related types

`LiveSessionState`, `LiveBudgetConfig`, `LiveAlert` — see [src/types.ts](../../src/types.ts)
