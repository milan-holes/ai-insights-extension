/**
 * Rule-based insights/nudge catalog: declarative tips, opportunities, and celebrations
 * derived from signals already computed elsewhere (health score, budget, cache,
 * anomaly, session hygiene, context engagement). Each rule is a simple predicate +
 * message, mirroring the existing `if (condition) { recs.push(...) }` pattern in
 * usageHealthScore.ts, just made inspectable/dismissable rather than baked into one list.
 */
import { AggregatedMetrics, AcceptanceMetrics } from '../types';

export type InsightType = 'tip' | 'opportunity' | 'celebration';

export interface Insight {
  id: string;
  type: InsightType;
  message: string;
  weight: number;
}

export interface InsightContext {
  metrics: AggregatedMetrics;
  acceptance?: AcceptanceMetrics;
  /** Live value of GitHub Copilot's `agentDebugLog.fileLogging.enabled` setting (real cache/token telemetry). */
  copilotDebugLoggingEnabled?: boolean;
  /** Whether the `github.copilot-chat` extension is currently installed. */
  copilotChatExtensionInstalled?: boolean;
}

interface InsightRule {
  id: string;
  type: InsightType;
  weight: number;
  appliesTo: (ctx: InsightContext) => boolean;
  message: (ctx: InsightContext) => string;
}

const RULES: InsightRule[] = [
  {
    id: 'budget-overage-risk',
    type: 'tip',
    weight: 95,
    appliesTo: ctx => ctx.metrics.budget.overageRiskScore > 90,
    message: ctx => `Projected to reach ${Math.round(ctx.metrics.budget.overageRiskScore)}% of your monthly budget at the current pace — review high-cost sessions before month end.`,
  },
  {
    id: 'spend-spike',
    type: 'tip',
    weight: 85,
    appliesTo: ctx => ctx.metrics.anomaly.isSpike,
    message: ctx => `Today's spend is ${ctx.metrics.anomaly.todayZScore.toFixed(1)}σ above your 30-day average — worth a quick look at what changed.`,
  },
  {
    id: 'low-cache-hit-rate',
    type: 'tip',
    weight: 80,
    appliesTo: ctx => ctx.metrics.cache.cacheHitRate < 0.2 && ctx.metrics.cache.totalCacheReadTokens + ctx.metrics.cache.totalCacheWriteTokens > 0,
    message: ctx => `Cache hit rate is only ${Math.round(ctx.metrics.cache.cacheHitRate * 100)}% — place stable system context before dynamic content to reuse more of the cache.`,
  },
  {
    id: 'copilot-real-cache-data-available',
    type: 'tip',
    weight: 60,
    appliesTo: ctx => !!ctx.copilotChatExtensionInstalled && !ctx.copilotDebugLoggingEnabled
      && (ctx.metrics.currentMonthByProvider.copilot.totalTokens > 0 || ctx.metrics.lastMonthByProvider.copilot.totalTokens > 0),
    message: () => `GitHub Copilot cache numbers are calculated estimates, not measured — turn on Copilot's "agentDebugLog.fileLogging" setting for real cache/token data (see the Cache Efficiency widget's "Enable Real Cache Data" button, or run "AI Insights: Enable GitHub Copilot Real Cache Data").`,
  },
  {
    id: 'runaway-sessions',
    type: 'opportunity',
    weight: 75,
    appliesTo: ctx => ctx.metrics.anomaly.runawaySessionsCount > 0,
    message: ctx => `${ctx.metrics.anomaly.runawaySessionsCount} runaway session(s) this month exceeded your token/cost threshold — check the Sessions view to see what drove them.`,
  },
  {
    id: 'low-acceptance-rate',
    type: 'tip',
    weight: 70,
    appliesTo: ctx => (ctx.acceptance?.triggered ?? 0) >= 10 && (ctx.acceptance?.acceptanceRate ?? 0) < 0.15,
    message: ctx => `Suggestion acceptance rate is ${Math.round((ctx.acceptance?.acceptanceRate ?? 0) * 100)}% — try shorter, more specific prompts for inline completions.`,
  },
  {
    id: 'marathon-sessions',
    type: 'tip',
    weight: 65,
    appliesTo: ctx => ctx.metrics.sessionHygiene.marathonSessions > 0,
    message: ctx => `${ctx.metrics.sessionHygiene.marathonSessions} marathon session(s) this month (>80 turns or >3h) — starting fresh with a rehydration brief often works better than pushing through.`,
  },
  {
    id: 'compaction-heavy',
    type: 'tip',
    weight: 55,
    appliesTo: ctx => ctx.metrics.sessionHygiene.autoCompactions >= 3 && ctx.metrics.sessionHygiene.autoCompactions > ctx.metrics.sessionHygiene.manualCompactions * 2,
    message: ctx => `${ctx.metrics.sessionHygiene.autoCompactions} sessions hit auto-compaction vs. only ${ctx.metrics.sessionHygiene.manualCompactions} manual — running /compact earlier keeps more control over what's kept.`,
  },
  {
    id: 'high-thinking-overhead',
    type: 'tip',
    weight: 50,
    appliesTo: ctx => ctx.metrics.roi.thinkingOverheadPct > 30,
    message: ctx => `Thinking tokens are ${Math.round(ctx.metrics.roi.thinkingOverheadPct)}% of total usage — consider a lower reasoning-effort setting for routine tasks.`,
  },
  {
    id: 'tool-heavy-sessions',
    type: 'tip',
    weight: 45,
    appliesTo: ctx => ctx.metrics.sessionComplexity.toolHeavyCount > 5,
    message: ctx => `${ctx.metrics.sessionComplexity.toolHeavyCount} sessions used more than 5 distinct tools — for repeat workflows, a custom skill/agent config can cut this down.`,
  },
  {
    id: 'low-context-anchoring',
    type: 'tip',
    weight: 40,
    appliesTo: ctx => ctx.metrics.contextEngagement.interactionsWithRefs + ctx.metrics.contextEngagement.totalRefs === 0 && ctx.metrics.currentMonth.interactions > 20,
    message: () => `No explicit context references (#file, @workspace, ...) detected this month — anchoring prompts to specific files/selections usually beats relying on ambient context.`,
  },
  {
    id: 'single-turn-sessions',
    type: 'tip',
    weight: 35,
    appliesTo: ctx => ctx.metrics.sessionComplexity.avgSessionDepth < 1.5 && ctx.metrics.currentMonth.sessions > 5,
    message: ctx => `Average session depth is only ${ctx.metrics.sessionComplexity.avgSessionDepth.toFixed(1)} interactions — most sessions end after one turn, missing out on multi-turn context/cache benefits.`,
  },
  {
    id: 'high-cache-hit-celebration',
    type: 'celebration',
    weight: 20,
    appliesTo: ctx => ctx.metrics.cache.cacheHitRate > 0.6,
    message: ctx => `Cache hit rate is ${Math.round(ctx.metrics.cache.cacheHitRate * 100)}% — excellent reuse of context, keep it up!`,
  },
  {
    id: 'healthy-usage-fallback',
    type: 'celebration',
    weight: 5,
    appliesTo: () => true,
    message: () => 'Usage patterns look healthy — keep it up!',
  },
];

/**
 * Returns up to `limit` insights, highest weight first, excluding dismissed IDs and
 * IDs snoozed until a future timestamp. The fallback celebration always matches so
 * the list is never empty, but it's the lowest-weight rule, so any real finding wins.
 */
export function computeInsights(
  ctx: InsightContext,
  dismissedIds: ReadonlySet<string> = new Set(),
  snoozedUntil: Readonly<Record<string, number>> = {},
  limit = 6,
): Insight[] {
  const now = Date.now();
  const matched = RULES.filter(r => {
    if (dismissedIds.has(r.id)) { return false; }
    const snoozeExpiry = snoozedUntil[r.id];
    if (snoozeExpiry && snoozeExpiry > now) { return false; }
    return r.appliesTo(ctx);
  });
  return matched
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map(r => ({ id: r.id, type: r.type, weight: r.weight, message: r.message(ctx) }));
}
