import { AbTestConfig, AbTestProgress, AbVariant, AbVariantResult } from './types';
import { setupAbTestWorktree, measureCodeProduced } from './worktree';
import { BenchmarkAdapter, ClaudeCodeCliAdapter, CodexCliAdapter } from '../benchmark/adapters';
import { CopilotAgentAdapter } from './copilotAgentAdapter';

export type CancelSignal = { cancelled: boolean };

function buildAbTestAdapter(variant: AbVariant): BenchmarkAdapter {
  switch (variant.provider) {
    case 'claude-code':
      return new ClaudeCodeCliAdapter(variant.model);
    case 'codex':
      return new CodexCliAdapter(variant.model);
    case 'copilot':
      return new CopilotAgentAdapter(variant.model, variant.label);
  }
}

export async function runAbTest(
  config: AbTestConfig,
  onProgress: (progress: AbTestProgress) => void,
  cancelSignal?: CancelSignal,
): Promise<AbVariantResult[]> {
  const results: AbVariantResult[] = config.variants.map(variant => ({ variant, status: 'pending' }));
  onProgress({ status: 'running', results: clone(results) });

  for (let i = 0; i < config.variants.length; i++) {
    if (cancelSignal?.cancelled) {
      for (let j = i; j < results.length; j++) {
        if (results[j].status === 'pending') { results[j].status = 'error'; results[j].error = 'Cancelled'; }
      }
      break;
    }

    const variant = config.variants[i];
    results[i].status = 'running';
    onProgress({ status: 'running', results: clone(results) });

    try {
      const adapter = buildAbTestAdapter(variant);
      const check = await adapter.isAvailable();
      if (!check.available) {
        throw new Error(check.reason ?? `${adapter.name} is not available`);
      }

      const { worktreePath, branch } = await setupAbTestWorktree(config.workspaceRoot, variant.id);
      results[i].worktreePath = worktreePath;
      results[i].branch = branch;

      const start = Date.now();
      const adapterResult = await adapter.run({
        systemPrompt: '',
        history: [],
        userPrompt: config.prompt,
        worktreePath,
      });

      results[i].status = 'done';
      results[i].response = adapterResult.response;
      results[i].wallTimeMs = Date.now() - start;
      results[i].tokens = {
        inputTokens: adapterResult.inputTokens,
        outputTokens: adapterResult.outputTokens,
        cacheCreationTokens: adapterResult.cacheCreationTokens,
        cacheReadTokens: adapterResult.cacheReadTokens,
        tokenSource: adapterResult.tokenSource,
      };
      results[i].codeStats = await measureCodeProduced(worktreePath, adapterResult.response).catch(() => undefined);
    } catch (err) {
      results[i].status = 'error';
      results[i].error = err instanceof Error ? err.message : String(err);
    }

    onProgress({ status: 'running', results: clone(results) });
  }

  const finalStatus = results.some(r => r.status === 'error') && results.every(r => r.status !== 'done')
    ? 'error'
    : 'done';
  onProgress({ status: finalStatus, results: clone(results) });
  return results;
}

function clone(results: AbVariantResult[]): AbVariantResult[] {
  return results.map(r => ({ ...r, tokens: r.tokens ? { ...r.tokens } : undefined }));
}
