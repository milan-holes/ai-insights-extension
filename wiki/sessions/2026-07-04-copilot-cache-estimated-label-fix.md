# Session: Copilot cache "(calc.)" mislabeling fix - 2026-07-04

## What was done

- Verified the intended behavior for GitHub Copilot cache token calculation: real per-call telemetry from `debug-logs/{sessionId}/main.jsonl` should be used whenever present (requires the opt-in `github.copilot.chat.agentDebugLog.fileLogging.enabled` Copilot setting), falling back to the turn-over-turn heuristic (gated by `aiInsights.providers.copilot.cacheEstimation.enabled`) only when no matching debug log exists - confirmed this is exactly what `copilot.ts`'s `attachRealCacheData()` / `applyCacheHeuristic()` already implement, with `Interaction.cacheTokensEstimated` / `Session.cacheTokensEstimated` correctly flagging which numbers are which.
- Found that this per-interaction/session flag never made it into the aggregated `ProviderMetrics` used by the dashboard and pricing views, so those two surfaces fell back to inferring "estimated" from `cacheReadTokens > 0` alone - which is also true for real telemetry, so once real data started flowing in (2026-07-03 session) it was still being labeled "(calc.)" / "calculated, not measured".
- Added `ProviderMetrics.cacheTokensEstimated` (aggregate: true if any contributing session used the heuristic) and wired the two affected views to check it instead of raw token counts.

## Files changed

- `src/types.ts` - added `cacheTokensEstimated: boolean` to `ProviderMetrics`.
- `src/core/sessionAggregator.ts` - `buildMetrics()` computes `cacheTokensEstimated = sessions.some(sess => sess.cacheTokensEstimated)` and includes it in the returned record.
- `src/webview/dashboard.ts` - Cache Efficiency widget now shows "(calculated, not measured)" only when `copilotCacheIsEstimated` is true; otherwise shows "(measured via Copilot telemetry)" in the heading and a "✅ Real cache/token counts..." note instead of the estimation-methodology `<details>` block.
- `src/webview/pricingView.ts` - "Cached input tokens" row and "Usage by Model" table's "(calc.)" tags/tooltips now gated on `copilotMonth.cacheTokensEstimated` in addition to `cacheReadTokens > 0`.
- `wiki/core/sessionAggregator.md`, `wiki/providers/copilot.md` - documented the new flag and why it exists.

## Decisions made

- Used a single aggregate boolean (`some(...)`) rather than a real/estimated token split, matching the existing session-level convention (`Session.cacheTokensEstimated`) instead of introducing a new partial-mix representation. A month with both real and estimated sessions still shows the "(calc.)" disclaimer, which is the conservative/correct choice (don't imply all numbers are measured when some aren't).
- Did not touch `sessionsView.ts`, `replayView.ts`, or `sessionCompareView.ts` - those already check `interaction.cacheTokensEstimated` / `session.cacheTokensEstimated` directly per-item rather than inferring from token counts, so they were unaffected by this bug.

## Follow-up / known gaps

- `ProviderMetrics.modelUsage` (per-model cache breakdown) has no per-model estimated flag - the model usage table in `pricingView.ts` only gates the column header/row label at the whole-table level, not per model row, so a model with only real data still sits under a table-wide "(calc.)" note if any other model in the same month was estimated. Not fixed here; would need per-model tracking in `buildMetrics()`.
