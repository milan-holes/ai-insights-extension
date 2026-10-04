import * as assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  contextFillPct,
  getModelContextWindow,
  resolveContextWindow,
  resolveSessionContextWindow,
  setContextWindowOverride,
} from '../src/core/contextWindow';
import { normalizeModelName } from '../src/core/costEstimation';
import { computeContextRotAnalysis } from '../src/core/contextRot';
import { makeInteraction, makeSession } from './helpers';

afterEach(() => setContextWindowOverride(undefined));

describe('model context window resolution', () => {
  it('reads published windows from the pricing table', () => {
    assert.equal(getModelContextWindow('claude-opus-5'), 1_000_000);
    assert.equal(getModelContextWindow('claude-sonnet-5'), 1_000_000);
    assert.equal(getModelContextWindow('claude-haiku-4.5'), 200_000);
    assert.equal(getModelContextWindow('gemini-3.1-pro'), 1_048_576);
  });

  it('matches dash-versioned and date-stamped API model ids', () => {
    assert.equal(normalizeModelName('claude-opus-4-8'), 'claude-opus-4.8');
    assert.equal(normalizeModelName('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
    assert.equal(normalizeModelName('claude-3-5-sonnet'), 'claude-3.5-sonnet');
    assert.equal(normalizeModelName('gpt-5-mini'), 'gpt-5-mini');

    assert.equal(getModelContextWindow('claude-opus-4-8'), 1_000_000);
    assert.equal(getModelContextWindow('claude-haiku-4-5-20251001'), 200_000);
  });

  it('falls back to the default for unknown and synthetic models', () => {
    assert.equal(getModelContextWindow('<synthetic>'), null);
    assert.equal(getModelContextWindow('some-unreleased-model'), null);
    assert.deepEqual(resolveContextWindow('<synthetic>'), {
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      source: 'default',
    });
  });

  it('lets the user override win over the model table', () => {
    setContextWindowOverride(1_000_000);
    assert.deepEqual(resolveContextWindow('claude-haiku-4.5'), { tokens: 1_000_000, source: 'override' });

    // Nonsense and 0 clear the override rather than wedging every metric.
    setContextWindowOverride(0);
    assert.equal(resolveContextWindow('claude-haiku-4.5').source, 'model');
    setContextWindowOverride(Number.NaN);
    assert.equal(resolveContextWindow('claude-haiku-4.5').source, 'model');
  });

  it('resolves a session from its most recent model', () => {
    const session = makeSession('claudeCode', [
      makeInteraction({ model: 'claude-haiku-4.5' }),
      makeInteraction({ model: 'claude-opus-5' }),
    ]);
    const resolved = resolveSessionContextWindow(session);
    assert.equal(resolved.tokens, 1_000_000);
    assert.equal(resolved.model, 'claude-opus-5');

    // A trailing synthetic turn must not mask the real model.
    const withSynthetic = makeSession('claudeCode', [
      makeInteraction({ model: 'claude-opus-5' }),
      makeInteraction({ model: '<synthetic>' }),
    ]);
    assert.equal(resolveSessionContextWindow(withSynthetic).tokens, 1_000_000);
  });

  it('clamps fill percentage', () => {
    assert.equal(contextFillPct(500_000, 1_000_000), 50);
    assert.equal(contextFillPct(2_000_000, 1_000_000), 100);
    assert.equal(contextFillPct(100, 0), 0);
  });
});

describe('context metrics use the resolved window', () => {
  /** Linear growth of 100K effective context per turn. */
  function growingSession(model: string) {
    const interactions = [1, 2, 3, 4, 5, 6].map(n => makeInteraction({
      model,
      timestamp: new Date(`2026-10-03T10:0${n}:00.000Z`),
      inputTokens: 2,
      cacheReadTokens: n * 100_000,
      outputTokens: 500,
      effectiveContextTokens: n * 100_000,
    }));
    return makeSession('claudeCode', interactions, {
      peakEffectiveContextTokens: 600_000,
    });
  }

  it('reports real runway on a 1M-window model instead of zero', () => {
    const opus = computeContextRotAnalysis(growingSession('claude-opus-5'));
    assert.equal(opus.contextWindowTokens, 1_000_000);
    assert.equal(opus.contextWindowSource, 'model');
    // 400K of headroom at ~100K/turn.
    assert.equal(opus.contextRunway, 4);

    const haiku = computeContextRotAnalysis(growingSession('claude-haiku-4.5'));
    assert.equal(haiku.contextWindowTokens, 200_000);
    assert.equal(haiku.contextRunway, 0);
  });

  it('scales lost-in-the-middle risk to the window', () => {
    const opus = computeContextRotAnalysis(growingSession('claude-opus-5'));
    const haiku = computeContextRotAnalysis(growingSession('claude-haiku-4.5'));
    // Both sessions are identical apart from the model; 80 is the pinned ceiling
    // after the high-cache-efficiency dampener (100 * 0.8).
    assert.equal(haiku.lostInMiddleRisk, 80);
    assert.ok(
      opus.lostInMiddleRisk < haiku.lostInMiddleRisk,
      `expected opus (${opus.lostInMiddleRisk}) below haiku (${haiku.lostInMiddleRisk})`,
    );
    assert.ok(opus.lostInMiddleRisk > 0);
  });

  it('only flags large-context overload relative to the window', () => {
    const hasHighSignal = (model: string) => computeContextRotAnalysis(growingSession(model))
      .overloadSignals.some(s => s.type === 'large_static_context' && s.severity === 'high');
    // 600K peak is 60% of 1M (no high signal) but 300% of 200K (high signal).
    assert.equal(hasHighSignal('claude-opus-5'), false);
    assert.equal(hasHighSignal('claude-haiku-4.5'), true);
  });

  it('honours the override in session metrics', () => {
    setContextWindowOverride(200_000);
    const opus = computeContextRotAnalysis(growingSession('claude-opus-5'));
    assert.equal(opus.contextWindowTokens, 200_000);
    assert.equal(opus.contextWindowSource, 'override');
  });
});
