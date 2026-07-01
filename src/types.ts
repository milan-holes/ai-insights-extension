/**
 * Shared type definitions for AI Insights extension.
 * Defines a unified data model that normalizes sessions across
 * GitHub Copilot, Antigravity, and Claude Code.
 */

/** Supported AI provider identifiers */
export type ProviderId = 'copilot' | 'antigravity' | 'claudeCode' | 'codex' | 'jetbrainsAI' | 'visualStudio';

/** A single interaction (request + response) within a session */
export interface Interaction {
  timestamp: Date;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /**
   * Actual context window size for this turn: inputTokens + cacheReadTokens + cacheWriteTokens.
   * Use this (not inputTokens alone) for context-size analysis in cached sessions.
   */
  effectiveContextTokens: number;
  /** The interaction mode: chat, edit, agent, etc. */
  mode: string;
  /** Tool calls made during this interaction */
  toolCalls: string[];
  /** Shell commands executed during this interaction */
  commandRuns?: string[];
  /** File paths accessed via Read / Edit / Write tools in this interaction */
  fileAccesses?: Array<{ tool: string; path: string }>;
  /** First ~200 chars of the user message that triggered this interaction */
  promptPreview?: string;
  /** Web search requests made by server-side tools in this interaction */
  webSearchRequests?: number;
  /** Web fetch requests made by server-side tools in this interaction */
  webFetchRequests?: number;
  /** True for synthetic compaction-boundary events (not real API turns) */
  isCompactionEvent?: boolean;
  /** Whether compaction was triggered automatically or manually */
  compactionTrigger?: 'auto' | 'manual';
  /** Context token count immediately before compaction */
  preCompactionTokens?: number;
  /** Context token count immediately after compaction */
  postCompactionTokens?: number;
}

/** A normalized session from any provider */
export interface Session {
  id: string;
  provider: ProviderId;
  /** Human-readable provider name */
  providerName: string;
  startTime: Date;
  endTime: Date;
  interactions: Interaction[];
  /** Total tokens across all interactions */
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  /** Unique models used in this session */
  models: string[];
  /** Workspace/repository context if available */
  workspace: string;
  /** Source file path for diagnostics */
  sourceFile: string;
  /** Human-readable session title extracted from provider (e.g. ai-title for Claude Code) */
  title?: string;
  /** Estimated cost in USD for this session */
  estimatedCostUsd?: number;
  /**
   * MCP server names active during this session (e.g. "claude_ai_Gmail").
   * Parsed from deferred_tools_delta attachments in Claude Code sessions.
   */
  activeMcpServers?: string[];
  /**
   * Token count of the first cache-write in the session - approximates the static overhead
   * (system prompt + CLAUDE.md + MCP tool schemas) before any conversation history accumulates.
   */
  estimatedBaseContextTokens?: number;
  /** Peak effective context size seen in any turn: max(inputTokens + cacheReadTokens + cacheWriteTokens). */
  peakEffectiveContextTokens?: number;
}

/** Aggregated daily usage for a provider */
export interface DailyUsage {
  date: string; // YYYY-MM-DD
  provider: ProviderId;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessions: number;
  interactions: number;
  estimatedCost: number;
  models: Record<string, number>; // model -> token count
  toolCalls: Record<string, number>; // tool -> call count
  repositories: Record<string, number>; // repo -> token count
}

/** Metrics for a single provider or aggregate */
export interface ProviderMetrics {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheSavingsUsd: number;
  sessions: number;
  interactions: number;
  averageTokensPerSession: number;
  averageInteractionsPerSession: number;
  estimatedCost: number;
  estimatedCO2Grams: number;
  estimatedWaterLiters: number;
  treeEquivalentYears: number;
  /** Token breakdown by model */
  modelBreakdown: Record<string, number>;
  /** Token breakdown by provider */
  providerBreakdown: Record<string, number>;
  /** Tools called */
  toolCalls: Record<string, number>;
  /** Repositories used */
  repositories: Record<string, number>;
  /** Interaction count per normalized mode (ask/edit/agent/plan/customAgent/cli) */
  modeBreakdown: Record<string, number>;
  /** Cost per model */
  costByModel: Record<string, number>;
  /** Token and cost breakdown by model */
  modelUsage: Record<string, ModelUsageMetrics>;
  /** Cost per repository */
  costByRepository: Record<string, number>;
}

/** Token and pricing breakdown for a model */
export interface ModelUsageMetrics {
  totalTokens: number;
  inputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputCost: number;
  cachedInputCost: number;
  outputCost: number;
  cacheWriteCost: number;
  totalCost: number;
  inputCostPerMillion: number | null;
  cachedInputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
  cacheCreationCostPerMillion: number | null;
  pricingSource: 'official' | 'fallback';
}

// ─── Budget & Cost Management ─────────────────────────────────────────────────

/** Alert thresholds loaded from extension config */
export interface AlertThresholds {
  budgetWarningPct: number;
  budgetCriticalPct: number;
  runawaySessionTokens: number;
  runawaySessionCostUsd: number;
}

/** Config passed into aggregateSessions to enable budget-aware metrics */
export interface AggregationConfig {
  planBudget?: number;
  teamSize?: number;
  alertThresholds?: AlertThresholds;
}

/** Credit budget health for the current billing month */
export interface BudgetMetrics {
  planBudget: number;
  mtdSpend: number;
  creditsRemaining: number;
  dailyBurnRate: number;
  /** USD/hour averaged over hours active today (today spend / elapsed hours) */
  hourlyBurnRate: number;
  daysElapsed: number;
  daysInMonth: number;
  daysRemaining: number;
  /** null when burn rate is 0 (never exhausted) */
  daysUntilExhausted: number | null;
  projectedMonthEnd: number;
  /** 0–100: projected spend as % of plan budget */
  overageRiskScore: number;
  /** 0–100: MTD spend as % of plan budget */
  budgetUtilizationPct: number;
  teamSize: number;
  teamProjectedCost: number;
}

/** Cache efficiency summary for the current period */
export interface CacheMetrics {
  /** 0–1 fraction of input tokens served from cache */
  cacheHitRate: number;
  /** Estimated USD saved by cache reads vs full-price input */
  cacheSavingsUsd: number;
  /** cache reads / cache writes - high = efficient reuse */
  cacheWriteReadRatio: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

/** Return-on-investment metrics for the current period */
export interface ROIMetrics {
  outputTokensPerDollar: number;
  /** output / input - how much code per context token */
  inputEfficiencyRatio: number;
  /** thinking tokens as % of total (overhead with no direct output) */
  thinkingOverheadPct: number;
  costPerSession: number;
  costPerInteraction: number;
  /** Provider with highest output tokens per dollar */
  mostEfficientProvider: string;
  /** Cost comparison by provider: id → $/1K output tokens */
  providerCostPer1KOutput: Record<string, number>;
}

/** Anomaly and risk flags */
export interface AnomalyFlags {
  /** Z-score of today's spend vs 30-day daily average */
  todayZScore: number;
  /** true when Z-score exceeds 2.0 */
  isSpike: boolean;
  /** Sessions exceeding the configured token or cost threshold */
  runawaySessionsCount: number;
  /** week2 burn rate / week1 burn rate - >1.2 = accelerating */
  burnAcceleration: number;
  /** Consecutive days above 80% of daily-budget pace */
  consecutiveHighDays: number;
}

/** Session depth and complexity breakdown */
export interface SessionComplexityMetrics {
  avgSessionDepth: number;
  /** Sessions longer than 30 minutes */
  longSessionsCount: number;
  longSessionsCost: number;
  /** Sessions with more than 5 tool calls */
  toolHeavyCount: number;
  thinkingSessionsCount: number;
  multiModelSessionsCount: number;
  avgSessionDurationMin: number;
  highestCostSession: { id: string; cost: number; tokens: number } | null;
}

/** Full aggregated output returned by aggregateSessions() */
export interface AggregatedMetrics {
  today: ProviderMetrics;
  yesterday: ProviderMetrics;
  currentMonth: ProviderMetrics;
  lastMonth: ProviderMetrics;
  thisYear: ProviderMetrics;
  allTime: ProviderMetrics;
  projectedYear: ProviderMetrics;
  byProvider: Record<ProviderId, ProviderMetrics>;
  todayByProvider: Record<ProviderId, ProviderMetrics>;
  yesterdayByProvider: Record<ProviderId, ProviderMetrics>;
  currentMonthByProvider: Record<ProviderId, ProviderMetrics>;
  lastMonthByProvider: Record<ProviderId, ProviderMetrics>;
  thisYearByProvider: Record<ProviderId, ProviderMetrics>;
  allTimeByProvider: Record<ProviderId, ProviderMetrics>;
  daily: DailyUsage[];
  budget: BudgetMetrics;
  cache: CacheMetrics;
  roi: ROIMetrics;
  anomaly: AnomalyFlags;
  sessionComplexity: SessionComplexityMetrics;
}

/** Whether a config file exists and when it was last modified */
export interface FileStatus {
  exists: boolean;
  /** Modified within the last 30 days */
  fresh: boolean;
}

/** Content quality analysis of a single instruction file */
export interface InstructionQuality {
  /** Display label, e.g. "CLAUDE.md", "copilot-instructions.md", "AGENTS.md" */
  file: string;
  wordCount: number;
  /** File contains markdown section headers */
  hasSections: boolean;
  quality: 'stub' | 'basic' | 'good' | 'rich';
}

/** Repository-level AI configuration hygiene report */
export interface RepositoryHygieneReport {
  name: string;
  /** Resolved filesystem path, or null if not discoverable */
  repoPath: string | null;
  sessions: number;
  interactions: number;
  /** 0–100 composite score; null if path unknown */
  score: number | null;
  files: {
    instructions: FileStatus;   // CLAUDE.md / copilot-instructions.md / .cursorrules
    agentSetup: FileStatus;     // .claude/settings.json
    mcpConfig: FileStatus;      // mcpServers in settings or .mcp.json
    skillFiles: FileStatus;     // .claude/commands/
    customAgents: FileStatus;   // AGENTS.md or .claude/agents/
  };
  /** Content quality for each instruction/agent file that was found */
  instructionQuality: InstructionQuality[];
  lastActivity: string | null;
}

/** Model pricing information */
export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
  category: string;
}

/** Live acceptance-rate metrics tracked since extension activation */
export interface AcceptanceMetrics {
  /** Times an inline completion was triggered (debounced 750 ms - proxy for ghost-text shown) */
  triggered: number;
  /** Times a completion item was accepted from the popup (via onDidAcceptCompletionItem) */
  accepted: number;
  /** accepted / triggered; 0 when no triggers yet */
  acceptanceRate: number;
  /** Wall-clock time when tracking began (extension activation) */
  since: Date;
}

/** Live code-diff outcome metrics tracked since extension activation */
export interface DiffMetrics {
  /** Number of Copilot diff views opened (TabInputTextDiff with virtual original) */
  shown: number;
  /** Diffs applied exactly as proposed (accepted without edits) */
  accepted: number;
  /** Diffs applied after user modified the suggestion */
  updated: number;
  /** Diffs dismissed without applying any change */
  declined: number;
  /** accepted / (accepted + updated + declined); 0 when no outcomes yet */
  acceptanceRate: number;
  /** Wall-clock time when tracking began (extension activation) */
  since: Date;
}

// ─── Active Session Tracking ──────────────────────────────────────────────────

export type LiveBudgetType = 'daily' | 'weekly' | 'monthly' | 'fixed';

export interface LiveBudgetConfig {
  type: LiveBudgetType;
  limitTokens?: number;
  limitUsd?: number;
  /** ISO date string - start of the fixed window */
  fixedWindowStart?: string;
  /** ISO date string - end of the fixed window */
  fixedWindowEnd?: string;
}

export type LiveAlertType = 'spike' | 'high_burn' | 'rate_limit_imminent' | 'rate_limit_hit';

export interface LiveAlert {
  type: LiveAlertType;
  message: string;
  severity: 'warning' | 'error';
  timestamp: string; // ISO
}

export interface LiveSessionState {
  provider: ProviderId;
  sessionId: string;
  sessionFilePath: string;
  sessionTitle: string;
  sessionStartTime: string; // ISO
  elapsedMinutes: number;
  currentTokens: number;
  currentInputTokens: number;
  currentOutputTokens: number;
  /** Tokens per minute averaged over the last 10 min or all interactions, whichever is smaller */
  recentBurnRatePerMin: number;
  /** Minutes from now until budget is exhausted at current burn rate; null if unlimited or no budget */
  projectedExhaustionMinutes: number | null;
  /** Tokens consumed in the current budget window (daily/weekly/monthly/fixed) */
  budgetWindowUsedTokens: number;
  /** USD consumed in the current budget window */
  budgetWindowUsedUsd: number;
  /** ISO datetime when the current budget window resets */
  budgetWindowResetTime: string | null;
  /** 0–100 percentage of budget consumed */
  budgetUsedPct: number | null;
  alerts: LiveAlert[];
  /** ISO datetime of last update */
  lastUpdated: string;
}

export interface RateLimitEvent {
  timestamp: string; // ISO
  provider: ProviderId;
  sessionId?: string;
  note?: string;
}

export interface LiveMonitorCalibration {
  provider: ProviderId;
  /** User-provided current usage percentage 0–100 */
  currentUsagePct: number;
  /** ISO datetime of next window reset */
  resetTime: string | null;
  planName: string;
  budgetConfig: LiveBudgetConfig;
}

// ─── Context Rot Workbench ────────────────────────────────────────────────────

export interface ContextTimelinePoint {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  toolCallCount: number;
  cacheHit: boolean;
  timestamp: string; // ISO
}

export type OptimizationTechnique =
  | 'caveman'        // Excessive Bash calls for debug-print output
  | 'file_reread'    // Same file read multiple times across turns
  | 'toon'           // Full file content returned when only excerpt needed
  | 'early_compact'  // Context compaction wasn't used but would have helped
  | 'output_trim'    // Model outputs are overly verbose
  | 'prompt_dedupe'; // Repeated fragments in user prompts

export interface OptimizationProposal {
  technique: OptimizationTechnique;
  title: string;
  description: string;
  /** Estimated tokens saved at peak context if technique had been applied */
  estimatedSavings: number;
  /** Savings as % of peak context window */
  savingsPct: number;
  /** Human-readable evidence from the session data */
  evidence: string;
}

export type OverloadSignalType =
  | 'high_input_output_ratio'
  | 'long_turn_chain'
  | 'repeated_tool_failures'
  | 'large_static_context'
  | 'output_collapse'
  | 'tool_loop'
  | 'cache_thrash'
  | 'thinking_overload'
  | 'lost_in_middle';

export interface OverloadSignal {
  type: OverloadSignalType;
  severity: 'low' | 'medium' | 'high';
  message: string;
  detail: string;
}

export interface FreshSessionBrief {
  /** First user prompt (truncated) */
  goal: string;
  /** Tool types inferred as write operations */
  writeOperations: string[];
  /** Last 3 prompt previews (truncated) */
  recentContext: string[];
  /** Most recent interaction preview */
  nextAction: string;
  warnings: string[];
}

export interface ContextRotAnalysis {
  score: number;
  label: 'healthy' | 'warning' | 'stale';
  turnsCount: number;
  sessionAgeMinutes: number;
  inputBloatFactor: number;
  outputDeclineFactor: number;
  /** Per-turn timeline for chart rendering */
  timeline: ContextTimelinePoint[];
  /** Detected overload conditions */
  overloadSignals: OverloadSignal[];
  /** Prompt fragments appearing more than once (from promptPreview) */
  repeatedPromptFragments: string[];
  /** Tool names called 3+ times across interactions */
  heavyToolUsage: string[];
  restartRecommended: boolean;
  restartReason: string;
  rehydrationChecklist: string[];
  freshSessionBrief: FreshSessionBrief;
  /** Estimated turns remaining before hitting context limit at current growth rate; null if not estimable */
  contextRunway: number | null;
  growthCurve: ContextGrowthCurve;
  /** 0–100: percentage of cumulative input tokens served from cache */
  cacheEfficiencyRate: number;
  cacheThrashDetected: boolean;
  thinkingEfficiencyTrend: 'rising' | 'stable' | 'falling' | 'none';
  contextBudgetAllocation: ContextBudgetAllocation;
  /** 0–100: risk that critical context is lost in the middle of a large context window */
  lostInMiddleRisk: number;
  /** 0–100: composite context quality score */
  contextQualityScore: number;
  sessionSiblings: SessionSiblingRef[];
  /** Ranked list of context-engineering optimizations with estimated token savings */
  optimizationProposals: OptimizationProposal[];
}

export type ContextGrowthCurve = 'linear' | 'exponential' | 'plateau' | 'spike';

export interface ContextBudgetAllocation {
  cachedTokens: number;
  freshInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedPct: number;
  freshInputPct: number;
  cacheWritePct: number;
  outputPct: number;
  thinkingPct: number;
}

export interface SessionSiblingRef {
  sessionId: string;
  startTime: string;
  title?: string;
}

/** File cache entry for tracking modifications */
export interface CacheEntry {
  filePath: string;
  lastModified: number;
  lastProcessed: number;
  sessionData: Session | null;
}

/** Diagnostic report data */
export interface DiagnosticReport {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  nodeVersion: string;
  providers: {
    id: ProviderId;
    enabled: boolean;
    sessionFilesFound: number;
    sessionDirs: string[];
    lastError?: string;
  }[];
  cacheStats: {
    entries: number;
    hitRate: number;
  };
  aggregatedStats: {
    totalSessions: number;
    totalTokens: number;
    dateRange: string;
  };
  timestamp: string;
}
