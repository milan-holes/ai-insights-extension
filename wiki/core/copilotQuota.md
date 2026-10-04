# copilotQuota

**File**: [src/core/copilotQuota.ts](../../src/core/copilotQuota.ts)

Fetches the authenticated user's **real** GitHub Copilot quota (premium-request remaining/entitlement/reset date) from GitHub's internal `copilot_internal/user` endpoint - the same one the Copilot Chat extension itself uses to enforce limits. This is genuine account data from GitHub, distinct from the token/cost figures [providers/copilot.md](../providers/copilot.md) and [costEstimation.md](costEstimation.md) estimate from local session logs.

## Why it exists

Remaining AI credits, reset countdown and burn-rate prediction all come from one API call this codebase never made. [costEstimation.md](costEstimation.md)'s "known gaps" section (added 2026-07-05) already flagged that `githubAuth.ts` only fetches `/user` for the plan name and falls back to a hardcoded flat budget per plan (gap #3/#4) - this module is the fix: it calls a second, different endpoint that returns the actual `premium_interactions` quota snapshot (not the `/settings/billing/usage` endpoint that doc originally pointed at, which is personal-accounts-only; `copilot_internal/user` works for both personal and org-provided seats).

## Endpoint

```
GET https://api.github.com/copilot_internal/user
Authorization: Bearer <github session token>
```

Undocumented/internal - may 403/404 for some accounts, orgs, or during outages. `fetchCopilotQuota()` catches all failures and returns `null`; callers treat that as "no data yet," never as an error to surface.

## Opt-in, not polled by default

Unlike the token-log providers (which always run), this only fetches once the user has explicitly run **`AI Insights: Connect GitHub`** (`connectedGitHubUser` is set). Background refreshes then use `getGitHubAccessToken({ createIfNone: false })` (see [githubAuth.md](githubAuth.md)) - a **silent** token check that never prompts a sign-in dialog, so users who haven't connected GitHub see no behavior change at all.

## API

```ts
fetchCopilotQuota(accessToken: string): Promise<CopilotQuotaData | null>
findPremiumQuota(data: CopilotQuotaData): CopilotQuotaSnapshot | undefined
computeQuotaStats(q: CopilotQuotaSnapshot): QuotaStats            // used/remaining/percent/overage
daysUntilReset(resetDateUtc: string, asOf?: Date): { days; hours } | null
getQuotaPrediction(quota, resetDateUtc, asOf?): QuotaPrediction | null
buildQuotaView(data): CopilotQuotaView | undefined       // flattened view model for UI

class QuotaHistoryStore {
  constructor(globalState: vscode.Memento)
  setAccount(login: string): void   // keys history per GitHub login, migrates nothing (new store)
  add(remaining: number, entitlement: number): void
  get snapshots(): readonly LocalQuotaSnapshot[]
}
```

## Local history & prediction

Every successful fetch appends `{ timestamp, remaining, entitlement }` to `QuotaHistoryStore` (VS Code `globalState`, capped at 90 entries, keyed `aiInsights.copilotQuotaHistory.<login>`). The history is **not** used for prediction.

`getQuotaPrediction()` uses GitHub's cycle-to-date figure only:

| Step | Formula |
| --- | --- |
| Cycle start | `quota_reset_date_utc` minus one calendar month |
| Daily rate | `(entitlement - quota_remaining) / max(1, daysSinceCycleStart)` |
| Exhaustion | `floor(remaining / dailyRate)` |
| Confidence | elapsed ≥7d `high`, ≥3d `medium`, else `low` |

`buildQuotaView()` only sets `daysUntilExhaustion` when exhaustion lands **before** the reset, so the "until exhausted" line is shown only when it matters.

Why not snapshot deltas (the previous approach): the stored history spans billing cycles and plan changes. A 10000 → 4000 entitlement change read as 6 422 requests consumed in one day and produced "~2d until exhausted" with 93 % of the quota left. Pairwise rates also extrapolated short bursts to 24 h and skipped idle gaps.

## Integration (`extension.ts`)

```ts
// After every refresh() cycle, and once right after Connect GitHub:
void refreshCopilotQuota();   // no-op if connectedGitHubUser is unset or token fetch is silent-empty

function getCopilotQuotaView(): CopilotQuotaView | undefined {
  return copilotQuota ? buildQuotaView(copilotQuota) : undefined;
}
```

`getCopilotQuotaView()` feeds three surfaces:
- **Status bar tooltip** (`buildQuotaTooltipLines()`) - appends a `🐙 Copilot Quota: N/entitlement remaining (X%) · resets in Xd Xh` line (or the exhaustion-prediction line, or "Unlimited") to both the idle and live-session tooltips.
- **Dashboard provider card** (`DashboardProvider.createPanel(..., copilotQuota)`) - a "Copilot Quota Remaining" card in the Copilot provider tab (`buildProvCards('copilot')` in `dashboard.ts`), alongside the existing token-derived "AI Credits This Month" card. The two cards intentionally sit side by side rather than merging, since they measure different things (real GitHub quota vs. estimated token cost) - see [costEstimation.md](costEstimation.md) gap #1 for why they won't reconcile exactly (no premium-request multiplier accounting yet).
- **Dashboard credits pill** (bottom-right "🐙 ... · login" button) - shows GitHub's live balance as "R / E credits left · X% used" (or "over quota by N" / "unlimited"). Only when the quota fetch failed does it fall back to the local-log estimate, labelled "N credits used (local)". It must never show the local estimate as a bare "N credits": that figure is *spend on this machine this month*, and reads as a zero balance when there are no local Copilot sessions.

The dashboard header also shows a "🐙 Connect GitHub" button (`navTopbarHtml`'s `extraRight` slot) whenever `githubUser` is unset, so connecting doesn't require first navigating to the Pricing tab. It disappears once connected, since the credits pill becomes the connected-state indicator.

## Known limitation carried over

This does **not** close costEstimation.md gap #1 (no per-model premium-request multiplier) on its own - it only surfaces GitHub's own remaining/entitlement counters as-is. A session's *token cost* estimate and the *premium-request quota* shown here remain two different units that won't reconcile 1:1. `computeBudgetPlan()` below (added 2026-08-25) closes the practical side of this gap by letting the user supply their own multiplier.

## Budget Planner (`computeBudgetPlan`)

```ts
function computeBudgetPlan(
  quota: CopilotQuotaView,
  modelMultiplier: number,   // e.g. 0.33 for a cheap model, 1 for default, 3 for an expensive one
  reserveCredits: number,    // credits to leave untouched
): BudgetPlan | null         // { sustainableDailyRequests, sustainableWeeklyRequests, daysRemaining }
```

Pure math: `usable = remaining - reserveCredits`, `daysRemaining` from `quota.resetDays/resetHours` (already computed by `buildQuotaView()`), `sustainableDailyRequests = usable / daysRemaining / modelMultiplier`. Returns `null` for unlimited plans (nothing to plan against). Rendered in [pricingView.md](../webview/pricingView.md)'s new "Real Quota & Budget Planner" section, with the multiplier/reserve config persisted in `context.globalState` under `aiInsights.copilotBudgetPlanner` (chosen over a VS Code setting since it's meant to be a fast in-panel dial, same pattern as `claudeAccountView.ts`'s `WindowConfig`).
