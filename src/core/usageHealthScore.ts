import { AggregatedMetrics, AcceptanceMetrics, Session } from '../types';
import { computeContextRotScore } from './contextRot';

export interface HealthComponent {
  label: string;
  /** 0–100 normalized score for this component */
  score: number;
  /** Weighted point contribution (sum of maxPoints = 100) */
  points: number;
  maxPoints: number;
  detail: string;
}

export interface UsageHealthScore {
  /** 0–100 composite score */
  overall: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  gradeColor: string;
  components: HealthComponent[];
  /** Up to 3 actionable improvement bullets */
  topRecommendations: string[];
}

function gradeOf(s: number): { grade: 'A' | 'B' | 'C' | 'D' | 'F'; color: string } {
  if (s >= 85) { return { grade: 'A', color: '#39FF14' }; }
  if (s >= 70) { return { grade: 'B', color: '#a6e3a1' }; }
  if (s >= 55) { return { grade: 'C', color: '#f9e2af' }; }
  if (s >= 40) { return { grade: 'D', color: '#fab387' }; }
  return { grade: 'F', color: '#f38ba8' };
}

export function computeUsageHealthScore(
  metrics: AggregatedMetrics,
  recentSessions: Session[],
  acceptance?: AcceptanceMetrics,
): UsageHealthScore {
  const components: HealthComponent[] = [];
  const recs: string[] = [];

  // ── 1. Cache Efficiency (25 pts) ───────────────────────────────────────────
  // Full score at ≥40% hit rate; scales linearly below.
  const hitRate = metrics.cache.cacheHitRate;
  const cacheScore = Math.round(Math.min(1, hitRate / 0.4) * 100);
  const cachePoints = Math.round(cacheScore * 0.25);
  components.push({
    label: 'Cache Efficiency',
    score: cacheScore,
    points: cachePoints,
    maxPoints: 25,
    detail: `${Math.round(hitRate * 100)}% cache hit rate`,
  });
  if (hitRate < 0.2) {
    recs.push('Place stable system context before dynamic content to improve cache hit rate');
  }

  // ── 2. Context Quality (25 pts) ────────────────────────────────────────────
  // Average contextQualityScore (0–100) across last 20 scored sessions.
  const scoredSessions = recentSessions
    .slice(0, 30)
    .filter(s => s.interactions.length >= 3);
  let avgCQ = 50;
  if (scoredSessions.length > 0) {
    const cqValues = scoredSessions.map(s => {
      const rot = computeContextRotScore(s);
      return rot.contextQualityScore ?? 50;
    });
    avgCQ = cqValues.reduce((a, b) => a + b, 0) / cqValues.length;
  }
  const ctxPoints = Math.round((avgCQ / 100) * 25);
  components.push({
    label: 'Context Quality',
    score: Math.round(avgCQ),
    points: ctxPoints,
    maxPoints: 25,
    detail: `avg ${Math.round(avgCQ)}/100 across recent sessions`,
  });
  if (avgCQ < 50) {
    recs.push('Restart sessions more often — context rot is reducing response quality over time');
  }

  // ── 3. Cost Efficiency (20 pts) ────────────────────────────────────────────
  // Output/input token ratio. Full score at ratio ≥0.25 (generating ¼ token out per in).
  const eff = metrics.roi.inputEfficiencyRatio;
  const effScore = Math.round(Math.min(1, eff / 0.25) * 100);
  const effPoints = Math.round(effScore * 0.20);
  components.push({
    label: 'Cost Efficiency',
    score: effScore,
    points: effPoints,
    maxPoints: 20,
    detail: `${eff.toFixed(3)} output/input ratio`,
  });
  if (eff < 0.08) {
    recs.push('Low output/input ratio — use more targeted prompts to extract more per token spent');
  }

  // ── 4. Completion Acceptance (15 pts) ──────────────────────────────────────
  // Full score at ≥30% acceptance rate; neutral 8 pts when data is insufficient.
  const accRate = acceptance?.acceptanceRate ?? 0;
  const hasAccData = (acceptance?.triggered ?? 0) >= 10;
  const accScore = hasAccData ? Math.round(Math.min(1, accRate / 0.30) * 100) : 50;
  const accPoints = hasAccData ? Math.round(accScore * 0.15) : 8;
  components.push({
    label: 'Completion Acceptance',
    score: accScore,
    points: accPoints,
    maxPoints: 15,
    detail: hasAccData
      ? `${Math.round(accRate * 100)}% acceptance rate`
      : 'not enough data yet',
  });
  if (hasAccData && accRate < 0.15) {
    recs.push('Acceptance rate is low — try shorter, more specific prompts for inline completions');
  }

  // ── 5. Budget Health (15 pts) ──────────────────────────────────────────────
  // Full score when no budget used; zero at 100% utilized.
  const budgetUsedFraction = Math.min(1, metrics.budget.budgetUtilizationPct / 100);
  const budgetScore = Math.round((1 - budgetUsedFraction) * 100);
  const budgetPoints = Math.round(budgetScore * 0.15);
  components.push({
    label: 'Budget Health',
    score: budgetScore,
    points: budgetPoints,
    maxPoints: 15,
    detail: `${Math.round(metrics.budget.budgetUtilizationPct)}% of monthly budget consumed`,
  });
  if (budgetUsedFraction > 0.8) {
    recs.push('Over 80% of monthly budget used — review top sessions in Sessions view to find optimization targets');
  }

  const overall = components.reduce((s, c) => s + c.points, 0);
  const { grade, color } = gradeOf(overall);

  if (recs.length === 0) {
    recs.push('Usage patterns look healthy — keep it up!');
  }

  return {
    overall,
    grade,
    gradeColor: color,
    components,
    topRecommendations: recs.slice(0, 3),
  };
}
