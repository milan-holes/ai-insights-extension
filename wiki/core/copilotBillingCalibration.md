# copilotBillingCalibration

**File**: [src/core/copilotBillingCalibration.ts](../../src/core/copilotBillingCalibration.ts)  
**Measurements**: [copilot-billing-calibration.md](../copilot-billing-calibration.md)

Uses GitHub's own billed cost as a ground-truth oracle for our cost estimator.

## Why

Copilot writes `attrs.copilotUsageNanoAiu` on every `llm_request` event in
`debug-logs/<session>/main.jsonl`: the cost GitHub actually billed for that request.
1 AIU = 1e9 NanoAiu = 1 AI credit = $0.01. On the measured machine **every**
token-bearing request carried it.

That lets our estimate be checked request by request, and the residual ratio folded
back into the estimator for every request that has *no* such field - sessions
predating it, and the JetBrains / Visual Studio providers which never write it.

## Public API

```ts
function nanoAiuToUsd(nanoAiu: number, usdPerCredit: number): number;

// Record one billed request: our list-rate prediction vs what GitHub charged.
function observeBilledRequest(model: string, predictedUsd: number, billedUsd: number): void;

function getCalibrationFactor(model: string): {
  factor: number;   // multiply a list-rate estimate by this
  samples: number;  // 0 => nothing measured; factor is 1
  spread: number;   // max - min per-request ratio; 0 for <2 samples
};

function calibrationSnapshot(): Array<{ model: string } & CalibrationFactor>;
function resetCalibration(): void; // tests only
```

## Design notes

| Decision | Why |
| --- | --- |
| Dependency-free accumulator (callers pass both numbers) | Keeps an import cycle with [[costEstimation]] impossible; it only imports `modelNames`. |
| **No hardcoded default factor** | The measured 0.9x for OpenAI models came from one machine. A rate observed on one account is not a rate - an unmeasured estimate reports `estimated` rather than quietly applying someone else's discount. |
| Observations are fingerprinted (`model|predicted|billed`) | A session's debug log is re-read whenever the file changes, and several session files resolve to the same log. Re-counting would not move the ratio but would inflate `samples` and make the reported confidence a lie. |
| Monotonic - never reset during a refresh | The parse cache means a refresh may re-read nothing; the factors earlier refreshes measured must survive. |
| `spread` is reported alongside `factor` | A spread of 0 across many requests proves a *rate* difference rather than noise - that is what makes the factor safe to apply. |

## What it measures in practice

| Model | Samples | Factor | Spread |
| --- | ---: | ---: | --- |
| `gpt-5.3-codex` | 15 | 0.9000x | ~1e-16 (exact) |
| `gpt-5.4` | 7 | 0.9000x | ~1e-16 (exact) |
| `claude-sonnet-4.6` | 3 | 1.0000x | exact |

Anthropic needs no rate factor: its whole discrepancy was the billing *shape*
(non-cached input billed at the cache-creation rate), which [[costEstimation]]'s
`copilot` shape handles directly.

## Ordering caveat

Calibration is populated while sessions are parsed, so a session parsed before any
billed request has been seen is costed at list rates and labelled `estimated`. It
corrects itself on the next refresh. The label makes this visible rather than silent;
sessions that have their own billed figure are unaffected either way.
