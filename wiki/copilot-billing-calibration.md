# Copilot billing calibration — `copilotUsageNanoAiu` as ground truth

`attrs.copilotUsageNanoAiu` in `debug-logs/<session>/main.jsonl` is GitHub's **own
billed cost** for a request (1 AIU = 1e9 NanoAiu = 1 AI credit ≈ $0.01). It is a
**ground-truth oracle**: our estimator can be checked against it request by request.

Doing that on every nanoAiu-bearing request on one machine reproduces Copilot's
billing to **0.0009%** — i.e. the formula below is almost certainly *the* formula.

- Sample: 25 requests, 3 models, 11 session dirs
  (`~/.vscode-server/data/User/workspaceStorage/*/GitHub.copilot-chat/debug-logs/*/main.jsonl`)
- Coverage: **25/25 token-bearing requests carry the field.** The 7 log files without
  it contain no LLM requests at all.

## What our current estimator gets wrong

[`calculateCostBreakdown()`](../src/core/costEstimation.ts) vs actual billed cost:

| Model | n | est/actual min | max | spread |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.3-codex` | 15 | 1.1111 | 1.1111 | **0.0000** |
| `gpt-5.4` | 7 | 1.1111 | 1.1111 | **0.0000** |
| `claude-sonnet-4.6` | 3 | 0.8045 | 0.9834 | 0.1789 |

Aggregate error is a deceptively mild **+5.2%**, because two opposite biases partly
cancel. They are different bugs:

### Bias 1 — OpenAI rates are uniformly 1.1111× too high

Zero spread across 22 requests spanning 16K–71K input and 0–98% cache hit rates. A
constant ratio under that much variation can only be a **flat rate error**, not a
cache-accounting error. `1.1111… = 10/9`, so Copilot bills exactly **0.9×** our listed
rates:

| Model | our rates (in / cached / out) | implied Copilot rates |
| --- | --- | --- |
| `gpt-5.3-codex` | 1.75 / 0.175 / 14.00 | 1.575 / 0.1575 / 12.60 |
| `gpt-5.4` | 2.50 / 0.250 / 15.00 | 2.250 / 0.2250 / 13.50 |

> Whether this is a Copilot reseller discount or a stale `modelPricing.json` cannot be
> settled from logs alone. It does not matter for the fix: either way the correction is
> a per-provider factor derived from nanoAiu, and nanoAiu is authoritative.

### Bias 2 — Anthropic non-cached input is billed at the cache-**creation** rate

The Claude spread is not noise. Copilot always writes the uncached prefix to the
prompt cache, so **every non-cached input token bills at `cacheCreationCostPerMillion`
(3.75 = 1.25× input), never at `inputCostPerMillion` (3.00)**. We bill it at 3.00 and
treat cache-write as 0, so we under-report — worst when the cache is cold:

| input | cacheRead | fresh | output | actual $ | our est $ | err |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 21,108 | 0 | 21,108 | 121 | 0.08097 | 0.06514 | **−20%** |
| 21,416 | 14,612 | 6,804 | 49 | 0.03063 | 0.02553 | −17% |
| 21,264 | 21,105 | 159 | 15 | 0.00715 | 0.00703 | −2% |

Check on row 1 (pure cache miss): `21,108 × 3.75 + 121 × 15 = $0.08097` — exact.
Row 2: `14,612 × 0.3 + 6,804 × 3.75 + 49 × 15 = $0.03063` — exact. Row 3: `$0.0071527`
vs `$0.00715` — exact. No discount applies to Anthropic (factor 1.0).

## The calibrated formula

```
fresh      = max(0, inputTokens − cachedTokens)
freshRate  = cacheCreationCostPerMillion ?? inputCostPerMillion
discount   = provider === 'openai' ? 0.9 : 1.0

cost = discount × (fresh × freshRate
                 + cachedTokens × cachedInputCostPerMillion
                 + outputTokens × outputCostPerMillion) / 1e6
```

Validated against all 25 requests:

| Model | n | max abs error | total error |
| --- | ---: | ---: | ---: |
| `gpt-5.3-codex` | 15 | 0.0000% | 0.0000% |
| `gpt-5.4` | 7 | 0.0000% | −0.0000% |
| `claude-sonnet-4.6` | 3 | 0.0105% | +0.0044% |
| **all** | **25** | — | **+0.0009%** |

Residual is nanoAiu's own integer rounding.

## Why this beats simply displaying nanoAiu

Reading nanoAiu fixes only requests that have it. Calibrating the *estimator* against
nanoAiu fixes cost for:

- Copilot sessions from before the field existed, and any provider/IDE that never
  writes it (JetBrains, Visual Studio);
- every downstream surface that consumes `calculateCost()` — dashboard, pricing view,
  [core/budgetManager.md](core/budgetManager.md), [core/copilotQuota.md](core/copilotQuota.md),
  ROI and anomaly metrics;
- the 69-model pricing table itself, which can now be **regression-tested** against
  real billed cost instead of trusted.

So the two should ship together: exact nanoAiu where present, calibrated estimate
elsewhere, each labelled by provenance (`billed` vs `calibrated` vs
`estimated`), and a literal `unknown` wherever the log is silent rather than a
quietly-derived stand-in.

## Caveats

- One machine, 25 requests, 3 models, one Copilot version (`0.55.0` / VS Code
  `1.127.0`). The 0.9 factor is proven only for `gpt-5.3-codex` and `gpt-5.4`; do not
  extrapolate to other OpenAI models or other providers without the same check.
- `cachedTokens` is cache **reads** only. The Anthropic rule above infers cache writes
  rather than measuring them; the OTel route
  (`gen_ai.usage.cache_creation.input_tokens`) would measure them directly and is the
  way to confirm it.
- Rates drift. The calibration factor should be **derived at runtime** from whatever
  nanoAiu the user's own logs contain, not hardcoded from this sample.

## Reproducing

The calibration is a pure function of four log fields (`model`, `inputTokens`,
`cachedTokens`, `outputTokens`) plus `copilotUsageNanoAiu`. Any session dir with
LLM requests is enough to re-derive the per-model ratio.
