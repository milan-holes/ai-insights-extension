# Session: Copilot cache debug-logging docs + dashboard button + credits gap analysis - 2026-07-05

## What was done

- Investigated why a single-turn Copilot session showed 0% cache hit rate (expected: heuristic has no prior turn to diff against).
- Re-checked whether any "real" Copilot Chat cache-token source exists beyond the opt-in debug log. It doesn't: that log is the only one, so for users who never enable it the choice is between `0` and an estimate.
- Documented the exact setting (`github.copilot.chat.agentDebugLog.fileLogging.enabled`) that gates real vs. estimated Copilot cache data, and what changes for sessions before/after enabling it.
- Added a discoverable "Enable Real Cache Data" button directly in the dashboard's and Copilot credits page's Cache Efficiency widgets, instead of requiring users to find the Command Palette entry or wait for the one-time activation prompt.
- Audited every UI surface that displays Copilot cache numbers (dashboard, pricing/credits page, charts, sessions list, replay view, session compare) to confirm estimated cache data is always flagged - found and fixed one surface (`charts.ts`) that was gating its "(calc.)" disclaimer on `cacheReadTokens > 0` instead of `cacheTokensEstimated`, mislabeling real telemetry as estimated.
- Found and corrected three stale claims that Copilot cache data "can't be accessed at all"/"isn't tracked" - a doc comment in `copilot.ts`, an explanatory block in `pricingView.ts`, and a dashboard "About This Data" bullet, all predating the 2026-07-03 debug-log discovery.
- Found and fixed a real bug reported by testing: disabling `github.copilot.chat.agentDebugLog.fileLogging.enabled` after it had been on produced no visible warning anywhere. Root cause: the Cache Efficiency widget's "measured, not calculated" branch (shown whenever this period's aggregate `cacheTokensEstimated` flag is false - e.g. because of sessions logged before disabling) never checked the *live* setting value, so it never showed the enable button or any acknowledgment that the setting was now off. Fixed in both `dashboard.ts` and `pricingView.ts`.
- Added a persistent, dismissable dashboard nudge (new `copilot-real-cache-data-available` insight rule) so users see an ongoing warning when the setting is off, independent of the one-time activation popup (which is intentionally one-shot and doesn't resurface on disable) and independent of whether the current period's data happens to read as measured or estimated.
- Gated all three "enable this setting" surfaces (dashboard/pricing button+warning, new insight rule) on `github.copilot-chat` actually being installed, not just on past Copilot usage data existing - otherwise a user who'd uninstalled Copilot Chat but still had historical usage in their session history would be told to enable a setting for an extension no longer present.
- Made the dashboard insight tip directly actionable: added the same "Enable Real Cache Data" button inline under the `copilot-real-cache-data-available` tip's message on the main dashboard's AI Health card, instead of requiring a tab switch to the Copilot-only Cache Efficiency widget to act on it.
- Analyzed and documented what's missing for reliable GitHub Copilot "AI Credits" numbers: no premium-request-multiplier accounting anywhere in the codebase, `debug-logs/{sessionId}/models.json`'s real per-model multiplier data discovered but unused, the real quota-consumed billing endpoint never called, and "budget" being each plan's flat subscription price rather than its real premium-request allowance value.

## Files changed

- `src/webview/dashboard.ts` - added `enableCopilotRealCacheData` postMessage case routed to the existing `aiInsights.enableCopilotRealCacheData` command; added a button to the Cache Efficiency widget, shown only when the debug-log setting is off and the user has recent Copilot usage.
- `src/webview/pricingView.ts` - same button + message case; rewrote the "How are Cache tokens calculated?" disclosure to branch on measured-vs-estimated instead of always describing cache as unmeasurable.
- `src/webview/charts.ts` - fixed the Cache Hit Rate summary tile's "calculated" disclaimer to gate on `cacheTokensEstimated` instead of `cacheReadTokens > 0`; added the same disclaimer to the Cache Efficiency chart tab, which previously had none.
- `src/providers/copilot.ts` - corrected `applyCacheHeuristic()`'s doc comment, which still claimed cache data was unconditionally unavailable.
- `wiki/providers/copilot.md` - added a "Quick reference: sessions with vs. without debug logging enabled" comparison table, a "Dashboard button" subsection, a "Design note: why the cache heuristic stays" section, and a "Persistent dashboard nudge" subsection.
- `wiki/core/costEstimation.md` - new "GitHub Copilot AI Credits: known gaps to reliable numbers" section (7 concrete gaps, most notably the missing premium-request-multiplier system).
- `src/core/insightsEngine.ts` - new `copilot-real-cache-data-available` rule (weight 60) and `copilotDebugLoggingEnabled`/`copilotChatExtensionInstalled` fields on `InsightContext`.
- `src/extension.ts` - reads the live Copilot debug-logging setting and extension-installed state, passes both into `computeInsights()`.
- `wiki/core/insightsEngine.md` - added the new rule to the catalog table (13 → 14 rules).

## Decisions made

- Gated the new button on `copilotHasUsage` (any recent Copilot tokens) rather than always showing it, so it doesn't clutter the dashboard for non-Copilot users - the section it lives in is already Copilot-tab-only.
- Reused the existing `aiInsights.enableCopilotRealCacheData` command (`force: true` path) rather than flipping the setting directly from the webview handler, so the button gets the same Enable/Not now/Don't ask again confirmation and privacy note as the Command Palette entry - no silent setting changes from a single click.
- Did not add a button to the "already measured" branch of the widget - there's nothing to enable there.
- Credits-gap analysis was scoped to documentation only (not implementation) - the fixes (parsing `models.json`, calling the real quota endpoint, reworking the budget model) are substantial enough to warrant their own planning pass rather than being bundled into a docs/bug-fix session.

## Follow-up / known gaps

- Not yet confirmed whether ask/chat-mode Copilot sessions populate full debug-log telemetry the same way agent-mode sessions do (only agent-mode has been directly verified) - see `wiki/providers/copilot.md`.
- Credits-reliability gaps documented in `wiki/core/costEstimation.md` are not yet fixed - `debug-logs/{sessionId}/models.json` parsing and the real quota-consumed billing endpoint are the two highest-value, already-identified next steps.
