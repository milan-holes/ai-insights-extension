/**
 * Per-model context-window resolution.
 *
 * Context-window sizes live alongside prices in `src/data/modelPricing.json`
 * (`contextWindowTokens`) so there is exactly one table to update when a model
 * ships. Everything that needs "how full is the context window" — the status
 * bar, context runway, lost-in-the-middle risk, the token calculator — resolves
 * through here instead of hardcoding a limit.
 *
 * Resolution order: user override -> model table -> DEFAULT_CONTEXT_WINDOW_TOKENS.
 *
 * The override exists because a model's maximum window is not always the window
 * a given user actually gets: the 1M window on Claude Sonnet / Opus is a gated
 * opt-in, and nothing in the session logs records whether it is active. Model ID
 * alone would over-report headroom for users who are not on it.
 */
import { Session } from '../types';
import { findModelPricingEntry } from './costEstimation';

/** Used when a model publishes no window and the user set no override. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Smallest override we accept — below this every metric degenerates. */
const MIN_OVERRIDE_TOKENS = 1_000;

export type ContextWindowSource = 'override' | 'model' | 'default';

export interface ResolvedContextWindow {
  tokens: number;
  source: ContextWindowSource;
  /** Model the window was resolved from, when source is 'model'. */
  model?: string;
}

/** Claude Code writes this in place of a model on synthetic/meta turns. */
const SYNTHETIC_MODEL = '<synthetic>';

let overrideTokens: number | undefined;

/**
 * Set the user's `aiInsights.context.limitTokens` override. Called on activation
 * and on configuration change; 0 / undefined / nonsense clears it so resolution
 * falls back to the model table. Kept as module state rather than a `vscode`
 * import so the analysis core stays testable and UI-free.
 */
export function setContextWindowOverride(tokens: number | undefined): void {
  overrideTokens = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= MIN_OVERRIDE_TOKENS
    ? Math.round(tokens)
    : undefined;
}

export function getContextWindowOverride(): number | undefined {
  return overrideTokens;
}

/** Published maximum input window for a model, or null if the table has none. */
export function getModelContextWindow(model: string): number | null {
  if (!model || model === SYNTHETIC_MODEL) { return null; }
  const entry = findModelPricingEntry(model);
  const tokens = entry?.contextWindowTokens;
  return typeof tokens === 'number' && tokens > 0 ? tokens : null;
}

/**
 * Resolve the window for one model name.
 */
export function resolveContextWindow(model: string | undefined): ResolvedContextWindow {
  if (overrideTokens !== undefined) {
    return { tokens: overrideTokens, source: 'override' };
  }
  const fromModel = model ? getModelContextWindow(model) : null;
  if (fromModel !== null) {
    return { tokens: fromModel, source: 'model', model };
  }
  return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' };
}

/**
 * Resolve the window that governs a session.
 *
 * Prefers the most recent turn's model: in a session that switched models, the
 * question these metrics answer ("how much room is left") is about the model
 * you are on now, not the largest one you ever used. Falls back to the widest
 * window across `session.models` when no interaction carries a usable model.
 */
export function resolveSessionContextWindow(session: Session): ResolvedContextWindow {
  if (overrideTokens !== undefined) {
    return { tokens: overrideTokens, source: 'override' };
  }

  const interactions = session.interactions ?? [];
  for (let i = interactions.length - 1; i >= 0; i--) {
    const model = interactions[i]?.model;
    const tokens = model ? getModelContextWindow(model) : null;
    if (tokens !== null) {
      return { tokens, source: 'model', model };
    }
  }

  let widest: ResolvedContextWindow | null = null;
  for (const model of session.models ?? []) {
    const tokens = getModelContextWindow(model);
    if (tokens !== null && (!widest || tokens > widest.tokens)) {
      widest = { tokens, source: 'model', model };
    }
  }
  return widest ?? { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' };
}

/** Context fill percentage, clamped to 0-100. */
export function contextFillPct(tokens: number, limitTokens: number): number {
  if (!(limitTokens > 0)) { return 0; }
  return Math.min(100, Math.max(0, Math.round(tokens / limitTokens * 100)));
}
