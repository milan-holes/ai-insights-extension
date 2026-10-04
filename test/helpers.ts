import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Interaction, ProviderId, Session } from '../src/types';

export function makeTempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ai-insights-${name}-`));
}

export function writeJsonl(filePath: string, entries: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
}

export function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function makeInteraction(overrides: Partial<Interaction> = {}): Interaction {
  const inputTokens = overrides.inputTokens ?? 100;
  const outputTokens = overrides.outputTokens ?? 50;
  const thinkingTokens = overrides.thinkingTokens ?? 0;
  const cacheReadTokens = overrides.cacheReadTokens ?? 0;
  const cacheWriteTokens = overrides.cacheWriteTokens ?? 0;
  return {
    timestamp: overrides.timestamp ?? new Date('2026-10-03T10:00:00.000Z'),
    model: overrides.model ?? 'gpt-5-mini',
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: overrides.totalTokens ?? inputTokens + outputTokens + thinkingTokens + cacheReadTokens + cacheWriteTokens,
    effectiveContextTokens: overrides.effectiveContextTokens ?? inputTokens + cacheReadTokens + cacheWriteTokens,
    mode: overrides.mode ?? 'chat',
    toolCalls: overrides.toolCalls ?? [],
    commandRuns: overrides.commandRuns,
    fileAccesses: overrides.fileAccesses,
    promptPreview: overrides.promptPreview,
    contextRefs: overrides.contextRefs,
    webSearchRequests: overrides.webSearchRequests,
    webFetchRequests: overrides.webFetchRequests,
    isCompactionEvent: overrides.isCompactionEvent,
    compactionTrigger: overrides.compactionTrigger,
    preCompactionTokens: overrides.preCompactionTokens,
    postCompactionTokens: overrides.postCompactionTokens,
    cacheTokensEstimated: overrides.cacheTokensEstimated,
    billedCostUsd: overrides.billedCostUsd,
  };
}

export function makeSession(provider: ProviderId, interactions: Interaction[], overrides: Partial<Session> = {}): Session {
  const providerNames: Record<ProviderId, string> = {
    copilot: 'GitHub Copilot',
    antigravity: 'Antigravity',
    claudeCode: 'Claude Code',
    codex: 'Codex',
    jetbrainsAI: 'JetBrains AI',
    visualStudio: 'Visual Studio',
  };
  return {
    id: overrides.id ?? `${provider}-session`,
    provider,
    providerName: overrides.providerName ?? providerNames[provider],
    startTime: overrides.startTime ?? interactions[0]?.timestamp ?? new Date('2026-10-03T10:00:00.000Z'),
    endTime: overrides.endTime ?? interactions[interactions.length - 1]?.timestamp ?? new Date('2026-10-03T10:00:00.000Z'),
    interactions,
    totalTokens: overrides.totalTokens ?? interactions.reduce((sum, i) => sum + i.totalTokens, 0),
    totalInputTokens: overrides.totalInputTokens ?? interactions.reduce((sum, i) => sum + i.inputTokens, 0),
    totalOutputTokens: overrides.totalOutputTokens ?? interactions.reduce((sum, i) => sum + i.outputTokens, 0),
    totalThinkingTokens: overrides.totalThinkingTokens ?? interactions.reduce((sum, i) => sum + i.thinkingTokens, 0),
    totalCacheReadTokens: overrides.totalCacheReadTokens ?? interactions.reduce((sum, i) => sum + i.cacheReadTokens, 0),
    totalCacheWriteTokens: overrides.totalCacheWriteTokens ?? interactions.reduce((sum, i) => sum + i.cacheWriteTokens, 0),
    models: overrides.models ?? [...new Set(interactions.map(i => i.model))],
    workspace: overrides.workspace ?? `/work/${provider}`,
    sourceFile: overrides.sourceFile ?? `/sessions/${provider}.jsonl`,
    title: overrides.title,
    estimatedCostUsd: overrides.estimatedCostUsd,
    activeMcpServers: overrides.activeMcpServers,
    estimatedBaseContextTokens: overrides.estimatedBaseContextTokens,
    peakEffectiveContextTokens: overrides.peakEffectiveContextTokens,
    cacheTokensEstimated: overrides.cacheTokensEstimated,
    rateLimits: overrides.rateLimits,
  };
}
