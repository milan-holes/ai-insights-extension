import * as assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { calculateCost, calculateCostBreakdown, USD_PER_AI_CREDIT } from '../src/core/costEstimation';
import {
  calibrationSnapshot,
  getCalibrationFactor,
  nanoAiuToUsd,
  observeBilledRequest,
  resetCalibration,
} from '../src/core/copilotBillingCalibration';

beforeEach(() => resetCalibration());

/**
 * Real `llm_request` records from `debug-logs/*\/main.jsonl`, with the
 * `copilotUsageNanoAiu` GitHub billed for each. These are the measurements behind
 * wiki/copilot-billing-calibration.md and exist here so a pricing-table edit that breaks
 * the billing model fails loudly.
 */
const BILLED_REQUESTS: Array<{
  model: string; inputTokens: number; cachedTokens: number; outputTokens: number; nanoAiu: number;
}> = [
  { model: 'gpt-5.3-codex', inputTokens: 36229, cachedTokens: 9728, outputTokens: 53, nanoAiu: 4393903500 },
  { model: 'gpt-5.3-codex', inputTokens: 31703, cachedTokens: 8704, outputTokens: 304, nanoAiu: 4142470500 },
  { model: 'gpt-5.3-codex', inputTokens: 38813, cachedTokens: 22528, outputTokens: 350, nanoAiu: 3360703500 },
  { model: 'gpt-5.3-codex', inputTokens: 50780, cachedTokens: 39040, outputTokens: 342, nanoAiu: 2894850000 },
  { model: 'gpt-5.3-codex', inputTokens: 35372, cachedTokens: 31872, outputTokens: 499, nanoAiu: 1681974000 },
  { model: 'gpt-5.4', inputTokens: 27998, cachedTokens: 26112, outputTokens: 1345, nanoAiu: 2827620000 },
  { model: 'gpt-5.4', inputTokens: 16718, cachedTokens: 12800, outputTokens: 366, nanoAiu: 1663650000 },
  { model: 'gpt-5.4', inputTokens: 24121, cachedTokens: 22528, outputTokens: 285, nanoAiu: 1250055000 },
  // Anthropic: the whole uncached remainder bills at the cache-creation rate (3.75),
  // which is why a pure cache miss costs far more than input-rate arithmetic predicts.
  { model: 'claude-sonnet-4.6', inputTokens: 21108, cachedTokens: 0, outputTokens: 121, nanoAiu: 8096775000 },
  { model: 'claude-sonnet-4.6', inputTokens: 21416, cachedTokens: 14612, outputTokens: 49, nanoAiu: 3063135000 },
  { model: 'claude-sonnet-4.6', inputTokens: 21264, cachedTokens: 21105, outputTokens: 15, nanoAiu: 715200000 },
];

const billedUsd = (nanoAiu: number) => nanoAiuToUsd(nanoAiu, USD_PER_AI_CREDIT);

describe('nanoAiu conversion', () => {
  it('treats 1 AIU as one AI credit', () => {
    assert.equal(nanoAiuToUsd(1_000_000_000, USD_PER_AI_CREDIT), 0.01);
    assert.equal(nanoAiuToUsd(4_142_470_500, USD_PER_AI_CREDIT), 0.041424705);
    assert.equal(nanoAiuToUsd(0, USD_PER_AI_CREDIT), 0);
  });
});

describe('Copilot billing shape', () => {
  it('bills Anthropic uncached input at the cache-creation rate, matching GitHub exactly', () => {
    // A pure cache miss: every input token is a cache write.
    const miss = BILLED_REQUESTS.find(r => r.model === 'claude-sonnet-4.6' && r.cachedTokens === 0)!;
    const copilot = calculateCost(miss.model, miss.inputTokens, miss.outputTokens, miss.cachedTokens, 0, {
      shape: 'copilot', calibrate: false,
    });
    assert.ok(Math.abs(copilot - billedUsd(miss.nanoAiu)) / billedUsd(miss.nanoAiu) < 0.0005,
      `copilot shape ${copilot} should match billed ${billedUsd(miss.nanoAiu)}`);

    // The direct shape bills it at the input rate instead, and under-reports by ~20%.
    const direct = calculateCost(miss.model, miss.inputTokens, miss.outputTokens, miss.cachedTokens, 0);
    assert.ok(direct < copilot * 0.85, `direct shape ${direct} should materially under-report ${copilot}`);
  });

  it('leaves the direct shape untouched for providers that report real cache writes', () => {
    // Claude Code supplies cacheWriteTokens itself; the direct shape must bill the
    // remainder at the input rate and not double-charge the write.
    const direct = calculateCostBreakdown('claude-sonnet-4.6', 10_000, 100, 4_000, 2_000);
    assert.equal(direct.inputCost, (4_000 * 3.0) / 1e6);
    assert.equal(direct.cacheWriteCost, (2_000 * 3.75) / 1e6);
    assert.equal(direct.costSource, 'estimated');
    assert.equal(direct.calibrationFactor, 1);
  });

  it('infers the whole uncached remainder as the write under the copilot shape', () => {
    const copilot = calculateCostBreakdown('claude-sonnet-4.6', 10_000, 100, 4_000, 2_000, { shape: 'copilot' });
    // cacheWriteTokens is ignored: 10_000 - 4_000 = 6_000 fresh tokens at 3.75.
    assert.equal(copilot.inputCost, (6_000 * 3.75) / 1e6);
    assert.equal(copilot.cacheWriteCost, 0);
  });
});

describe('calibration against billed requests', () => {
  it('reports nothing measured before any observation', () => {
    const factor = getCalibrationFactor('gpt-5.3-codex');
    assert.deepEqual(factor, { factor: 1, samples: 0, spread: 0 });
    assert.deepEqual(calibrationSnapshot(), []);
  });

  it('never applies a factor it has not measured', () => {
    const uncalibrated = calculateCostBreakdown('gpt-5.4', 20_000, 500, 10_000, 0, { shape: 'copilot' });
    assert.equal(uncalibrated.costSource, 'estimated');
    assert.equal(uncalibrated.calibrationFactor, 1);
  });

  it('derives the OpenAI factor with zero spread, then labels costs calibrated', () => {
    const openAi = BILLED_REQUESTS.filter(r => r.model.startsWith('gpt-'));
    for (const r of openAi) {
      const predicted = calculateCost(r.model, r.inputTokens, r.outputTokens, r.cachedTokens, 0, {
        shape: 'copilot', calibrate: false,
      });
      observeBilledRequest(r.model, predicted, billedUsd(r.nanoAiu));
    }

    for (const model of ['gpt-5.3-codex', 'gpt-5.4']) {
      const factor = getCalibrationFactor(model);
      assert.ok(factor.samples >= 3, `${model} should have samples`);
      // Copilot bills these at 0.9x the published rates - exactly, on every request.
      assert.ok(Math.abs(factor.factor - 0.9) < 1e-6, `${model} factor ${factor.factor} should be 0.9`);
      assert.ok(factor.spread < 1e-6, `${model} spread ${factor.spread} should be ~0`);
    }

    const calibrated = calculateCostBreakdown('gpt-5.4', 20_000, 500, 10_000, 0, { shape: 'copilot' });
    assert.equal(calibrated.costSource, 'calibrated');
    assert.ok(Math.abs(calibrated.calibrationFactor - 0.9) < 1e-6);
  });

  it('reproduces every billed request once calibrated', () => {
    for (const r of BILLED_REQUESTS) {
      const predicted = calculateCost(r.model, r.inputTokens, r.outputTokens, r.cachedTokens, 0, {
        shape: 'copilot', calibrate: false,
      });
      observeBilledRequest(r.model, predicted, billedUsd(r.nanoAiu));
    }

    let totalPredicted = 0;
    let totalBilled = 0;
    for (const r of BILLED_REQUESTS) {
      const actual = billedUsd(r.nanoAiu);
      const predicted = calculateCost(r.model, r.inputTokens, r.outputTokens, r.cachedTokens, 0, {
        shape: 'copilot',
      });
      totalPredicted += predicted;
      totalBilled += actual;
      assert.ok(Math.abs(predicted - actual) / actual < 0.002,
        `${r.model} predicted ${predicted} vs billed ${actual}`);
    }
    assert.ok(Math.abs(totalPredicted - totalBilled) / totalBilled < 0.0005,
      `total ${totalPredicted} vs ${totalBilled}`);
  });

  it('counts a repeated request once so sample confidence stays honest', () => {
    observeBilledRequest('gpt-5.4', 0.02, 0.018);
    observeBilledRequest('gpt-5.4', 0.02, 0.018);
    observeBilledRequest('gpt-5.4', 0.02, 0.018);
    assert.equal(getCalibrationFactor('gpt-5.4').samples, 1);
  });

  it('ignores observations that cannot produce a ratio', () => {
    observeBilledRequest('gpt-5.4', 0, 0.01);
    observeBilledRequest('gpt-5.4', 0.01, 0);
    assert.equal(getCalibrationFactor('gpt-5.4').samples, 0);
  });

  it('keys observations by normalized model id', () => {
    observeBilledRequest('GPT-5.4', 0.02, 0.018);
    assert.equal(getCalibrationFactor('gpt-5.4').samples, 1);
  });

  it('does not calibrate the direct shape', () => {
    observeBilledRequest('gpt-5.4', 0.02, 0.018);
    const direct = calculateCostBreakdown('gpt-5.4', 20_000, 500, 10_000, 0);
    assert.equal(direct.calibrationFactor, 1);
    assert.equal(direct.costSource, 'estimated');
  });
});
