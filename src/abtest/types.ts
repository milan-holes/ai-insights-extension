export type AbProviderId = 'claude-code' | 'copilot' | 'codex';

export interface AbModelOption {
  id: string;
  label: string;
}

export interface AbVariant {
  /** Unique within a single run — used as the worktree/branch suffix */
  id: string;
  provider: AbProviderId;
  model: string;
  label: string;
}

export interface AbTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  tokenSource: 'api' | 'estimated';
}

export type AbVariantStatus = 'pending' | 'running' | 'done' | 'error';

export interface AbCodeStats {
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  /** True when derived from fenced code blocks in the response (no worktree file changes to diff), not a real git diff */
  estimated: boolean;
}

export interface AbVariantResult {
  variant: AbVariant;
  status: AbVariantStatus;
  worktreePath?: string;
  branch?: string;
  response?: string;
  tokens?: AbTokenUsage;
  codeStats?: AbCodeStats;
  wallTimeMs?: number;
  error?: string;
}

export interface AbTestProgress {
  status: 'idle' | 'running' | 'done' | 'error';
  results: AbVariantResult[];
  error?: string;
}

export interface AbTestConfig {
  prompt: string;
  variants: AbVariant[];
  workspaceRoot: string;
}
