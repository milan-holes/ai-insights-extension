# Session: Proposed Metrics Implementation - 2026-04-29

## What was done

- Implemented all metric categories from `wiki/proposed-metrics.md` driven by Copilot's June 2026 usage-based billing shift
- Extended type system with 7 new interfaces
- Created `src/core/budgetManager.ts` (new module) with 5 pure computation functions
- Fixed bug: `buildMetrics` was not passing `cacheReadTokens`/`cacheWriteTokens` to `calculateCost`
- Added cache savings computation (comparing cost with vs. without caching per interaction)
- Added cost-by-model and cost-by-repository breakdowns to `ProviderMetrics`
- Extended `aggregateSessions` to accept `AggregationConfig` and compute all derived metrics
- Updated all 5 webview files; added `Cost Intelligence` tab to Usage Analysis
- Added 2 new chart tabs: Daily Cost ($) and Cache Efficiency
- Registered 7 new VS Code configuration settings
- Build passes cleanly (`tsc --noEmit` + esbuild, 156.4 KB bundle)

## Files changed

- [`src/types.ts`](../../src/types.ts) - added `BudgetMetrics`, `CacheMetrics`, `ROIMetrics`, `AnomalyFlags`, `SessionComplexityMetrics`, `AlertThresholds`, `AggregationConfig`; added `cacheReadTokens`, `cacheWriteTokens`, `cacheSavingsUsd`, `costByModel`, `costByRepository` to `ProviderMetrics`; extended `AggregatedMetrics`
- [`src/core/sessionAggregator.ts`](../../src/core/sessionAggregator.ts) - accepts `AggregationConfig`, fixed cache-aware cost calc, computes cache savings, delegates extended metrics to `budgetManager`
- [`src/core/budgetManager.ts`](../../src/core/budgetManager.ts) - **new file**: `computeBudgetMetrics`, `computeCacheMetrics`, `computeROIMetrics`, `computeAnomalyFlags`, `computeSessionComplexity`
- [`src/extension.ts`](../../src/extension.ts) - reads `copilotPlanBudget`, `teamSize`, `alertThresholds.*` from config; passes `AggregationConfig` to aggregator; adds budget alert indicator to status bar
- [`src/webview/dashboard.ts`](../../src/webview/dashboard.ts) - budget health bar widget, alert banners (critical/warn/info), cache efficiency KPI cards, ROI table, cost-by-model and cost-by-repo tables, cache row in usage-by-period table
- [`src/webview/charts.ts`](../../src/webview/charts.ts) - 2 new chart tabs: "Daily Cost ($)" (bar + cumulative line) and "Cache Efficiency" (hit rate % + estimated savings); filters to last 30 days; 6-card summary row
- [`src/webview/usageAnalysis.ts`](../../src/webview/usageAnalysis.ts) - new "Cost Intelligence" tab with: Budget Health & Forecast, Cache Efficiency, ROI & Efficiency, Anomaly & Risk Detection, Session Complexity, Repository Cost Attribution
- [`package.json`](../../package.json) - 7 new `aiInsights.*` configuration properties

## Decisions made

- `budgetManager.ts` is a pure module (no VS Code imports) so it can be unit-tested independently
- Cache savings are computed per-interaction by comparing `calculateCost(with_cache)` vs `calculateCost(without_cache)` - this uses actual model pricing rather than a fixed discount ratio
- `AggregationConfig` is optional with sensible defaults so existing call sites without config still work
- Alert thresholds are configurable via settings rather than hardcoded, supporting enterprise customisation
- Daily chart data is filtered to last 30 days in `charts.ts` (not at the aggregator level) to keep the raw `daily` array complete for other uses
- `burnAcceleration` defaults to `2` when week2 cost is 0 and week1 is non-zero (genuinely new spending)
- `daysUntilExhausted` is `null` (not `Infinity`) when burn rate is 0, so webviews can distinguish "no spending" from "very slow spending"

## Follow-up / known gaps

- Copilot completion events (free interactions) are not yet captured - requires hooking `onDidAcceptCompletionItem`
- Cache savings estimate in the charts tab uses a simplified $0.000002/token × 80% heuristic instead of per-model pricing (full calc would require exporting `findModelPricing` from `costEstimation.ts`)
- `runawaySessionsCount` recalculates session cost from scratch during anomaly detection - could be cached
- Plan break-even analysis (when does upgrading tiers save money?) is documented in the proposal but not yet implemented as a UI component
