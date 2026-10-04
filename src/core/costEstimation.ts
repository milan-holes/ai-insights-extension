/**
 * Cost estimation using per-model pricing data.
 */
import pricingData from '../data/modelPricing.json';
import { getCalibrationFactor } from './copilotBillingCalibration';
import { modelHosting, normalizeModelName, stripModelVendor } from './modelNames';
import { CostSource, Interaction, PricingSource, ProviderId } from '../types';

export interface ModelPricingEntry {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
  /** Maximum input context window, when published. See src/core/contextWindow.ts. */
  contextWindowTokens?: number;
}

const pricing = pricingData.pricing as Record<string, ModelPricingEntry>;

export { normalizeModelName };

export const USD_PER_AI_CREDIT = 0.01;
const FALLBACK_INPUT_COST_PER_MILLION = 2;
const FALLBACK_OUTPUT_COST_PER_MILLION = 8;

/**
 * Which billing rules apply.
 *
 * - `direct` - the provider's own published per-token rates, charged as listed. The
 *   caller is expected to supply real `cacheWriteTokens` when the provider reports them
 *   (Claude Code and Codex do).
 * - `copilot` - routed through GitHub Copilot, which bills differently in one verified
 *   way: Copilot always writes the uncached prefix to the prompt cache, so **every
 *   non-cached input token is billed at the cache-creation rate**, not the input rate.
 *   For Anthropic models (cache-creation = 1.25x input) that is a 25% difference on
 *   fresh tokens; we previously under-reported those by up to 20%. Copilot's local logs
 *   report no separate cache-write count, so the write is inferred from
 *   `inputTokens - cachedTokens` rather than measured.
 *
 * Verified against `copilotUsageNanoAiu` on 25 billed requests: the `copilot` shape plus
 * a per-model calibration factor reproduces GitHub's billing to 0.0009%. See
 * `wiki/copilot-billing-calibration.md`.
 */
export type BillingShape = 'direct' | 'copilot';

export interface CostOptions {
  /** Defaults to `direct`. */
  shape?: BillingShape;
  /**
   * Apply the per-model factor measured from this machine's billed requests. Only
   * meaningful with `shape: 'copilot'`; ignored otherwise. Defaults to true.
   */
  calibrate?: boolean;
}

export interface CostBreakdown {
  inputCost: number;
  cachedInputCost: number;
  outputCost: number;
  cacheWriteCost: number;
  totalCost: number;
  inputCostPerMillion: number;
  cachedInputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheCreationCostPerMillion: number;
  pricingSource: PricingSource;
  /** `calibrated` when a measured factor was applied, else `estimated`. Never `billed`. */
  costSource: Exclude<CostSource, 'billed'>;
  /** The calibration factor applied (1 when none was). */
  calibrationFactor: number;
  /** How many billed requests the factor came from. 0 => none measured for this model. */
  calibrationSamples: number;
}

/**
 * Calculate estimated cost for a model interaction.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  options: CostOptions = {},
): number {
  return calculateCostBreakdown(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, options).totalCost;
}

export function calculateCostBreakdown(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  options: CostOptions = {},
): CostBreakdown {
  const hosting = modelHosting(model);
  if (hosting === 'local') { return zeroCostBreakdown('local'); }
  const modelPricing = findModelPricingEntry(model);
  if (hosting === 'byok' && !modelPricing) { return zeroCostBreakdown('unpriced'); }
  const pricingSource = modelPricing ? 'official' : 'fallback';
  const inputCostPerMillion = modelPricing?.inputCostPerMillion ?? FALLBACK_INPUT_COST_PER_MILLION;
  const outputCostPerMillion = modelPricing?.outputCostPerMillion ?? FALLBACK_OUTPUT_COST_PER_MILLION;
  const cachedInputCostPerMillion = modelPricing?.cachedInputCostPerMillion ?? inputCostPerMillion;
  const cacheCreationCostPerMillion = modelPricing?.cacheCreationCostPerMillion ?? inputCostPerMillion;

  // A model on the user's own key is billed by its vendor at list rates, not by GitHub.
  const copilotShape = options.shape === 'copilot' && hosting === 'provider';
  // Under Copilot the prefix is always written to cache, so fresh input bills at the
  // cache-creation rate. Its logs carry no separate write count, so everything not
  // served from cache is the write.
  const uncachedInput = copilotShape
    ? Math.max(0, inputTokens - cacheReadTokens)
    : Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const uncachedRate = copilotShape ? cacheCreationCostPerMillion : inputCostPerMillion;

  const inputCost = (uncachedInput * uncachedRate) / 1_000_000;
  const cachedInputCost = (cacheReadTokens * cachedInputCostPerMillion) / 1_000_000;
  const cacheWriteCost = copilotShape ? 0 : (cacheWriteTokens * cacheCreationCostPerMillion) / 1_000_000;
  const outputCost = (outputTokens * outputCostPerMillion) / 1_000_000;

  const listTotal = inputCost + cachedInputCost + outputCost + cacheWriteCost;

  // Calibration corrects a flat rate discrepancy, so it scales the whole figure. Only
  // Copilot has an oracle to calibrate against.
  const calibration = copilotShape && options.calibrate !== false
    ? getCalibrationFactor(model)
    : { factor: 1, samples: 0 };
  const scale = calibration.samples > 0 ? calibration.factor : 1;

  return {
    inputCost: inputCost * scale,
    cachedInputCost: cachedInputCost * scale,
    outputCost: outputCost * scale,
    cacheWriteCost: cacheWriteCost * scale,
    totalCost: listTotal * scale,
    inputCostPerMillion,
    cachedInputCostPerMillion,
    outputCostPerMillion,
    cacheCreationCostPerMillion,
    pricingSource,
    costSource: calibration.samples > 0 ? 'calibrated' : 'estimated',
    calibrationFactor: scale,
    calibrationSamples: calibration.samples,
  };
}

function zeroCostBreakdown(pricingSource: 'local' | 'unpriced'): CostBreakdown {
  return {
    inputCost: 0,
    cachedInputCost: 0,
    outputCost: 0,
    cacheWriteCost: 0,
    totalCost: 0,
    inputCostPerMillion: 0,
    cachedInputCostPerMillion: 0,
    outputCostPerMillion: 0,
    cacheCreationCostPerMillion: 0,
    pricingSource,
    costSource: 'estimated',
    calibrationFactor: 1,
    calibrationSamples: 0,
  };
}

/**
 * The billing rules that apply to a provider's own sessions.
 *
 * Only `copilot` gets the Copilot shape. The other two GitHub-Copilot-backed providers
 * (`jetbrainsAI`, `visualStudio`) are billed the same way by GitHub, but their logs carry
 * no cache counts at all - `cacheReadTokens` is 0 because nothing was reported, not
 * because nothing was cached. Charging their entire input at the cache-creation rate
 * would overstate them badly, so they stay on the direct shape until they have a cache
 * signal to work from.
 */
export function billingShapeFor(provider: ProviderId): BillingShape {
  return provider === 'copilot' ? 'copilot' : 'direct';
}

/**
 * The cost of one interaction and where that number came from. The single place that
 * decides between GitHub's billed figure and our own estimate, so the session parsers and
 * the aggregator cannot drift apart on it.
 */
export function resolveInteractionCost(
  provider: ProviderId,
  interaction: Pick<Interaction, 'model' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'billedCostUsd'>,
): { usd: number; source: CostSource; breakdown?: CostBreakdown } {
  if (interaction.billedCostUsd !== undefined) {
    return { usd: interaction.billedCostUsd, source: 'billed' };
  }
  // Nobody bills a local model, so its $0 is exact - reporting it as an estimate would
  // downgrade an otherwise fully billed session's cost provenance.
  if (modelHosting(interaction.model) === 'local') {
    return { usd: 0, source: 'billed', breakdown: zeroCostBreakdown('local') };
  }
  const breakdown = calculateCostBreakdown(
    interaction.model,
    interaction.inputTokens,
    interaction.outputTokens,
    interaction.cacheReadTokens,
    interaction.cacheWriteTokens,
    { shape: billingShapeFor(provider) },
  );
  return { usd: breakdown.totalCost, source: breakdown.costSource, breakdown };
}

/** The weakest source among several - what a rolled-up figure can honestly claim. */
export function weakestCostSource(sources: Iterable<CostSource>): CostSource {
  let sawCalibrated = false;
  let sawAny = false;
  for (const source of sources) {
    sawAny = true;
    if (source === 'estimated') { return 'estimated'; }
    if (source === 'calibrated') { sawCalibrated = true; }
  }
  if (!sawAny) { return 'estimated'; }
  return sawCalibrated ? 'calibrated' : 'billed';
}

/**
 * Convert token-priced USD spend to GitHub AI Credits.
 * GitHub defines 1 AI credit as $0.01 USD.
 */
export function calculateAICredits(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
  options: CostOptions = {},
): number {
  return calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, options) / USD_PER_AI_CREDIT;
}

/**
 * Find the pricing-table entry for a model: exact match, else the longest table key that
 * appears in the id as a whole name. Exported so context-window resolution matches model
 * names identically.
 *
 * Local models never match: a local build named after a hosted model (a `kimi-k3` GGUF
 * under Ollama) costs nothing, and its context window is whatever the server was started
 * with, not the hosted model's.
 */
export function findModelPricingEntry(model: string): ModelPricingEntry | null {
  if (modelHosting(model) === 'local') { return null; }
  const normalized = normalizeModelName(stripModelVendor(model));

  if (pricing[normalized]) { return pricing[normalized]; }

  let best: string | null = null;
  for (const key of Object.keys(pricing)) {
    if ((best === null || key.length > best.length) && containsModelKey(normalized, key)) {
      best = key;
    }
  }
  return best === null ? null : pricing[best];
}

/**
 * True when `key` appears in `id` as a whole name: at the start or after a namespace
 * separator (`us.anthropic.claude-...`, `models/gemini-...`), and followed by the end or a
 * suffix separator (`gpt-4o-2024-05-13`, `claude-sonnet-4.7`, `...-v1:0`). A plain
 * substring test priced `qwen-gpt-4o-distill` as gpt-4o, and `gpt-5.4-mini-preview` as
 * gpt-5.4 because that key came first in the table.
 */
function containsModelKey(id: string, key: string): boolean {
  for (let at = id.indexOf(key); at !== -1; at = id.indexOf(key, at + 1)) {
    const before = at === 0 ? '' : id[at - 1];
    const after = id[at + key.length] ?? '';
    if ((before === '' || './:'.includes(before)) && (after === '' || '-.:@'.includes(after))) {
      return true;
    }
  }
  return false;
}
