# Session: Claude live quota, Copilot budget planner, Coach - 2026-08-25

> **Note (2026-08-25, later):** the Coach part of this session was reverted - the panel, its detectors, types, nav tab and command were all removed. See [2026-08-25-remove-coach-tab.md](2026-08-25-remove-coach-tab.md). The Claude live plan-quota and Copilot budget planner work below still stands; the `src/core/coach.ts` / `src/webview/coachView.ts` links no longer resolve.


## What was done

Implemented three of four ranked feature gaps; the fourth (an AI-readiness generator) was dropped per user decision - no LLM call budget to generate credible prose.

- **Claude Code live plan-quota** - zero-config real 5h/7d rate-limit-window % via the OAuth token Claude Code already writes to `~/.claude/.credentials.json`, no login flow of our own. Ships on by default with `aiInsights.providers.claudeCode.liveQuota.enabled` to opt out. Falls back to the pre-existing `calcWindow()` local estimate when unavailable.
- **Copilot budget planner** - `computeBudgetPlan()` closes `copilotQuota.ts`'s own long-standing "no per-model premium-request multiplier" gap. The dedicated Copilot screen (`pricingView.ts`) also now renders the *real* GitHub quota object for the first time - it previously wasn't passed to that screen at all, only to the dashboard's small provider card.
- **Coach** - new "Coach" nav tab: week-over-week trend detectors (context quality, cache hit rate, cost/session, turns/session) plus per-session findings (overpowered model on trivial tasks, tool-call storms, multi-model cache instability), all derived from data already parsed from local session logs - no runtime hooks of any kind, since this extension observes sessions rather than intervening in them.
- Removed dead, unwired "connect Anthropic API key" UI in `claudeAccountView.ts` (`connectedApiSection`/`disconnectedApiSection`/`collapsedApiSection`, flagged in `docs/dead-code-audit.md`) while touching this file's data story anyway.

## Files changed

- [`src/core/claudeQuota.ts`](../../src/core/claudeQuota.ts) - new: OAuth token read + rate-limit header fetch + throttle
- [`src/core/copilotQuota.ts`](../../src/core/copilotQuota.ts) - added `computeBudgetPlan()`
- [`src/core/coach.ts`](../../src/core/coach.ts) - new: trend + finding detectors
- [`src/types.ts`](../../src/types.ts) - added `CoachSeverity`/`CoachFinding`/`CoachWeeklyPoint`/`CoachTrend`/`CoachReport`
- [`src/webview/claudeAccountView.ts`](../../src/webview/claudeAccountView.ts) - live-quota rendering, dead helpers removed, `claudeQuota` param threaded through `createPanel`/`getHtml`/`pushMetrics`
- [`src/webview/pricingView.ts`](../../src/webview/pricingView.ts) - `copilotQuota` param (previously never passed), Real Quota + Budget Planner section, `setPlannerConfig` message handler
- [`src/webview/coachView.ts`](../../src/webview/coachView.ts) - new panel
- [`src/webview/navShared.ts`](../../src/webview/navShared.ts) - `coach` nav tab + `showCoach` command mapping
- [`src/extension.ts`](../../src/extension.ts) - `claudeQuota`/`claudeQuotaLastFetchAt` state, `refreshClaudeQuota()` wired into `refresh()`, `showCoach()`, `getCopilotQuotaView()` now passed into `showPricing()`
- [`package.json`](../../package.json) - `aiInsights.providers.claudeCode.liveQuota.enabled` setting, `aiInsights.showCoach` command

## Decisions made

- Claude live-quota fetch ships **on by default** (not behind a one-time consent prompt like the Copilot debug-log toggle) - it's a 1-token read-only ping reusing credentials that already exist, not a new login flow or a setting that changes how a third-party tool writes data to disk. User explicitly chose this over an opt-in prompt.
- Budget planner config lives in `context.globalState`, not a VS Code setting - meant to be a fast in-panel dial, mirroring `claudeAccountView.ts`'s existing `WindowConfig` pattern rather than adding new `package.json` settings for something users will tweak often.
- Coach implements only what's honestly derivable from finished session logs (no error/retry field exists on `Interaction`, so "tool-call storm" is a repetition-count proxy, clearly labeled as such in the wiki doc) - live interception via editor hooks is out of scope for a passive VS Code extension.
- AI-readiness generator (originally gap #3) dropped entirely per user decision after clarifying that "skip this" meant the whole feature, not just its PR-comment-mining sub-part.

## Follow-up / known gaps

- `PricingViewProvider`'s `setPlannerConfig` handler does a full `panel.webview.html` reassignment rather than a surgical `postMessage` update (no CSP-nonce/partial-update precedent existed in this file before now).
- Coach's week buckets are anchored to `now`, not calendar weeks - a run near a week boundary can shift a session between buckets on a later run.
- `jest` is referenced in `package.json`'s `test` script but isn't installed in this environment (`node_modules/.bin/jest` missing) - pre-existing, unrelated to this session; `npm run compile` (tsc + esbuild) is the verification that ran.
