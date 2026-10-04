/**
 * GitHub Copilot live quota fetcher.
 *
 * Reads the authenticated user's real Copilot plan/quota data from GitHub's
 * undocumented internal endpoint (`copilot_internal/user`) - the same one
 * the Copilot Chat extension itself uses to enforce premium-request limits.
 * This is real remaining/entitlement/reset-date data from GitHub, distinct
 * from the token/cost numbers `providers/copilot.ts` estimates from local
 * session logs.
 *
 * Requires an already-connected GitHub session (see githubAuth.ts) - never
 * prompts for sign-in on its own, and fails silently since the endpoint is
 * unofficial and may 403/404 for some accounts, orgs, or outages.
 */
import * as vscode from 'vscode';

const COPILOT_USER_ENDPOINT = 'https://api.github.com/copilot_internal/user';
const MAX_QUOTA_SNAPSHOTS = 90;
const QUOTA_HISTORY_KEY = 'aiInsights.copilotQuotaHistory';

export interface CopilotQuotaSnapshot {
  quota_id: string;
  entitlement: number;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
  overage_permitted: boolean;
}

export interface CopilotQuotaData {
  login: string;
  copilot_plan: string;
  quota_snapshots: Record<string, CopilotQuotaSnapshot>;
  quota_reset_date_utc: string;
}

export interface QuotaStats {
  used: number;
  remaining: number;
  entitlement: number;
  percentRemaining: number;
  percentUsed: number;
  isOverQuota: boolean;
  overageAmount: number;
}

export interface LocalQuotaSnapshot {
  timestamp: string;
  remaining: number;
  entitlement: number;
}

export interface QuotaPrediction {
  predictedDailyUsage: number;
  daysUntilExhaustion: number | null;
  willExhaustBeforeReset: boolean;
  confidence: 'low' | 'medium' | 'high';
  dataPoints: number;
}

/** Flattened, display-ready view of the current quota - what webviews/status bar consume. */
export interface CopilotQuotaView {
  planLabel: string;
  unlimited: boolean;
  remaining: number;
  entitlement: number;
  percentRemaining: number;
  percentUsed: number;
  isOverQuota: boolean;
  overageAmount: number;
  resetDays: number;
  resetHours: number;
  predictedDailyUsage: number | null;
  daysUntilExhaustion: number | null;
}

export async function fetchCopilotQuota(accessToken: string): Promise<CopilotQuotaData | null> {
  try {
    const response = await fetch(COPILOT_USER_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'AI-Insights-VSCode-Extension',
      },
    });
    if (!response.ok) { return null; }
    const data = await response.json() as Partial<CopilotQuotaData> | undefined;
    if (!data || typeof data !== 'object') { return null; }
    return {
      login: data.login ?? '',
      copilot_plan: data.copilot_plan ?? '',
      quota_snapshots: data.quota_snapshots ?? {},
      quota_reset_date_utc: data.quota_reset_date_utc ?? '',
    };
  } catch {
    return null;
  }
}

export function findPremiumQuota(data: CopilotQuotaData): CopilotQuotaSnapshot | undefined {
  return Object.values(data.quota_snapshots ?? {}).find(q => q.quota_id === 'premium_interactions');
}

export function computeQuotaStats(q: CopilotQuotaSnapshot): QuotaStats {
  const used = Math.max(0, q.entitlement - q.quota_remaining);
  const isOverQuota = q.remaining < 0;
  const percentRemaining = q.entitlement > 0 ? parseFloat(((q.quota_remaining / q.entitlement) * 100).toFixed(1)) : 0;
  const percentUsed = q.entitlement > 0 ? parseFloat(((used / q.entitlement) * 100).toFixed(1)) : 0;
  const overageAmount = isOverQuota ? parseFloat(Math.abs(q.remaining).toFixed(1)) : 0;
  return { used, remaining: q.remaining, entitlement: q.entitlement, percentRemaining, percentUsed, isOverQuota, overageAmount };
}

export function daysUntilReset(resetDateUtc: string, asOf = new Date()): { days: number; hours: number } | null {
  if (!resetDateUtc) { return null; }
  const reset = new Date(resetDateUtc).getTime();
  if (Number.isNaN(reset)) { return null; }
  const diffDays = (reset - asOf.getTime()) / (1000 * 60 * 60 * 24);
  const days = Math.floor(diffDays);
  const hours = Math.floor((diffDays - days) * 24);
  return { days: Math.max(0, days), hours: Math.max(0, hours) };
}

/**
 * Persists a rolling local history of quota snapshots (max 90), keyed per
 * GitHub login so switching accounts doesn't mix usage data. Not used for the
 * burn-rate prediction (see getQuotaPrediction) - snapshots span billing
 * cycles and plan changes, which made pairwise deltas meaningless.
 */
export class QuotaHistoryStore {
  private _snapshots: LocalQuotaSnapshot[] = [];
  private _login: string | undefined;

  constructor(private readonly _globalState: vscode.Memento) { }

  get snapshots(): readonly LocalQuotaSnapshot[] { return this._snapshots; }

  private get _storageKey(): string {
    return this._login ? `${QUOTA_HISTORY_KEY}.${this._login}` : QUOTA_HISTORY_KEY;
  }

  setAccount(login: string): void {
    if (!login || this._login === login) { return; }
    this._login = login;
    this._snapshots = this._globalState.get<LocalQuotaSnapshot[]>(this._storageKey, []);
  }

  add(remaining: number, entitlement: number): void {
    if (entitlement <= 0) { return; }
    if (this._snapshots.length > 0 && this._snapshots[0].remaining === remaining) { return; }

    this._snapshots.unshift({ timestamp: new Date().toISOString(), remaining, entitlement });
    if (this._snapshots.length > MAX_QUOTA_SNAPSHOTS) {
      this._snapshots = this._snapshots.slice(0, MAX_QUOTA_SNAPSHOTS);
    }
    void this._globalState.update(this._storageKey, this._snapshots);
  }
}

/**
 * Burn-rate prediction from GitHub's own cycle-to-date figure: requests used
 * this billing cycle / days elapsed since the cycle started (reset date minus
 * one calendar month). Uses only the current cycle and current entitlement, so
 * plan changes and previous cycles in the local snapshot history cannot leak
 * in, and requests made while the editor was closed still count. Elapsed time
 * is floored at one day so the first hours of a cycle don't extrapolate a burst.
 */
export function getQuotaPrediction(
  quota: CopilotQuotaSnapshot,
  resetDateUtc: string,
  asOf = new Date(),
): QuotaPrediction | null {
  if (quota.unlimited || quota.entitlement <= 0) { return null; }
  const resetMs = new Date(resetDateUtc).getTime();
  if (Number.isNaN(resetMs)) { return null; }

  const cycleStart = new Date(resetMs);
  cycleStart.setUTCMonth(cycleStart.getUTCMonth() - 1);
  const elapsedDays = (asOf.getTime() - cycleStart.getTime()) / 86_400_000;
  if (elapsedDays <= 0) { return null; }

  const used = Math.max(0, quota.entitlement - quota.quota_remaining);
  if (used === 0) { return null; }

  const predictedDailyUsage = used / Math.max(elapsedDays, 1);
  const confidence: QuotaPrediction['confidence'] =
    elapsedDays >= 7 ? 'high' : elapsedDays >= 3 ? 'medium' : 'low';

  const daysUntilExhaustionValue = Math.floor(Math.max(0, quota.remaining) / predictedDailyUsage);
  const reset = daysUntilReset(resetDateUtc, asOf);
  const willExhaustBeforeReset = reset !== null
    && daysUntilExhaustionValue < (reset.days + reset.hours / 24);

  return {
    predictedDailyUsage: Math.round(predictedDailyUsage),
    daysUntilExhaustion: daysUntilExhaustionValue,
    willExhaustBeforeReset,
    confidence,
    dataPoints: Math.floor(elapsedDays),
  };
}

export interface BudgetPlan {
  sustainableDailyRequests: number;
  sustainableWeeklyRequests: number;
  daysRemaining: number;
}

/**
 * Sustainable request-pacing plan: how many requests/day (and /week) you can
 * make without exhausting quota before reset, given a model cost multiplier
 * (e.g. 0.33x for a cheap model, 3x for an expensive one) and an optional
 * reserve to keep untouched. Resolves copilotQuota's own long-standing "no
 * per-model premium-request multiplier" gap (see costEstimation.md gap #1).
 */
export function computeBudgetPlan(
  quota: CopilotQuotaView,
  modelMultiplier: number,
  reserveCredits: number,
): BudgetPlan | null {
  if (quota.unlimited) { return null; }
  const daysRemaining = Math.max(quota.resetDays + quota.resetHours / 24, 1 / 24);

  const usable = Math.max(0, quota.remaining - reserveCredits);
  const safeMultiplier = modelMultiplier > 0 ? modelMultiplier : 1;
  const sustainableDailyRequests = usable / daysRemaining / safeMultiplier;
  const sustainableWeeklyRequests = sustainableDailyRequests * Math.min(7, daysRemaining);

  return {
    sustainableDailyRequests: Math.round(sustainableDailyRequests * 10) / 10,
    sustainableWeeklyRequests: Math.round(sustainableWeeklyRequests * 10) / 10,
    daysRemaining: Math.round(daysRemaining * 10) / 10,
  };
}

/** Builds the flattened view model shared by the status bar and dashboard card. */
export function buildQuotaView(data: CopilotQuotaData): CopilotQuotaView | undefined {
  const premium = findPremiumQuota(data);
  if (!premium) { return undefined; }
  const reset = daysUntilReset(data.quota_reset_date_utc) ?? { days: 0, hours: 0 };

  if (premium.unlimited) {
    return {
      planLabel: data.copilot_plan,
      unlimited: true,
      remaining: 0,
      entitlement: 0,
      percentRemaining: 100,
      percentUsed: 0,
      isOverQuota: false,
      overageAmount: 0,
      resetDays: reset.days,
      resetHours: reset.hours,
      predictedDailyUsage: null,
      daysUntilExhaustion: null,
    };
  }

  const stats = computeQuotaStats(premium);
  const prediction = getQuotaPrediction(premium, data.quota_reset_date_utc);
  return {
    planLabel: data.copilot_plan,
    unlimited: false,
    remaining: stats.remaining,
    entitlement: stats.entitlement,
    percentRemaining: stats.percentRemaining,
    percentUsed: stats.percentUsed,
    isOverQuota: stats.isOverQuota,
    overageAmount: stats.overageAmount,
    resetDays: reset.days,
    resetHours: reset.hours,
    predictedDailyUsage: prediction?.predictedDailyUsage ?? null,
    daysUntilExhaustion: prediction?.willExhaustBeforeReset ? prediction.daysUntilExhaustion : null,
  };
}
