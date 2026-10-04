# costEstimation

**File**: [src/core/costEstimation.ts](../../src/core/costEstimation.ts)  
**Data**: [src/data/modelPricing.json](../../src/data/modelPricing.json)

Calculates estimated USD cost for a model interaction.

## Public API

```ts
function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens?: number, // default 0
  cacheWriteTokens?: number, // default 0
  options?: { shape?: 'direct' | 'copilot'; calibrate?: boolean },
): number; // USD

// Decides between the provider's own billed figure and our estimate. The single
// place that choice is made, so parsers and the aggregator cannot drift apart.
function resolveInteractionCost(provider: ProviderId, interaction): {
  usd: number;
  source: 'billed' | 'calibrated' | 'estimated'; // local models: 'billed', usd 0
  breakdown?: CostBreakdown;
};

function billingShapeFor(provider: ProviderId): 'direct' | 'copilot';
function weakestCostSource(sources: Iterable<CostSource>): CostSource;
```

## Pricing lookup - findModelPricingEntry()

Exported (not private) so [[contextWindow]] resolves `contextWindowTokens` through
exactly the same matching as prices. After dropping any `<vendor>/` prefix and
`normalizeModelName()`:

1. **Local models never match** (see [Model hosting](#model-hosting)) - returns `null`.
2. **Exact match** on the normalized name.
3. **Whole-name match, longest key wins** - a key counts only where it starts the id or
   follows `.` `/` `:`, and is followed by the end or `-` `.` `:` `@`.

| Model id | Key | Why |
| --- | --- | --- |
| `gpt-4o-mini-2024-07-18` | `gpt-4o-mini` | longest key wins (was `gpt-4o`, the first key in table order) |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | `claude-sonnet-4.5` | `.` before, `-` after |
| `claude-sonnet-4.7` (not in table) | `claude-sonnet-4` | `.` after the key is a boundary |
| `qwen-gpt-4o-distill` | none | `-` before the key is not a boundary (was `gpt-4o`) |

A provider-billed model with no match falls back to `$2 / 1M input · $8 / 1M output`
(`pricingSource: 'fallback'`).

Checked on 98 model names (every table key plus dated, Bedrock-style, display-name and
`copilot/` variants): only the two `*-mini-<date>` ids changed key, both from the full
model to the correct `-mini` entry.

## Model hosting

[src/core/modelNames.ts](../../src/core/modelNames.ts) `modelHosting(model)` reads the
`<vendor>/` prefix VS Code puts on chat model ids. `calculateCostBreakdown()` and
`resolveInteractionCost()` apply it for every caller, so the budget, replay and
prompt-history views get the same answer without changes.

| Hosting | Vendor prefix | Cost | `pricingSource` |
| --- | --- | --- | --- |
| `provider` | none, `copilot/`, `github-copilot/` | the session's billing shape | `official` / `fallback` |
| `local` | `ollama`, `lmstudio`, `llamacpp`, `customoai`, `vllm`, `localai`, `foundrylocal`, `jan`, `local` | **$0**, cost source `billed` (exact) | `local` |
| `byok` | any other (`anthropic/`, `openrouter/`, a third-party model extension) | vendor list rate, `direct` shape, no Copilot calibration; **$0** if not in the table | `official` / `unpriced` |

`customoai` is VS Code's "OpenAI Compatible" endpoint, the usual way to attach a
llama.cpp, vLLM or LocalAI server. The session log does not store the endpoint URL, so
a hosted service configured through it is also counted as local.

### normalizeModelName()

**Lives in** [src/core/modelNames.ts](../../src/core/modelNames.ts), re-exported from
here so existing importers are unaffected. It was split out so
[[copilotBillingCalibration]] can key models identically without importing this module,
which imports it back.


| Step | Example |
| ---- | ------- |
| lowercase, trim, `_`/whitespace → `-` | `Claude_Opus 5` → `claude-opus-5` |
| strip a trailing 8-digit date snapshot | `claude-haiku-4-5-20251001` → `claude-haiku-4-5` |
| dash-separated minor version → dot | `claude-opus-4-8` → `claude-opus-4.8`, `claude-3-5-sonnet` → `claude-3.5-sonnet` |

The last step matters because provider APIs dash-separate the minor version
while the pricing keys use a dot, so a raw API id such as `claude-opus-4-8`
matched **no** key and silently fell back to the $2/$8 default rates.

## Cost formula

### `direct` shape (default) - the provider bills us at its published rates

```
cost = (uncachedInput × inputRate)
     + (cacheReadTokens × cachedInputRate)
     + (cacheWriteTokens × cacheCreationRate)
     + (outputTokens × outputRate)
```

Where `uncachedInput = inputTokens - cacheReadTokens - cacheWriteTokens`. Used by
Claude Code and Codex, which report real `cacheWriteTokens` themselves.

### `copilot` shape - routed through GitHub Copilot

```
fresh     = max(0, inputTokens − cacheReadTokens)
freshRate = cacheCreationCostPerMillion ?? inputCostPerMillion

cost = factor × ( fresh × freshRate
                + cacheReadTokens × cachedInputCostPerMillion
                + outputTokens × outputCostPerMillion )
```

Two differences, both **measured** against GitHub's own billed cost rather than assumed
(see [copilot-billing-calibration.md](../copilot-billing-calibration.md)):

1. **Every non-cached input token bills at the cache-creation rate.** Copilot always
   writes the uncached prefix to the prompt cache. For Anthropic models that is 1.25x
   input, and we previously under-reported those requests by up to 20%. Copilot's logs
   carry no separate write count, so the write is inferred from
   `inputTokens - cachedTokens` rather than measured - hence `cacheWriteTokens` is
   ignored under this shape.
2. **`factor`** is the per-model correction from [[copilotBillingCalibration]], derived
   from this machine's own billed requests. It is `1` when nothing has been measured; no
   factor is ever assumed.

Validated end to end: the shape plus the factor reproduces GitHub's billing on all 25
measured requests to **0.0009%**.

Only `provider === 'copilot'` gets this shape. `jetbrainsAI` and `visualStudio` are
billed the same way by GitHub but report no cache counts at all - their
`cacheReadTokens` is 0 because nothing was *reported*, not because nothing was cached,
and charging their whole input at the cache-creation rate would overstate them badly.

## Cost provenance

`CostSource` ([src/types.ts](../../src/types.ts)) travels with every rolled-up figure:

| Source | Meaning |
| --- | --- |
| `billed` | Read from GitHub's own billing record (`copilotUsageNanoAiu`). Exact. |
| `calibrated` | Our estimate, scaled by a factor measured against billed requests. |
| `estimated` | Our estimate at list rates, with nothing to check it against. |

`weakestCostSource()` rolls several up, so a total is only called `billed` when nothing
in it had to be estimated. Surfaced as a badge and label on the dashboard credits card
and the Copilot screen (`costSourceBadge()` / `costSourceLabel()` in
[webview/navShared.ts](../../src/webview/navShared.ts)).

## Adding a new model

Add an entry to `src/data/modelPricing.json` under `pricing`:

```json
"model-key": {
  "inputCostPerMillion": 3.0,
  "outputCostPerMillion": 15.0,
  "cachedInputCostPerMillion": 0.3,
  "cacheCreationCostPerMillion": 3.75,
  "contextWindowTokens": 1000000
}
```

`contextWindowTokens` is optional and documented in [[contextWindow]]; omit it
when the vendor publishes no window and resolution falls back to the default.

The key should be the shortest unambiguous prefix of the model ID string Claude Code / Copilot reports (e.g. `claude-sonnet-4`, not the full datestamped ID).

### Key order no longer matters

Matching picks the longest whole-name key, so `claude-opus-5.5-<date>` resolves to
`claude-opus-5.5` wherever it sits relative to `claude-opus-5`. (It used to take the
first key the id contained, which made JSON order load-bearing and priced
`gpt-5.4-mini-<date>` as `gpt-5.4`.)

### Supported `provider` values

`openai`, `anthropic`, `google`, `xai`, `moonshot`, `github`, `microsoft`. The first five are rendered by [pricingView.ts](../../src/webview/pricingView.ts)'s hardcoded `providerOrder`; `github` (`raptor-mini`) and `microsoft` (`mai-code-*`) entries are priced correctly by `calculateCost()` but are silently omitted from the Pricing panel's table.

## GitHub Copilot "AI Credits": known gaps to reliable numbers (added 2026-07-05)

`calculateAICredits()` (and every "AI Credits" figure shown in `dashboard.ts`/`pricingView.ts`) is `tokenCostUsd / $0.01` - a unit conversion of the token-based cost formula above, using [modelPricing.json](../../src/data/modelPricing.json)'s per-model $/1M rates (sourced from GitHub's own "Models & Pricing" docs page). This is a reasonable proxy, but it is **not** the same thing as GitHub's real billing/quota mechanism for Copilot chat, and the gap matters for anyone trying to reconcile these numbers against an actual bill or plan allowance:

### 1. No premium-request multiplier accounting (the main gap)

GitHub's actual Copilot Pro/Business/Enterprise plans meter chat/agent usage as **premium requests**: each request counts as `1 × a per-model multiplier` against a monthly included allowance (e.g. Pro: 300/month), not as raw token volume. Two sessions with the same number of requests but very different token counts consume identical real quota if they use the same model; our token-derived "credits" figure would show very different numbers for them. There is currently no multiplier field or logic anywhere in this codebase (`grep -rn multiplier src` turns up nothing) - `calculateAICredits()` has no way to represent "this session used N premium requests," only "this session used N tokens at $X/1M."

### 2. `debug-logs/{sessionId}/models.json` already discovered, not parsed

Per [providers/copilot.md](../providers/copilot.md), this file - sitting right next to the `main.jsonl` telemetry `attachRealCacheData()` already reads - is a snapshot of GitHub's own model catalog **including `billing.is_premium` and `multiplier` per model**, as of that session's start. This is the most direct fix for gap #1: for any session with debug logging enabled, GitHub's own real multiplier is sitting on disk, unused. Not implemented; flagged in the provider doc so it isn't rediscovered from scratch.

### 3. Real quota-consumed endpoint never called

`GET /users/{user}/settings/billing/usage` (personal accounts only) returns the actual premium-request quota consumed this cycle - already documented in `providers/copilot.md`'s API table as available, but [githubAuth.ts](../../src/core/githubAuth.ts) never calls it. It only fetches `/user` for the plan name, then looks up a **hardcoded flat dollar figure** per plan (`PLAN_BUDGET`: free `$0`, pro `$10`, team `$19`, enterprise `$39`) to use as a "budget" ceiling.

> **Partially addressed 2026-07-08**: [copilotQuota.md](copilotQuota.md) now calls a *different* internal endpoint (`copilot_internal/user`, works for personal and org seats alike, unlike the personal-only endpoint above) and shows the real `premium_interactions` remaining/entitlement/reset-date as its own "Copilot Quota Remaining" card, separate from the token-derived "AI Credits" card. This still doesn't touch `PLAN_BUDGET`'s flat-subscription-price budget math (gap #4) or add multiplier accounting (gap #1) - it's a second, independent real-data source sitting next to the estimate, not a replacement for it.

### 4. "Budget" is the subscription price, not the real premium-request allowance

This is the most user-visible consequence of #1 and #3 together: `PLAN_BUDGET` is literally each plan's advertised **monthly subscription cost**, not the dollar value of its included premium-request quota. The dashboard's budget/overage-risk widgets compare token-derived estimated cost against that subscription price. A user comfortably within their real 300/month premium-request allowance could still show as "over budget" here purely because token-derived $ cost exceeds the subscription price - even though nothing extra is actually owed. Conversely a user who has genuinely burned through their allowance and is being billed real overage might show as "under budget" if their token cost happens to be cheap-per-token but request-heavy. The two numbers (token-derived cost vs. subscription price) aren't measuring the same thing.

### 5. No concept of quota-free usage

Every entry in `modelPricing.json` carries nonzero $/1M rates - there's no "this model/action doesn't consume any premium-request quota under your plan" case, even though code completions and certain base-model chat interactions are effectively unlimited/free for many plans. Free-plan users (`PLAN_BUDGET.free = 0`) will always appear "over budget" the moment any token usage is recorded at all, which is a display artifact of the model, not a real overage.

### 6. Pricing table is a manually-maintained snapshot, no drift detection

`modelPricing.json`'s `metadata.lastUpdated` is a manual timestamp; nothing cross-checks it against the real, per-session model catalog GitHub already ships in `models.json` (see #2) to flag when a model's rate or multiplier has actually changed upstream.

### 7. Cache "savings" DO correspond to a real dollar difference (resolved 2026-10-03)

Previously flagged here as unverified - the worry being that if GitHub bills a flat
per-request multiplier regardless of cache state, the Cache Efficiency "Cache Savings"
figure would describe no real money.

**It describes real money.** `copilotUsageNanoAiu` is GitHub's own charge per request,
and it moves with cache state. Two `gpt-5.3-codex` requests on the same machine:

| input | cached | output | billed credits |
| ---: | ---: | ---: | ---: |
| 31,703 | 8,704 | 304 | 4.142 |
| 35,372 | 31,872 | 499 | 1.682 |

A **2.46x** difference, with the cheaper request having the *larger* input. Billing is
token-based and cache-sensitive, not flat per request. The savings figure is sound in
kind; its accuracy now rests on the calibrated formula above rather than on list rates.

### Update (2026-10-03): absolute figures are now exact where a debug log exists

Gaps #1-#6 below concern the *estimate*. They are largely moot for any request whose
debug log carries `copilotUsageNanoAiu`, because that **is** GitHub's own charge - not a
proxy for it. Those requests are reported verbatim and labelled `billed`; everything
else is estimated with the calibrated formula and labelled accordingly, so the two are
never mixed silently. What remains genuinely unresolved is the **premium-request
allowance** side (gaps #1, #3, #4): knowing the exact dollar cost of a request still
does not tell us how much of a 300-requests/month entitlement it consumed, and
`models.json`'s `multiplier` field (gap #2) is still unparsed.

**Bottom line**: the token-based cost/credits numbers are internally consistent and useful for *relative* comparison (which sessions/models/repos are more expensive than others, trends over time), and the per-token rates themselves are sourced from GitHub's own published pricing page. But nothing in this pipeline currently models GitHub's premium-request-multiplier quota system, so the absolute "credits used" and "over/under budget" figures should not be presented as authoritative against an actual GitHub invoice without the fixes above (particularly #2 and #3, both of which have a concrete, already-identified data source sitting unused).
