# budgetManager - Extended Metric Computations

**Source**: [src/core/budgetManager.ts](../../src/core/budgetManager.ts)  
**Depends on**: `calculateCost` from `costEstimation`, types from `types.ts`

Pure computation module - no VS Code imports. Called by `sessionAggregator` after base aggregation.

## Exported functions

| Function                   | Input                          | Output                     |
| -------------------------- | ------------------------------ | -------------------------- |
| `computeBudgetMetrics`     | `now, currentMonth, config`    | `BudgetMetrics`            |
| `computeCacheMetrics`      | `currentMonth`                 | `CacheMetrics`             |
| `computeROIMetrics`        | `currentMonth, byProvider`     | `ROIMetrics`               |
| `computeAnomalyFlags`      | `now, sessions, daily, config` | `AnomalyFlags`             |
| `computeSessionComplexity` | `sessions, config`             | `SessionComplexityMetrics` |

## BudgetMetrics

| Field                  | Formula                                                |
| ---------------------- | ------------------------------------------------------ |
| `mtdSpend`             | `currentMonth.estimatedCost`                           |
| `dailyBurnRate`        | `mtdSpend / daysElapsed`                               |
| `projectedMonthEnd`    | `dailyBurnRate × daysInMonth`                          |
| `overageRiskScore`     | `projectedMonthEnd / planBudget × 100` (capped at 200) |
| `budgetUtilizationPct` | `mtdSpend / planBudget × 100` (capped at 100)          |
| `daysUntilExhausted`   | `creditsRemaining / dailyBurnRate`; `null` if burn=0   |
| `teamProjectedCost`    | `projectedMonthEnd × teamSize`                         |

## CacheMetrics

| Field                 | Formula                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `cacheHitRate`        | `cacheReadTokens / (inputTokens + cacheReadTokens)`                             |
| `cacheSavingsUsd`     | From `ProviderMetrics.cacheSavingsUsd` (computed per-interaction in aggregator) |
| `cacheWriteReadRatio` | `cacheReadTokens / cacheWriteTokens`                                            |

Cache savings are computed accurately by comparing `calculateCost(with_cache)` vs `calculateCost(without_cache)` per interaction using actual per-model pricing.

## AnomalyFlags

| Field                  | Method                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- |
| `todayZScore`          | Z-score of today's cost vs last 30 days daily mean/stddev (requires ≥3 past days) |
| `isSpike`              | `todayZScore > 2.0`                                                               |
| `runawaySessionsCount` | Sessions where `totalTokens > threshold` OR `cost > threshold`                    |
| `burnAcceleration`     | `week1Cost / week2Cost` (last 7 days vs prior 7 days)                             |
| `consecutiveHighDays`  | Consecutive days ≥ 80% of daily budget pace, counted backwards from today         |

## SessionComplexityMetrics

| Field                     | Definition                                    |
| ------------------------- | --------------------------------------------- |
| `longSessionsCount`       | Sessions where `endTime - startTime > 30 min` |
| `toolHeavyCount`          | Sessions with >5 unique tool calls            |
| `thinkingSessionsCount`   | Sessions where `totalThinkingTokens > 0`      |
| `multiModelSessionsCount` | Sessions where `models.length > 1`            |
| `highestCostSession`      | Max-cost session: `{ id, cost, tokens }`      |

## Configuration defaults

```typescript
const DEFAULT_THRESHOLDS: AlertThresholds = {
  budgetWarningPct: 80,
  budgetCriticalPct: 95,
  runawaySessionTokens: 100_000,
  runawaySessionCostUsd: 1.0,
};
```

All overridable via `aiInsights.alertThresholds.*` in VS Code settings.
