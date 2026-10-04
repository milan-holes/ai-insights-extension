# insightsEngine — Rule-Based Insights/Nudge Catalog

| Item | Value |
| ---- | ----- |
| Files | [src/core/insightsEngine.ts](../../src/core/insightsEngine.ts), [src/core/insightsStateStore.ts](../../src/core/insightsStateStore.ts) |
| Export | `computeInsights(ctx, dismissedIds?, snoozedUntil?, limit?): Insight[]` |

## Purpose

Turns the various `if (condition) { message }` patterns scattered across `usageHealthScore.ts` and `dashboard.ts`'s anomaly rendering into a single declarative, dismissable/snoozable rule catalog. Replaces the dashboard's old static `UsageHealthScore.topRecommendations` list.

## Insight shape

```ts
type InsightType = 'tip' | 'opportunity' | 'celebration';
interface Insight { id: string; type: InsightType; message: string; weight: number; }
```

## Rule catalog (14 rules, highest weight first)

| id | Signal source | Weight |
| -- | -------------- | ------ |
| `budget-overage-risk` | `budget.overageRiskScore > 90` | 95 |
| `spend-spike` | `anomaly.isSpike` | 85 |
| `low-cache-hit-rate` | `cache.cacheHitRate < 0.2` | 80 |
| `runaway-sessions` | `anomaly.runawaySessionsCount > 0` | 75 |
| `low-acceptance-rate` | `acceptance.acceptanceRate < 0.15` (needs ≥10 samples) | 70 |
| `marathon-sessions` | `sessionHygiene.marathonSessions > 0` | 65 |
| `copilot-real-cache-data-available` | Copilot usage present + `agentDebugLog.fileLogging.enabled` currently off (added 2026-07-05) | 60 |
| `compaction-heavy` | auto-compactions ≥3 and >2× manual | 55 |
| `high-thinking-overhead` | `roi.thinkingOverheadPct > 30` | 50 |
| `tool-heavy-sessions` | `sessionComplexity.toolHeavyCount > 5` | 45 |
| `low-context-anchoring` | zero context refs detected, >20 interactions this month | 40 |
| `single-turn-sessions` | `sessionComplexity.avgSessionDepth < 1.5`, >5 sessions | 35 |
| `high-cache-hit-celebration` | `cache.cacheHitRate > 0.6` | 20 |
| `healthy-usage-fallback` | always matches | 5 |

Only the fallback rule always matches, so it's the lowest weight - any real finding outranks it. `computeInsights()` returns up to `limit` (default 6) matching rules, highest weight first, excluding dismissed/snoozed IDs.

## Dismiss / snooze persistence

`InsightsStateStore` is a JSON-file-backed store (same pattern as [sessionTagsStore.ts](./sessionTagsStore.md)), storing dismissed IDs permanently and snoozed IDs for 1 week (`SNOOZE_DURATION_MS`). Lives at `<globalStorageUri>/insights-state.json`.

## Wiring

- `extension.ts` instantiates `InsightsStateStore` alongside `sessionTagsStore`, and computes insights in `showDashboard()` alongside `computeUsageHealthScore()`.
- New commands `aiInsights.dismissInsight` / `aiInsights.snoozeInsight` update the store then rebuild the dashboard.
- `dashboard.ts` renders the list inside the health-score card (where `topRecommendations` used to be), with 💤/✕ buttons per non-celebration insight that `postMessage` back to the extension host.
