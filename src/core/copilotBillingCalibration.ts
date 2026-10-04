/**
 * Calibration of our cost estimator against GitHub Copilot's own billed cost.
 *
 * Copilot writes `attrs.copilotUsageNanoAiu` on every `llm_request` telemetry event in
 * `debug-logs/<session>/main.jsonl`: the cost GitHub actually billed for that request,
 * in nano-AI-units (1 AIU = 1e9 NanoAiu = 1 AI credit = $0.01). That makes it a
 * ground-truth oracle - our estimate can be checked against it request by request, and
 * the residual ratio folded back into the estimator for every request that has no such
 * field (Copilot sessions predating it, JetBrains, Visual Studio).
 *
 * This module is a dependency-free accumulator so it cannot form an import cycle with
 * `costEstimation.ts`: callers compute both numbers themselves and report the pair.
 * Observations are per-process and accumulate as sessions are parsed - rates drift, so
 * nothing is persisted and nothing is hardcoded from one machine's sample.
 *
 * See `wiki/copilot-billing-calibration.md` for the measurements behind this.
 */
import { normalizeModelName } from './modelNames';

export const NANO_AIU_PER_AIU = 1_000_000_000;

/** Convert Copilot's `copilotUsageNanoAiu` to USD (1 AIU = 1 AI credit = $0.01). */
export function nanoAiuToUsd(nanoAiu: number, usdPerCredit: number): number {
  return (nanoAiu / NANO_AIU_PER_AIU) * usdPerCredit;
}

interface ModelObservation {
  /** Sum of what our estimator predicted, at list rates, in the Copilot billing shape. */
  predictedUsd: number;
  /** Sum of what Copilot actually billed. */
  billedUsd: number;
  samples: number;
}

export interface CalibrationFactor {
  /** Multiply a list-rate estimate by this to match Copilot's billing. */
  factor: number;
  /** How many billed requests the factor was derived from. 0 => `factor` is 1 (unmeasured). */
  samples: number;
  /** Largest single-request deviation from `factor`, as a fraction. 0 for <2 samples. */
  spread: number;
}

const UNMEASURED: CalibrationFactor = { factor: 1, samples: 0, spread: 0 };

const observations = new Map<string, ModelObservation>();
/** Per-model min/max of the per-request ratio, so we can report how stable the factor is. */
const ratioRange = new Map<string, { min: number; max: number }>();
/**
 * Fingerprints already counted. A session's debug log is re-read whenever its file
 * changes, and several session files can resolve to the same log, so the same billed
 * request reaches us repeatedly. Re-counting it would not move the ratio (it is the same
 * ratio again) but would inflate `samples` and make the reported confidence a lie.
 */
const counted = new Set<string>();

/**
 * Record one billed request: what we predicted at list rates (in the Copilot billing
 * shape, i.e. already accounting for fresh tokens billing at the cache-creation rate)
 * against what Copilot billed. Ignores samples that cannot produce a ratio, and ignores
 * a request already counted.
 */
export function observeBilledRequest(model: string, predictedUsd: number, billedUsd: number): void {
  if (!(predictedUsd > 0) || !(billedUsd > 0)) { return; }
  const key = normalizeModelName(model);
  const fingerprint = `${key}|${predictedUsd}|${billedUsd}`;
  if (counted.has(fingerprint)) { return; }
  counted.add(fingerprint);
  const current = observations.get(key) ?? { predictedUsd: 0, billedUsd: 0, samples: 0 };
  current.predictedUsd += predictedUsd;
  current.billedUsd += billedUsd;
  current.samples += 1;
  observations.set(key, current);

  const ratio = billedUsd / predictedUsd;
  const range = ratioRange.get(key);
  ratioRange.set(key, range
    ? { min: Math.min(range.min, ratio), max: Math.max(range.max, ratio) }
    : { min: ratio, max: ratio });
}

/**
 * The correction factor for a model, derived only from this machine's own billed
 * requests. Returns an identity factor with `samples: 0` when nothing was observed -
 * callers must not treat that as a measured result.
 *
 * Measured on one machine (22 requests, `gpt-5.3-codex` and `gpt-5.4`) the factor was
 * 0.9 with a spread of exactly 0, i.e. Copilot bills OpenAI models at 0.9x the
 * published rates. That number is deliberately NOT a default here: a rate observed on
 * one account is not a rate, and an unmeasured estimate should say so instead of
 * quietly applying someone else's discount.
 */
export function getCalibrationFactor(model: string): CalibrationFactor {
  const key = normalizeModelName(model);
  const observed = observations.get(key);
  if (!observed || observed.predictedUsd <= 0) { return UNMEASURED; }
  const range = ratioRange.get(key);
  const factor = observed.billedUsd / observed.predictedUsd;
  const spread = range && observed.samples > 1 ? range.max - range.min : 0;
  return { factor, samples: observed.samples, spread };
}

/** Everything observed so far, for the diagnostics view. */
export function calibrationSnapshot(): Array<{ model: string } & CalibrationFactor> {
  return [...observations.keys()]
    .map(model => ({ model, ...getCalibrationFactor(model) }))
    .sort((a, b) => b.samples - a.samples);
}

/**
 * Drop all observations. Used by tests; not called during a refresh - the calibration is
 * monotonic on purpose, so a refresh that re-reads nothing still has the factors earlier
 * refreshes measured.
 */
export function resetCalibration(): void {
  observations.clear();
  ratioRange.clear();
  counted.clear();
}
