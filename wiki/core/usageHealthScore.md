# usageHealthScore — Composite Usage Health Score

| Item | Value |
| ---- | ----- |
| File | [src/core/usageHealthScore.ts](../../src/core/usageHealthScore.ts) |
| Export | `computeUsageHealthScore(metrics, recentSessions, acceptance?): UsageHealthScore` |

## Purpose

Single 0-100 "AI Health" score shown at the top of the dashboard, broken into 5 weighted components.

## Components (sum to 100 pts)

| Component | Max pts | Full credit at | Source |
| --------- | ------- | -------------- | ------ |
| Cache Efficiency | 25 | ≥40% cache hit rate | `metrics.cache.cacheHitRate` |
| Context Quality | 25 | avg 100/100 across recent sessions | [contextRot.ts](./contextRot.md)'s `computeContextRotScore()` over up to 30 sessions with ≥3 turns |
| Cost Efficiency | 20 | ≥0.25 output/input ratio | `metrics.roi.inputEfficiencyRatio` |
| Completion Acceptance | 15 | ≥30% acceptance rate (neutral 8/15 if <10 samples) | `acceptance.acceptanceRate` |
| Budget Health | 15 | 0% of monthly budget consumed | `metrics.budget.budgetUtilizationPct` |

All 5 scale linearly between their floor and full-credit threshold. Overall grade: A ≥85, B ≥70, C ≥55, D ≥40, else F.

## Transparency (`rule` field)

Each `HealthComponent` carries both `detail` (the current value, e.g. "23% cache hit rate") and `rule` (a plain-language description of the threshold/formula behind the score, e.g. "Full 25 pts at ≥40% cache hit rate; scales down linearly to 0 pts at 0%."). The dashboard renders `rule` inside a native `<details>` disclosure under each component's `detail` text, so the scoring isn't a black box - no separate debug panel needed since the thresholds are already inline literals in this file.

## Recommendations → insights

The old `UsageHealthScore.topRecommendations` field (a static, capped-at-3 string list built from `if (...) { recs.push(...) }` checks alongside each component) has been removed - the dashboard now renders [insightsEngine.ts](./insightsEngine.md)'s richer, dismissable insight list in its place, which covers the same signals (and more) as declarative rules.
