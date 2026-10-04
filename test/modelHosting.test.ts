import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, it } from 'node:test';
import { calculateCost, calculateCostBreakdown, findModelPricingEntry, resolveInteractionCost } from '../src/core/costEstimation';
import { modelHosting } from '../src/core/modelNames';
import { CopilotProvider } from '../src/providers/copilot';
import pricingData from '../src/data/modelPricing.json';
import { makeInteraction, makeTempDir, writeText } from './helpers';

const pricing = pricingData.pricing as Record<string, unknown>;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('model hosting', () => {
  it('classifies models by their VS Code vendor prefix', () => {
    assert.equal(modelHosting('gpt-5-mini'), 'provider');
    assert.equal(modelHosting('copilot/gpt-5-mini'), 'provider');
    assert.equal(modelHosting('github-copilot/claude-sonnet-4.5'), 'provider');
    assert.equal(modelHosting('ollama/qwen3-coder:30b'), 'local');
    assert.equal(modelHosting('customoai/llama-3.1-8b-instruct'), 'local');
    assert.equal(modelHosting('LMStudio/gemma-3'), 'local');
    assert.equal(modelHosting('anthropic/claude-sonnet-4.5'), 'byok');
    assert.equal(modelHosting('openrouter/meta-llama/llama-4'), 'byok');
  });

  it('prices local models at $0, even one named after a hosted model', () => {
    const breakdown = calculateCostBreakdown('ollama/kimi-k3', 100_000, 10_000, 0, 0, { shape: 'copilot' });
    assert.equal(breakdown.totalCost, 0);
    assert.equal(breakdown.pricingSource, 'local');
    assert.equal(findModelPricingEntry('ollama/kimi-k3'), null);
    assert.ok(findModelPricingEntry('kimi-k3'));
  });

  it('reports a local turn as an exact $0, not an estimate', () => {
    const resolved = resolveInteractionCost('copilot', makeInteraction({ model: 'customoai/llama-3.1' }));
    assert.deepEqual([resolved.usd, resolved.source], [0, 'billed']);
  });

  it('prices own-key models at the vendor list rate, outside the Copilot billing shape', () => {
    const args = [50_000, 2_000, 10_000, 0] as const;
    assert.equal(
      calculateCost('anthropic/claude-sonnet-4.5', ...args, { shape: 'copilot' }),
      calculateCost('claude-sonnet-4.5', ...args, { shape: 'direct' }),
    );
    const unknown = calculateCostBreakdown('openrouter/some-new-model', 50_000, 2_000, 0, 0, { shape: 'copilot' });
    assert.deepEqual([unknown.totalCost, unknown.pricingSource], [0, 'unpriced']);
  });
});

describe('pricing-table matching', () => {
  const entryKey = (model: string): string | null => {
    const entry = findModelPricingEntry(model);
    return entry ? Object.keys(pricing).find(k => pricing[k] === entry) ?? null : null;
  };

  it('matches a table key only as a whole name, preferring the longest', () => {
    assert.equal(entryKey('gpt-4o-2024-05-13'), 'gpt-4o');
    assert.equal(entryKey('gpt-5.4-mini-preview'), 'gpt-5.4-mini');
    assert.equal(entryKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4.5');
    assert.equal(entryKey('claude-haiku-4-5-20251001'), 'claude-haiku-4.5');
    assert.equal(entryKey('qwen-gpt-4o-distill'), null);
    assert.equal(entryKey('gpt-4o9'), null);
  });

  it('still finds every table key by its own name', () => {
    for (const key of Object.keys(pricing)) {
      assert.equal(entryKey(key), key, key);
    }
  });
});

describe('Copilot sessions served by local models', () => {
  function writeSession(requests: unknown[]): { root: string; file: string } {
    const root = makeTempDir('copilot-local');
    tempDirs.push(root);
    const file = path.join(root, 'workspaceStorage', 'hash', 'chatSessions', 'local-1.json');
    writeText(file, JSON.stringify({ sessionId: 'local-1', requests }));
    return { root, file };
  }

  const request = (extra: Record<string, unknown>) => ({
    timestamp: '2026-10-03T08:00:00.000Z',
    message: { parts: [{ text: 'Explain this function' }] },
    response: { text: 'It parses the file.' },
    usage: { prompt_tokens: 4000, completion_tokens: 300 },
    ...extra,
  });

  it('keeps the vendor-prefixed model id and costs nothing', async () => {
    const { root, file } = writeSession([request({ modelId: 'ollama/qwen3-coder:30b' })]);
    const session = await new CopilotProvider(1, false, 'inclusive', [path.join(root, 'workspaceStorage')]).parseSessionFile(file);

    assert.ok(session);
    assert.deepEqual(session.models, ['ollama/qwen3-coder:30b']);
    assert.equal(session.totalInputTokens, 4000);
    assert.equal(session.estimatedCostUsd, 0);
  });

  it('rejoins a bare model id with a separately stored vendor instead of guessing a Copilot model', async () => {
    const { root, file } = writeSession([
      request({ modelId: 'llama-3.1-8b', selectedModel: { metadata: { vendor: 'customoai' } } }),
      request({ selectedModel: { metadata: { vendor: 'ollama' } } }),
    ]);
    const session = await new CopilotProvider(1, false, 'inclusive', [path.join(root, 'workspaceStorage')]).parseSessionFile(file);

    assert.ok(session);
    assert.deepEqual(session.interactions.map(i => i.model), ['customoai/llama-3.1-8b', 'ollama/unknown']);
    assert.equal(session.estimatedCostUsd, 0);
  });
});
