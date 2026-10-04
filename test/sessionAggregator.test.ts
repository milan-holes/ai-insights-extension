import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aggregateSessions } from '../src/core/sessionAggregator';
import { makeInteraction, makeSession } from './helpers';

describe('aggregateSessions', () => {
  it('rolls up provider, model, repository, mode, tool, cache, context, and hygiene metrics', () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 10, 0, 0);

    const copilot = makeSession('copilot', [
      makeInteraction({
        timestamp: yesterday,
        model: 'gpt-5-mini',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        mode: 'chat',
        toolCalls: ['read_file'],
        promptPreview: 'look at #file',
        contextRefs: { file: 1 },
      }),
      makeInteraction({
        timestamp: today,
        model: 'gpt-5-mini',
        inputTokens: 200,
        outputTokens: 75,
        thinkingTokens: 25,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        totalTokens: 300,
        effectiveContextTokens: 300,
        mode: 'agent',
        toolCalls: ['edit_file'],
        promptPreview: 'use @workspace',
        contextRefs: { workspace: 1 },
        cacheTokensEstimated: true,
      }),
    ], {
      id: 'copilot-main',
      workspace: '/repos/ai-insights',
      cacheTokensEstimated: true,
    });

    const claude = makeSession('claudeCode', [
      makeInteraction({
        timestamp: today,
        model: 'claude-sonnet-4.5',
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 25,
        totalTokens: 475,
        effectiveContextTokens: 375,
        mode: 'plan',
        toolCalls: ['Bash', 'Read'],
        promptPreview: 'plan around #selection',
        contextRefs: { selection: 1 },
      }),
      makeInteraction({
        timestamp: today,
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        effectiveContextTokens: 0,
        mode: 'compaction',
        toolCalls: [],
        isCompactionEvent: true,
        compactionTrigger: 'manual',
        preCompactionTokens: 1000,
        postCompactionTokens: 300,
      }),
    ], {
      id: 'claude-main',
      workspace: '/repos/ai-insights',
    });

    const metrics = aggregateSessions([copilot, claude], {
      planBudget: 20,
      teamSize: 2,
      alertThresholds: {
        budgetWarningPct: 80,
        budgetCriticalPct: 95,
        runawaySessionTokens: 1000,
        runawaySessionCostUsd: 10,
      },
    });

    assert.equal(metrics.allTime.totalTokens, 925);
    assert.equal(metrics.allTime.inputTokens, 600);
    assert.equal(metrics.allTime.outputTokens, 225);
    assert.equal(metrics.allTime.thinkingTokens, 25);
    assert.equal(metrics.allTime.cacheReadTokens, 130);
    assert.equal(metrics.allTime.cacheWriteTokens, 45);
    assert.equal(metrics.allTime.sessions, 2);
    assert.equal(metrics.allTime.interactions, 4);
    assert.equal(metrics.allTime.cacheTokensEstimated, true);
    assert.equal(metrics.byProvider.copilot.totalTokens, 450);
    assert.equal(metrics.byProvider.claudeCode.totalTokens, 475);
    assert.equal(metrics.todayByProvider.copilot.totalTokens, 300);
    assert.equal(metrics.yesterdayByProvider.copilot.totalTokens, 150);
    assert.equal(metrics.today.totalTokens, 775);
    assert.equal(metrics.yesterday.totalTokens, 150);
    assert.equal(metrics.allTime.modelBreakdown['gpt-5-mini'], 450);
    assert.equal(metrics.allTime.modelBreakdown['claude-sonnet-4.5'], 475);
    assert.equal(metrics.allTime.toolCalls.read_file, 1);
    assert.equal(metrics.allTime.toolCalls.edit_file, 1);
    assert.equal(metrics.allTime.toolCalls.Bash, 1);
    assert.equal(metrics.allTime.repositories['ai-insights'], 925);
    assert.equal(metrics.allTime.modeBreakdown.ask, 1);
    assert.equal(metrics.allTime.modeBreakdown.agent, 1);
    assert.equal(metrics.allTime.modeBreakdown.plan, 1);
    assert.equal(metrics.cache.totalCacheReadTokens, 130);
    assert.equal(metrics.cache.totalCacheWriteTokens, 45);
    assert.equal(metrics.contextEngagement.totalRefs, 3);
    assert.deepEqual(metrics.contextEngagement.byType, { file: 1, workspace: 1, selection: 1 });
    assert.equal(metrics.contextEngagement.interactionsWithRefs, 3);
    assert.equal(metrics.sessionHygiene.manualCompactions, 1);
    assert.equal(metrics.sessionHygiene.tokensReclaimed, 700);
    assert.equal(metrics.budget.teamSize, 2);
    assert.ok(metrics.daily.some(day => day.totalTokens === 775 && day.sessions === 2));
    assert.ok(metrics.daily.some(day => day.totalTokens === 150 && day.sessions === 1));
  });

  it('attributes multi-day sessions to the interaction date for daily and period totals', () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
    const session = makeSession('codex', [
      makeInteraction({ timestamp: yesterday, inputTokens: 40, outputTokens: 10, totalTokens: 50, mode: 'agent' }),
      makeInteraction({ timestamp: today, inputTokens: 80, outputTokens: 20, totalTokens: 100, mode: 'agent' }),
    ]);

    const metrics = aggregateSessions([session]);

    assert.equal(metrics.today.totalTokens, 100);
    assert.equal(metrics.yesterday.totalTokens, 50);
    assert.equal(metrics.today.sessions, 1);
    assert.equal(metrics.yesterday.sessions, 1);
    assert.equal(metrics.daily.length >= 2, true);
  });

  it('prefers GitHub\'s billed cost and reports the weakest source it had to use', () => {
    const today = new Date();
    const billed = makeSession('copilot', [
      makeInteraction({ timestamp: today, model: 'gpt-5.4', inputTokens: 1000, outputTokens: 50, billedCostUsd: 0.02 }),
      makeInteraction({ timestamp: today, model: 'gpt-5.4', inputTokens: 1000, outputTokens: 50, billedCostUsd: 0.03 }),
    ]);

    const metrics = aggregateSessions([billed]);
    assert.equal(metrics.allTime.costSource, 'billed');
    // The exact billed figures, not a token-rate estimate of them.
    assert.ok(Math.abs(metrics.allTime.estimatedCost - 0.05) < 1e-9);
    assert.ok(Math.abs(metrics.allTime.billedCost - 0.05) < 1e-9);
  });

  it('falls back to estimated when any interaction lacked a billed figure', () => {
    const today = new Date();
    const mixed = makeSession('copilot', [
      makeInteraction({ timestamp: today, model: 'gpt-5.4', inputTokens: 1000, outputTokens: 50, billedCostUsd: 0.02 }),
      makeInteraction({ timestamp: today, model: 'gpt-5.4', inputTokens: 1000, outputTokens: 50 }),
    ]);

    const metrics = aggregateSessions([mixed]);
    assert.equal(metrics.allTime.costSource, 'estimated');
    // Only the billed turn counts toward billedCost; the total is larger than it.
    assert.ok(Math.abs(metrics.allTime.billedCost - 0.02) < 1e-9);
    assert.ok(metrics.allTime.estimatedCost > metrics.allTime.billedCost);
  });

  it('bills Copilot Anthropic input at the cache-creation rate but leaves Claude Code alone', () => {
    const today = new Date();
    const shared = { timestamp: today, model: 'claude-sonnet-4.6', inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 0 };

    const viaCopilot = aggregateSessions([makeSession('copilot', [makeInteraction(shared)])]);
    const viaClaudeCode = aggregateSessions([makeSession('claudeCode', [makeInteraction(shared)])]);

    // 10_000 fresh tokens: 3.75/M under Copilot, 3.00/M billed directly by Anthropic.
    assert.ok(Math.abs(viaCopilot.allTime.estimatedCost - ((10_000 * 3.75 + 100 * 15) / 1e6)) < 1e-9);
    assert.ok(Math.abs(viaClaudeCode.allTime.estimatedCost - ((10_000 * 3.0 + 100 * 15) / 1e6)) < 1e-9);
    assert.ok(viaCopilot.allTime.estimatedCost > viaClaudeCode.allTime.estimatedCost);
  });
});
