# Session: Real GitHub Copilot quota fetch - 2026-07-08

## What was done

- Established how "AI credits remaining" can be read at all: GitHub's undocumented internal `copilot_internal/user` endpoint, reachable via VS Code's built-in GitHub auth provider, returns the real `premium_interactions` quota snapshot. Everything else is pure-function math on top (percent remaining, health badge, days-until-reset) plus a local `globalState` snapshot history for burn-rate prediction.
- Confirmed ai-insights had never called this endpoint: `githubAuth.ts` only fetched `/user` for the plan name and guessed a flat monthly budget from a hardcoded table. This gap was already flagged (but not fixed) in [core/costEstimation.md](../core/costEstimation.md)'s "known gaps" section from 2026-07-05.
- Implemented quota fetch, stats, reset countdown, local history and burn-rate prediction in a new `src/core/copilotQuota.ts`, following this codebase's conventions.
- Wired it in as an **opt-in, silent** background refresh: only runs once the user has connected GitHub (`aiInsights.connectGitHub`), and uses a new non-prompting mode of `getGitHubAccessToken()` so it never surprises anyone with a sign-in dialog.
- Surfaced the result in two places: a line in the status bar tooltip, and a new "Copilot Quota Remaining" card in the dashboard's Copilot provider tab, next to (not replacing) the existing token-derived "AI Credits This Month" card.
- **Follow-up fix, same day**: user reported the Pricing panel's "Connect GitHub" button did nothing. Root cause was unrelated to the quota feature above and predated this session - `pricingView.ts`'s "Connect GitHub"/"Reconnect"/"Disconnect" buttons called `post(...)`, a helper that was never defined anywhere in the file or in `navShared.ts`'s shared script, so every click threw a silent `ReferenceError` in the webview console. Fixed by switching all three to `window.vscode.postMessage({command:...})`, the pattern already used elsewhere in the same file.
- **Follow-up UI change, same day**: moved "Connect GitHub" into the main dashboard's header (`navTopbarHtml`'s `extraRight` slot in `dashboard.ts`, shown only when `!githubUser`) so connecting doesn't require first navigating to the Pricing tab. Also added `percentUsed` to `CopilotQuotaView` (`copilotQuota.ts`) and used it in the bottom-right credits pill (`dashboard.ts`) to append the real quota state - "X% quota used" / "over quota" / "unlimited quota" - next to the existing token-derived credits figure.

## Files changed

- `src/core/copilotQuota.ts` - new. Fetch, `QuotaStats`/`CopilotQuotaView` computation, `QuotaHistoryStore` (per-login `globalState` history, max 90 snapshots), `getQuotaPrediction()` burn-rate heuristic.
- `src/core/githubAuth.ts` - `getGitHubAccessToken()` gained a `createIfNone` option (default `true`, preserves existing behavior) so callers can request a token without ever triggering the sign-in prompt.
- `src/extension.ts` - added `copilotQuota`/`copilotQuotaHistoryStore`/`extensionContext` module state, `refreshCopilotQuota()` (called at the end of every `refresh()` cycle and once right after Connect GitHub), `getCopilotQuotaView()`, `buildQuotaTooltipLines()` spliced into both status-bar tooltip branches, and threaded the view model into `DashboardProvider.createPanel(...)`. `handleDisconnectGitHub` now also clears `copilotQuota`.
- `src/webview/dashboard.ts` - `createPanel`/`getHtml` gained a trailing optional `copilotQuota?: CopilotQuotaView` param; `buildProvCards('copilot')` renders a quota card when present.
- `wiki/core/copilotQuota.md` - new component doc.
- `wiki/core/githubAuth.md` - documented the new `createIfNone` option and added `refreshCopilotQuota()` as a caller.
- `wiki/core/costEstimation.md` - added a note under gap #3 explaining this partially (not fully) addresses it.

## Decisions made

- Used `copilot_internal/user` (the endpoint the reference extension uses) rather than the personal-accounts-only `GET /users/{user}/settings/billing/usage` endpoint costEstimation.md's gap #3 originally pointed at - the internal endpoint works for both personal and org-provided Copilot seats.
- Gated the whole feature behind "has the user connected GitHub" instead of adding a new settings toggle - avoids a second config surface, and matches the existing opt-in nature of `connectGitHubAndDetectPlan()`.
- Did not implement the reference extension's Copilot Chat `#copilotQuota` language-model tool, its 7 status-bar visual styles, or its markdown/JSON clipboard export - out of scope for this pass; the status-bar tooltip line and dashboard card cover the "how much do I have left" question directly.
- Left `PLAN_BUDGET`'s flat-subscription-price budget math (costEstimation.md gap #4) and the missing premium-request multiplier (gap #1) untouched - this real quota number is additive, not a replacement for the existing token-cost pipeline.

## Follow-up / known gaps

- No local history yet at ship time (history only grows going forward from real fetches), so the burn-rate/exhaustion prediction line won't appear for anyone until at least two refresh cycles with real API data have happened.
- The endpoint is undocumented/internal and could change or be locked down without notice; failures are already handled silently (return `null`, log to output channel), so this degrades gracefully rather than erroring.
