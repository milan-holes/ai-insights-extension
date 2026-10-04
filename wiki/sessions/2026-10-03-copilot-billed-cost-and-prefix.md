# Session: Exact Copilot billed cost, pricing calibration, and prompt-prefix attribution - 2026-10-03

Three data sources Copilot already writes to disk were going unread. This session reads
two of them and builds the coaching layer on the third.

## What was done

### 1. Pricing calibration against GitHub's own billed cost

`copilotUsageNanoAiu` was never read. Comparing it against our estimator on all 25
billed requests on this machine exposed **two separate biases that were partly
cancelling** (aggregate error looked like a mild +5.2%):

| Model | n | est/actual min | max | spread |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.3-codex` | 15 | 1.1111 | 1.1111 | **0.0000** |
| `gpt-5.4` | 7 | 1.1111 | 1.1111 | **0.0000** |
| `claude-sonnet-4.6` | 3 | 0.8045 | 0.9834 | 0.1789 |

- **A flat rate difference on OpenAI models.** Zero spread across 22 requests spanning
  16K-71K input and 0-98% cache rates; `1.1111… = 10/9`, so Copilot bills exactly 0.9x
  our listed rates.
- **A billing-shape error on Anthropic models.** Copilot always writes the uncached
  prefix to cache, so every non-cached input token bills at the **cache-creation** rate
  (3.75) not the input rate (3.00). Verified exactly: `21,108 x 3.75 + 121 x 15 =
  $0.08097`, the billed figure to the cent.

Both folded into `calculateCostBreakdown()` via a new `copilot` billing shape plus a
runtime-derived per-model factor. Together they reproduce GitHub's billing on all 25
requests to **0.0009%** (the residual is nanoAiu's own integer rounding). Running
against real logs, the extension re-derives the 0.9000x factor itself with a spread of
~1e-16.

### 2. Exact billed cost + provenance labels

`Interaction.billedCostUsd` now carries GitHub's figure per turn, and a `CostSource`
(`billed` / `calibrated` / `estimated`) travels with every rolled-up cost through
`Session`, `ProviderMetrics` and `AggregatedMetrics`. Surfaced as a badge + label on the
dashboard credits card and the Copilot screen, plus a "Where this cost number comes
from" section showing the billed share and the live calibration table.

### 3. Prompt-prefix attribution from the sidecars

`tools_N.json` / `system_prompt_N.json` were never read. Across the three sessions on
this machine with readable sidecars: ~28.7K tokens of fixed prefix per request, 90
distinct tools offered, **8 ever called**, ~17.5K tokens per request of tool schema the
model could not use. Rendered as a **Fixed Prompt Overhead** dashboard section with the
never-called tool list.

## Files changed

- [`src/core/copilotBillingCalibration.ts`](../../src/core/copilotBillingCalibration.ts) - new: billed-cost oracle, per-model factor + spread
- [`src/core/copilotPrefix.ts`](../../src/core/copilotPrefix.ts) - new: sidecar parsing, tool-catalog attribution
- [`src/core/modelNames.ts`](../../src/core/modelNames.ts) - new: `normalizeModelName()` extracted here to break an import cycle
- [`src/core/costEstimation.ts`](../../src/core/costEstimation.ts) - `BillingShape`, `CostOptions`, `resolveInteractionCost()`, `billingShapeFor()`, `weakestCostSource()`; breakdown gained `costSource`/`calibrationFactor`/`calibrationSamples`
- [`src/core/sessionAggregator.ts`](../../src/core/sessionAggregator.ts) - cost now resolved per interaction (billed over estimated, correct shape per provider); `computePromptPrefixSummary()`; daily series uses the same resolution so it sums to the period totals
- [`src/providers/copilot.ts`](../../src/providers/copilot.ts) - reads `copilotUsageNanoAiu`, feeds the calibration, `resolveCopilotSessionCost()`, `readSessionPromptPrefix()`; corrected the stale comment claiming Copilot cache writes "aren't billed or reported separately"
- [`src/types.ts`](../../src/types.ts) - `CostSource`, `PromptPrefixBreakdown`, `PromptPrefixSummary`; new fields on `Interaction`, `Session`, `ProviderMetrics`, `AggregatedMetrics`
- [`src/webview/navShared.ts`](../../src/webview/navShared.ts) - `costSourceBadge()` / `costSourceLabel()`
- [`src/webview/dashboard.ts`](../../src/webview/dashboard.ts) - provenance on the credits card, Fixed Prompt Overhead section (Copilot view)
- [`src/webview/pricingView.ts`](../../src/webview/pricingView.ts) - provenance badge, cost-accuracy section with the calibration table
- [`src/electron/renderer.ts`](../../src/electron/renderer.ts) - provenance suffix on the standalone app's cost cards, with a local helper (importing `webview/navShared` would pull `vscode` into the Electron host)
- [`test/copilotBilling.test.ts`](../../test/copilotBilling.test.ts), [`test/copilotPrefix.test.ts`](../../test/copilotPrefix.test.ts) - new
- [`test/providers.test.ts`](../../test/providers.test.ts), [`test/sessionAggregator.test.ts`](../../test/sessionAggregator.test.ts), [`test/helpers.ts`](../../test/helpers.ts) - end-to-end billed-cost + prefix coverage, rollup coverage

50 tests pass (was 29).

## Decisions made

- **Calibrated the estimator rather than only displaying the billed number.** Reading
  nanoAiu fixes only requests that have it; calibrating against it also fixes sessions
  that predate the field and providers that never write it, and makes the 69-model
  pricing table regression-testable against real billed cost. `test/copilotBilling.test.ts`
  pins 11 real billed requests for exactly that reason.
- **The measured 0.9x is deliberately NOT a shipped default.** A rate observed on one
  account is not a rate. With no billed request to learn from, the factor is 1 and the
  figure is labelled `estimated` rather than quietly applying this machine's discount.
  The Anthropic cache-creation rule *is* applied unconditionally - that is a billing
  shape with a mechanical explanation, verified exact, not a rate guess.
- **The Copilot shape is scoped to `provider === 'copilot'`.** `jetbrainsAI` and
  `visualStudio` go through the same GitHub billing but report no cache counts, so their
  `cacheReadTokens: 0` means "not reported", not "not cached" - applying the shape would
  charge their entire input at the cache-creation rate.
- **"Used tools" is read from the debug log's `tool_call` events, not from
  `Interaction.toolCalls`.** Caught by verifying against real data: one Copilot session
  is written to several files, and after `dedupeSessions()` the surviving variant
  sometimes has no tool calls at all - which made all 90 tools look never-used. The log
  sits next to the sidecars and is authoritative; the two sources are unioned so that
  *used* is easy to establish and *never-used* is the claim that is hard to make.
- **Observations are fingerprinted and never reset mid-refresh.** The parse cache means
  a log is re-read only when it changes, so resetting per refresh would lose factors;
  without fingerprinting, re-reads would inflate the sample count and overstate
  confidence.
- **A session claims `billed` only when every turn had a billed figure.** An agent turn
  fans out into several requests; summing the subset that reported a cost would silently
  under-report the turn.

## Follow-up / known gaps

- **Calibration ordering**: a session parsed before any billed request has been seen is
  costed at list rates and labelled `estimated`; it corrects on the next refresh. A
  two-pass refresh (observe all debug logs, then cost) would make it deterministic.
- The 0.9x factor is proven only for `gpt-5.3-codex` and `gpt-5.4` on one account, and
  the Anthropic rule only for `claude-sonnet-4.6`. Whether 0.9x is a Copilot reseller
  discount or a stale `modelPricing.json` cannot be settled from logs - the runtime
  factor is correct either way, but the pricing table may still be wrong for direct API
  use.
- `cacheWriteTokens` under the Copilot shape is *inferred*, not measured. The OTel route
  (`gen_ai.usage.cache_creation.input_tokens`) would measure it and confirm the rule -
  still unimplemented, and now lower priority since the analytic result is exact.
- Sidecar coverage is 3 of 11 session dirs here, and only the first sidecar pair is read,
  so a session that changed toolsets mid-way is described by the toolset it started with.
- `promptPrefix` is computed per parsed session file, so a session written to two files
  reads its sidecars twice before `dedupeSessions()` discards one.
- Gap #1/#3/#4 in [../core/costEstimation.md](../core/costEstimation.md) stand: exact
  dollar cost still says nothing about premium-request *allowance* consumption, and
  `models.json`'s `multiplier` remains unparsed.
