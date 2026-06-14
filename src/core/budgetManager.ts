/**
 * Budget, cache, ROI, anomaly, and session-complexity metric computations.
 * All functions operate on already-aggregated ProviderMetrics or raw Sessions.
 */
import {
  Session,
  DailyUsage,
  ProviderMetrics,
  ProviderId,
  AggregationConfig,
  AlertThresholds,
  BudgetMetrics,
  CacheMetrics,
  ROIMetrics,
  AnomalyFlags,
  SessionComplexityMetrics,
} from '../types';
import { calculateCost } from './costEstimation';
import { toLocalDateKey } from './dateUtils';

const DEFAULT_THRESHOLDS: AlertThresholds = {
  budgetWarningPct: 80,
  budgetCriticalPct: 95,
  runawaySessionTokens: 100_000,
  runawaySessionCostUsd: 1.0,
};

// ─── Budget ──────────────────────────────────────────────────────────────────

export function computeBudgetMetrics(
  now: Date,
  currentMonth: ProviderMetrics,
  config: AggregationConfig,
): BudgetMetrics {
  const planBudget = config.planBudget ?? 10;
  const teamSize = config.teamSize ?? 1;

  const daysElapsed = Math.max(1, now.getDate());
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysRemaining = daysInMonth - daysElapsed;

  const mtdSpend = currentMonth.estimatedCost;
  const creditsRemaining = Math.max(0, planBudget - mtdSpend);
  const dailyBurnRate = mtdSpend / daysElapsed;
  const projectedMonthEnd = dailyBurnRate * daysInMonth;

  // Hourly burn: smooth 30-day average daily rate divided into hours
  const hourlyBurnRate = dailyBurnRate / 24;

  const daysUntilExhausted =
    dailyBurnRate > 0 && creditsRemaining > 0
      ? creditsRemaining / dailyBurnRate
      : null;

  const overageRiskScore = planBudget > 0 ? Math.min(200, (projectedMonthEnd / planBudget) * 100) : 0;
  const budgetUtilizationPct = planBudget > 0 ? Math.min(100, (mtdSpend / planBudget) * 100) : 0;
  const teamProjectedCost = projectedMonthEnd * teamSize;

  return {
    planBudget,
    mtdSpend,
    creditsRemaining,
    dailyBurnRate,
    hourlyBurnRate,
    daysElapsed,
    daysInMonth,
    daysRemaining,
    daysUntilExhausted,
    projectedMonthEnd,
    overageRiskScore,
    budgetUtilizationPct,
    teamSize,
    teamProjectedCost,
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

export function computeCacheMetrics(currentMonth: ProviderMetrics): CacheMetrics {
  const { inputTokens, cacheReadTokens, cacheWriteTokens, cacheSavingsUsd } = currentMonth;

  const totalInput = inputTokens + cacheReadTokens;
  const cacheHitRate = totalInput > 0 ? cacheReadTokens / totalInput : 0;
  const cacheWriteReadRatio = cacheWriteTokens > 0 ? cacheReadTokens / cacheWriteTokens : 0;

  return {
    cacheHitRate,
    cacheSavingsUsd,
    cacheWriteReadRatio,
    totalCacheReadTokens: cacheReadTokens,
    totalCacheWriteTokens: cacheWriteTokens,
  };
}

// ─── ROI ──────────────────────────────────────────────────────────────────────

export function computeROIMetrics(
  currentMonth: ProviderMetrics,
  byProvider: Record<ProviderId, ProviderMetrics>,
): ROIMetrics {
  const { outputTokens, inputTokens, thinkingTokens, totalTokens, estimatedCost, sessions, interactions } = currentMonth;

  const outputTokensPerDollar = estimatedCost > 0 ? outputTokens / estimatedCost : 0;
  const inputEfficiencyRatio = inputTokens > 0 ? outputTokens / inputTokens : 0;
  const thinkingOverheadPct = totalTokens > 0 ? (thinkingTokens / totalTokens) * 100 : 0;
  const costPerSession = sessions > 0 ? estimatedCost / sessions : 0;
  const costPerInteraction = interactions > 0 ? estimatedCost / interactions : 0;

  // Provider efficiency: output tokens per dollar
  const providerCostPer1KOutput: Record<string, number> = {};
  let bestProvider = '';
  let bestEfficiency = 0;

  for (const [id, p] of Object.entries(byProvider)) {
    if (p.outputTokens > 0 && p.estimatedCost > 0) {
      const costPer1K = (p.estimatedCost / p.outputTokens) * 1000;
      providerCostPer1KOutput[id] = costPer1K;
      const eff = p.outputTokens / p.estimatedCost;
      if (eff > bestEfficiency) {
        bestEfficiency = eff;
        bestProvider = id;
      }
    }
  }

  return {
    outputTokensPerDollar,
    inputEfficiencyRatio,
    thinkingOverheadPct,
    costPerSession,
    costPerInteraction,
    mostEfficientProvider: bestProvider,
    providerCostPer1KOutput,
  };
}

// ─── Anomaly ──────────────────────────────────────────────────────────────────

export function computeAnomalyFlags(
  now: Date,
  sessions: Session[],
  daily: DailyUsage[],
  config: AggregationConfig,
): AnomalyFlags {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config.alertThresholds };
  const planBudget = config.planBudget ?? 10;

  // Last 30 days of daily cost
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 30);
  const recentDaily = daily.filter(d => d.date >= toLocalDateKey(cutoff));

  const todayStr = toLocalDateKey(now);
  const todayCost = recentDaily.find(d => d.date === todayStr)?.estimatedCost ?? 0;
  const pastDays = recentDaily.filter(d => d.date < todayStr);

  let todayZScore = 0;
  let isSpike = false;
  if (pastDays.length >= 3) {
    const mean = pastDays.reduce((s, d) => s + d.estimatedCost, 0) / pastDays.length;
    const variance = pastDays.reduce((s, d) => s + Math.pow(d.estimatedCost - mean, 2), 0) / pastDays.length;
    const stddev = Math.sqrt(variance);
    todayZScore = stddev > 0 ? (todayCost - mean) / stddev : 0;
    isSpike = todayZScore > 2.0;
  }

  // Runaway sessions: token OR cost over threshold
  const runawaySessionsCount = sessions.filter(sess => {
    const sessCost = sess.interactions.reduce(
      (s, i) => s + calculateCost(i.model, i.inputTokens, i.outputTokens, i.cacheReadTokens, i.cacheWriteTokens), 0
    );
    return sess.totalTokens > thresholds.runawaySessionTokens || sessCost > thresholds.runawaySessionCostUsd;
  }).length;

  // Burn acceleration: compare last 7 days vs prior 7 days
  const week1End = new Date(now); week1End.setDate(week1End.getDate() - 7);
  const week2End = new Date(now); week2End.setDate(week2End.getDate() - 14);
  const week1Str = toLocalDateKey(week1End);
  const week2Str = toLocalDateKey(week2End);

  const week1Cost = recentDaily.filter(d => d.date > week1Str && d.date <= todayStr)
    .reduce((s, d) => s + d.estimatedCost, 0);
  const week2Cost = recentDaily.filter(d => d.date > week2Str && d.date <= week1Str)
    .reduce((s, d) => s + d.estimatedCost, 0);
  const burnAcceleration = week2Cost > 0 ? week1Cost / week2Cost : (week1Cost > 0 ? 2 : 1);

  // Consecutive high-spend days (above 80% of expected daily budget pace)
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dailyBudget = planBudget / daysInMonth;
  const highThreshold = dailyBudget * 0.8;

  let consecutiveHighDays = 0;
  const sortedDays = [...recentDaily].sort((a, b) => b.date.localeCompare(a.date));
  for (const d of sortedDays) {
    if (d.estimatedCost >= highThreshold) {
      consecutiveHighDays++;
    } else {
      break;
    }
  }

  return { todayZScore, isSpike, runawaySessionsCount, burnAcceleration, consecutiveHighDays };
}

// ─── Session Complexity ───────────────────────────────────────────────────────

export function computeSessionComplexity(
  sessions: Session[],
  config: AggregationConfig,
): SessionComplexityMetrics {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config.alertThresholds };

  if (sessions.length === 0) {
    return {
      avgSessionDepth: 0,
      longSessionsCount: 0,
      longSessionsCost: 0,
      toolHeavyCount: 0,
      thinkingSessionsCount: 0,
      multiModelSessionsCount: 0,
      avgSessionDurationMin: 0,
      highestCostSession: null,
    };
  }

  const LONG_SESSION_MS = 30 * 60 * 1000;

  let totalInteractions = 0;
  let totalDurationMs = 0;
  let longSessionsCount = 0;
  let longSessionsCost = 0;
  let toolHeavyCount = 0;
  let thinkingSessionsCount = 0;
  let multiModelSessionsCount = 0;
  let highestCostSession: { id: string; cost: number; tokens: number } | null = null;

  for (const sess of sessions) {
    totalInteractions += sess.interactions.length;
    const durationMs = sess.endTime.getTime() - sess.startTime.getTime();
    totalDurationMs += Math.max(0, durationMs);

    const sessCost = sess.interactions.reduce(
      (s, i) => s + calculateCost(i.model, i.inputTokens, i.outputTokens, i.cacheReadTokens, i.cacheWriteTokens), 0
    );

    if (durationMs > LONG_SESSION_MS) {
      longSessionsCount++;
      longSessionsCost += sessCost;
    }

    const uniqueTools = new Set(sess.interactions.flatMap(i => i.toolCalls));
    if (uniqueTools.size > 5) { toolHeavyCount++; }

    if (sess.totalThinkingTokens > 0) { thinkingSessionsCount++; }
    if (sess.models.length > 1) { multiModelSessionsCount++; }

    if (!highestCostSession || sessCost > highestCostSession.cost) {
      highestCostSession = { id: sess.id, cost: sessCost, tokens: sess.totalTokens };
    }
  }

  return {
    avgSessionDepth: totalInteractions / sessions.length,
    longSessionsCount,
    longSessionsCost,
    toolHeavyCount,
    thinkingSessionsCount,
    multiModelSessionsCount,
    avgSessionDurationMin: totalDurationMs / sessions.length / 60_000,
    highestCostSession,
  };
}
