/**
 * Cost estimation using per-model pricing data.
 */
import pricingData from '../data/modelPricing.json';

const pricing = pricingData.pricing as Record<string, {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
}>;

export const USD_PER_AI_CREDIT = 0.01;
const FALLBACK_INPUT_COST_PER_MILLION = 2;
const FALLBACK_OUTPUT_COST_PER_MILLION = 8;

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
  pricingSource: 'official' | 'fallback';
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
): number {
  return calculateCostBreakdown(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens).totalCost;
}

export function calculateCostBreakdown(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number = 0,
  cacheWriteTokens: number = 0,
): CostBreakdown {
  const modelPricing = findModelPricing(model);
  const pricingSource = modelPricing ? 'official' : 'fallback';
  const inputCostPerMillion = modelPricing?.inputCostPerMillion ?? FALLBACK_INPUT_COST_PER_MILLION;
  const outputCostPerMillion = modelPricing?.outputCostPerMillion ?? FALLBACK_OUTPUT_COST_PER_MILLION;
  const cachedInputCostPerMillion = modelPricing?.cachedInputCostPerMillion ?? inputCostPerMillion;
  const cacheCreationCostPerMillion = modelPricing?.cacheCreationCostPerMillion ?? inputCostPerMillion;

  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const inputCost = (uncachedInput * inputCostPerMillion) / 1_000_000;
  const cachedInputCost = (cacheReadTokens * cachedInputCostPerMillion) / 1_000_000;
  const cacheWriteCost = (cacheWriteTokens * cacheCreationCostPerMillion) / 1_000_000;
  const outputCost = (outputTokens * outputCostPerMillion) / 1_000_000;

  return {
    inputCost,
    cachedInputCost,
    outputCost,
    cacheWriteCost,
    totalCost: inputCost + cachedInputCost + outputCost + cacheWriteCost,
    inputCostPerMillion,
    cachedInputCostPerMillion,
    outputCostPerMillion,
    cacheCreationCostPerMillion,
    pricingSource,
  };
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
): number {
  return calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) / USD_PER_AI_CREDIT;
}

/**
 * Find pricing for a model, trying exact match then prefix matching.
 */
function findModelPricing(model: string): typeof pricing[string] | null {
  const normalized = normalizeModelName(model);

  // Exact match
  if (pricing[normalized]) { return pricing[normalized]; }

  // Model name contains a known key (e.g. "gpt-4o-2024-05-13" contains "gpt-4o")
  for (const key of Object.keys(pricing)) {
    if (normalized.includes(key)) {
      return pricing[key];
    }
  }

  // Prefix match (e.g., "claude-sonnet-4-20260514" -> "claude-sonnet-4")
  for (const key of Object.keys(pricing)) {
    if (normalized.startsWith(key)) {
      return pricing[key];
    }
  }

  return null;
}

function normalizeModelName(model: string): string {
  return model
    .toLowerCase()
    .trim()
    .replace(/_/g, '-')
    .replace(/\s+/g, '-');
}
