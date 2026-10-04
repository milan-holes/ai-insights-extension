/**
 * Quota Guard - turns the real provider quota signals into an actionable
 * "how much working time is left in this window" risk assessment.
 *
 * The three providers expose quota in three different shapes and units:
 *
 * | Provider    | Signal                                            | Unit     | Source        |
 * |-------------|---------------------------------------------------|----------|---------------|
 * | Copilot     | `copilot_internal/user` premium-request remaining  | requests | live API      |
 * | Claude Code | `anthropic-ratelimit-unified-5h/-7d-utilization`  | percent  | live API      |
 * | Codex       | `rate_limits` on `token_count` session-log entries | percent  | session log   |
 *
 * `toQuotaWindow*()` normalizes all of them into `QuotaWindow`, and
 * `assessQuotaRisk()` converts a window into a `QuotaRisk` whose headline number
 * is *minutes of work left at the current burn rate* - the only unit that
 * answers "can I finish this refactor before the wall?". A raw percentage
 * cannot: 90% used is harmless at the end of a window and fatal at the start.
 *
 * Burn rate comes from `QuotaWindowHistoryStore`, a rolling per-window history
 * of utilization samples (same pattern as copilotQuota's `QuotaHistoryStore`,
 * but keyed per window and measured in %/min).
 *
 * All functions here are pure except the history store, so thresholds and
 * severity transitions stay unit-testable without a VS Code host.
 */
import * as vscode from 'vscode';
import { ProviderId, Session } from '../types';
import { CopilotQuotaView } from './copilotQuota';
import { ClaudeRateLimitSnapshot } from './claudeQuota';

const HISTORY_KEY_PREFIX = 'aiInsights.quotaWindowHistory';
const MAX_SAMPLES_PER_WINDOW = 60;
/** Samples older than this are ignored when computing burn rate. */
const BURN_LOOKBACK_MINUTES = 90;
/** Need at least this much elapsed time between samples for a meaningful rate. */
const MIN_BURN_SPAN_MINUTES = 2;
/**
 * How long a quota reading recorded in a session log stays trustworthy. Live-API
 * readings are current by definition; a log entry is only a recording of what
 * was true when it was written.
 */
const SESSION_LOG_QUOTA_MAX_AGE_MINUTES = 60;
/**
 * How long a cached live-API reading stays trustworthy. Generous compared to the
 * 5-minute poll interval, but bounded so a long run of failed fetches can't
 * raise a warning from an hours-old number.
 */
const LIVE_QUOTA_MAX_AGE_MINUTES = 30;

export type QuotaSeverity = 'ok' | 'warning' | 'critical' | 'exhausted';

/** A single provider rate-limit window, normalized across providers. */
export interface QuotaWindow {
  provider: ProviderId;
  /** Stable key for history/cooldown bookkeeping, e.g. `claudeCode:5h`. */
  windowId: string;
  /** Human label for notifications, e.g. "Claude 5h window". */
  label: string;
  /** 0-100 utilization of this window. */
  pctUsed: number;
  /** ISO datetime the window resets, when the provider reports one. */
  resetsAt: string | null;
  /** Remaining capacity in native units (Copilot premium requests); null when percent-only. */
  remainingUnits: number | null;
  /** Total capacity in native units; null when percent-only. */
  totalUnits: number | null;
  unit: 'requests' | 'percent';
  /** Whether this came from a live API call or was read out of a local session log. */
  source: 'live-api' | 'session-log';
  /** Provider-reported plan name, when available. */
  planLabel?: string;
  /** Set when the provider explicitly reports the limit was already hit. */
  reachedLimit?: boolean;
}

export interface QuotaRisk {
  window: QuotaWindow;
  severity: QuotaSeverity;
  /** Minutes of work left at the measured burn rate; null when burn rate is unknown. */
  minutesOfWorkLeft: number | null;
  /** Minutes until this window resets; null when the provider reports no reset time. */
  minutesUntilReset: number | null;
  /** Measured utilization burn in %/min; null when there isn't enough history yet. */
  burnPctPerMin: number | null;
  /**
   * True when the window resets before the quota would run out - i.e. the
   * percentage looks alarming but there is no actual cliff ahead. Suppresses
   * the warning, which is what keeps this from crying wolf.
   */
  resetsBeforeExhaustion: boolean;
  /** One-line human summary used in notifications and the status bar tooltip. */
  message: string;
}

export interface QuotaGuardThresholds {
  /** Warn once fewer than this many minutes of work remain. */
  warnMinutesOfWork: number;
  /** Escalate to critical below this many minutes of work. */
  criticalMinutesOfWork: number;
  /** Fallback warn threshold when burn rate can't be measured yet. */
  warnPercentUsed: number;
  /** Fallback critical threshold when burn rate can't be measured yet. */
  criticalPercentUsed: number;
}

export const DEFAULT_QUOTA_THRESHOLDS: QuotaGuardThresholds = {
  warnMinutesOfWork: 15,
  criticalMinutesOfWork: 5,
  warnPercentUsed: 85,
  criticalPercentUsed: 95,
};

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Copilot's premium-request quota. Unlimited plans produce no window - there is
 * no wall to warn about.
 */
export function toCopilotQuotaWindow(view: CopilotQuotaView | undefined): QuotaWindow | null {
  if (!view || view.unlimited) { return null; }
  const resetsAt = new Date(Date.now() + (view.resetDays * 24 + view.resetHours) * 3_600_000).toISOString();
  return {
    provider: 'copilot',
    windowId: 'copilot:premium',
    label: 'Copilot premium requests',
    pctUsed: clampPct(view.percentUsed),
    resetsAt,
    remainingUnits: view.remaining,
    totalUnits: view.entitlement,
    unit: 'requests',
    source: 'live-api',
    planLabel: view.planLabel,
    reachedLimit: view.isOverQuota,
  };
}

/**
 * Claude Code's 5-hour and weekly session windows.
 *
 * The in-memory snapshot is reused between polls and is only refreshed every
 * `MIN_REFRESH_INTERVAL_MS`, so a run of failed fetches can leave it behind.
 * Anything older than `LIVE_QUOTA_MAX_AGE_MINUTES` is dropped rather than
 * reported as current - a warning from stale data is worse than no warning.
 */
export function toClaudeQuotaWindows(snapshot: ClaudeRateLimitSnapshot | null, now = new Date()): QuotaWindow[] {
  if (!snapshot) { return []; }

  const ageMinutes = (now.getTime() - new Date(snapshot.fetchedAt).getTime()) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > LIVE_QUOTA_MAX_AGE_MINUTES) { return []; }

  const windows: QuotaWindow[] = [];

  if (snapshot.fiveHourPct !== null) {
    windows.push({
      provider: 'claudeCode',
      windowId: 'claudeCode:5h',
      label: 'Claude 5h window',
      pctUsed: clampPct(snapshot.fiveHourPct),
      resetsAt: parseResetHeader(snapshot.fiveHourResetsAt),
      remainingUnits: null,
      totalUnits: null,
      unit: 'percent',
      source: 'live-api',
    });
  }

  if (snapshot.sevenDayPct !== null) {
    windows.push({
      provider: 'claudeCode',
      windowId: 'claudeCode:7d',
      label: 'Claude weekly window',
      pctUsed: clampPct(snapshot.sevenDayPct),
      resetsAt: parseResetHeader(snapshot.sevenDayResetsAt),
      remainingUnits: null,
      totalUnits: null,
      unit: 'percent',
      source: 'live-api',
    });
  }

  return windows;
}

/**
 * Codex quota, read from the `rate_limits` object the CLI already writes onto
 * every `token_count` entry in its own rollout log (see providers/codex.ts) -
 * no network call, and it keeps working for plans with no public quota API.
 * Uses the most recently captured snapshot across the given sessions.
 *
 * Unlike the live-API providers, this data is a *recording* rather than a
 * reading, so it is only trusted while fresh: a snapshot older than
 * `SESSION_LOG_QUOTA_MAX_AGE_MINUTES`, or a window whose reset time has already
 * passed, is discarded rather than reported as current. Without this, a months-old
 * rollout log showing 95% used would raise a warning about a window that has
 * long since rolled over.
 */
export function toCodexQuotaWindows(sessions: Session[], now = new Date()): QuotaWindow[] {
  let latest: Session['rateLimits'] | undefined;
  for (const session of sessions) {
    if (session.provider !== 'codex' || !session.rateLimits) { continue; }
    if (!latest || session.rateLimits.capturedAt > latest.capturedAt) {
      latest = session.rateLimits;
    }
  }
  if (!latest) { return []; }

  const ageMinutes = (now.getTime() - new Date(latest.capturedAt).getTime()) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes > SESSION_LOG_QUOTA_MAX_AGE_MINUTES) { return []; }

  const windows: QuotaWindow[] = [];
  const reached = Boolean(latest.rateLimitReachedType);

  for (const [key, win] of [['primary', latest.primary], ['secondary', latest.secondary]] as const) {
    if (!win) { continue; }
    // A window past its own reset time has rolled over; its recorded
    // utilization describes the previous window, not the current one.
    if (win.resetsAt && new Date(win.resetsAt).getTime() <= now.getTime()) { continue; }
    windows.push({
      provider: 'codex',
      windowId: `codex:${key}`,
      label: `Codex ${formatWindowLength(win.windowMinutes)} window`,
      pctUsed: clampPct(win.usedPercent),
      resetsAt: win.resetsAt,
      remainingUnits: null,
      totalUnits: null,
      unit: 'percent',
      source: 'session-log',
      planLabel: latest.planType,
      reachedLimit: reached,
    });
  }

  return windows;
}

// ─── Burn-rate history ────────────────────────────────────────────────────────

export interface QuotaSample {
  /** ISO timestamp. */
  t: string;
  pctUsed: number;
}

/**
 * Rolling per-window utilization history, persisted in global state, from which
 * burn rate (%/min) is derived. Kept separate from copilotQuota's
 * `QuotaHistoryStore` because that one tracks remaining *requests* per GitHub
 * login for daily-granularity predictions; this one tracks *percent* per window
 * at minute granularity, which is what an in-session warning needs.
 */
export class QuotaWindowHistoryStore {
  constructor(private readonly _globalState: vscode.Memento) { }

  private _key(windowId: string): string { return `${HISTORY_KEY_PREFIX}.${windowId}`; }

  samples(windowId: string): QuotaSample[] {
    return this._globalState.get<QuotaSample[]>(this._key(windowId), []);
  }

  /** Appends a sample, skipping no-op repeats so an idle poll doesn't flatten the rate. */
  record(windowId: string, pctUsed: number, now = new Date()): void {
    const existing = this.samples(windowId);
    const last = existing[existing.length - 1];
    if (last && last.pctUsed === pctUsed) { return; }
    const next = [...existing, { t: now.toISOString(), pctUsed }].slice(-MAX_SAMPLES_PER_WINDOW);
    void this._globalState.update(this._key(windowId), next);
  }

  burnPctPerMin(windowId: string, now = new Date()): number | null {
    return computeBurnPctPerMin(this.samples(windowId), now);
  }
}

/**
 * Burn rate from the recent sample window. Any drop in utilization means the
 * window rolled over, so only samples after the most recent reset are used -
 * averaging across a reset would badly understate the current rate.
 */
export function computeBurnPctPerMin(samples: QuotaSample[], now = new Date()): number | null {
  const cutoff = now.getTime() - BURN_LOOKBACK_MINUTES * 60_000;
  const recent = samples.filter(s => new Date(s.t).getTime() >= cutoff);
  if (recent.length < 2) { return null; }

  let startIndex = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].pctUsed < recent[i - 1].pctUsed) { startIndex = i; }
  }
  const usable = recent.slice(startIndex);
  if (usable.length < 2) { return null; }

  const first = usable[0];
  const last = usable[usable.length - 1];
  const spanMinutes = (new Date(last.t).getTime() - new Date(first.t).getTime()) / 60_000;
  if (spanMinutes < MIN_BURN_SPAN_MINUTES) { return null; }

  const deltaPct = last.pctUsed - first.pctUsed;
  if (deltaPct <= 0) { return null; }
  return deltaPct / spanMinutes;
}

// ─── Risk assessment ──────────────────────────────────────────────────────────

export function assessQuotaRisk(
  window: QuotaWindow,
  burnPctPerMin: number | null,
  thresholds: QuotaGuardThresholds = DEFAULT_QUOTA_THRESHOLDS,
  now = new Date(),
): QuotaRisk {
  const minutesUntilReset = window.resetsAt
    ? Math.max(0, (new Date(window.resetsAt).getTime() - now.getTime()) / 60_000)
    : null;

  const pctRemaining = Math.max(0, 100 - window.pctUsed);
  const minutesOfWorkLeft = burnPctPerMin && burnPctPerMin > 0
    ? pctRemaining / burnPctPerMin
    : null;

  const exhausted = window.reachedLimit === true
    || window.pctUsed >= 100
    || (window.remainingUnits !== null && window.remainingUnits <= 0);

  // A window that rolls over before the quota runs out poses no cliff, however
  // high the percentage looks.
  const resetsBeforeExhaustion = !exhausted
    && minutesUntilReset !== null
    && minutesOfWorkLeft !== null
    && minutesUntilReset <= minutesOfWorkLeft;

  let severity: QuotaSeverity;
  if (exhausted) {
    severity = 'exhausted';
  } else if (resetsBeforeExhaustion) {
    severity = 'ok';
  } else if (minutesOfWorkLeft !== null) {
    severity = minutesOfWorkLeft <= thresholds.criticalMinutesOfWork ? 'critical'
      : minutesOfWorkLeft <= thresholds.warnMinutesOfWork ? 'warning'
        : 'ok';
  } else {
    severity = window.pctUsed >= thresholds.criticalPercentUsed ? 'critical'
      : window.pctUsed >= thresholds.warnPercentUsed ? 'warning'
        : 'ok';
  }

  return {
    window,
    severity,
    minutesOfWorkLeft: minutesOfWorkLeft === null ? null : Math.round(minutesOfWorkLeft),
    minutesUntilReset: minutesUntilReset === null ? null : Math.round(minutesUntilReset),
    burnPctPerMin,
    resetsBeforeExhaustion,
    message: buildRiskMessage(window, severity, minutesOfWorkLeft, minutesUntilReset),
  };
}

function buildRiskMessage(
  window: QuotaWindow,
  severity: QuotaSeverity,
  minutesOfWorkLeft: number | null,
  minutesUntilReset: number | null,
): string {
  const resetNote = minutesUntilReset !== null ? `, resets in ${formatMinutes(minutesUntilReset)}` : '';

  if (severity === 'exhausted') {
    return `${window.label} is exhausted${resetNote}`;
  }

  const usage = window.unit === 'requests' && window.remainingUnits !== null
    ? `${window.remainingUnits} of ${window.totalUnits} left`
    : `${window.pctUsed.toFixed(0)}% used`;

  if (minutesOfWorkLeft !== null) {
    return `${window.label}: ${usage} - about ${formatMinutes(minutesOfWorkLeft)} of work left at the current rate${resetNote}`;
  }
  return `${window.label}: ${usage}${resetNote}`;
}

const SEVERITY_RANK: Record<QuotaSeverity, number> = { ok: 0, warning: 1, critical: 2, exhausted: 3 };

/** Ordinal severity, for comparing two states (e.g. "did this get worse?"). */
export function severityRank(severity: QuotaSeverity): number {
  return SEVERITY_RANK[severity];
}

/** Highest-severity risk, breaking ties toward the window that runs dry soonest. */
export function worstRisk(risks: QuotaRisk[]): QuotaRisk | null {
  let worst: QuotaRisk | null = null;
  for (const risk of risks) {
    if (!worst) { worst = risk; continue; }
    const diff = SEVERITY_RANK[risk.severity] - SEVERITY_RANK[worst.severity];
    if (diff > 0) { worst = risk; continue; }
    if (diff < 0) { continue; }
    const a = risk.minutesOfWorkLeft ?? Number.POSITIVE_INFINITY;
    const b = worst.minutesOfWorkLeft ?? Number.POSITIVE_INFINITY;
    if (a < b) { worst = risk; }
  }
  return worst;
}

export interface HandoffTarget {
  provider: ProviderId;
  /** 0-100 remaining headroom in that provider's tightest window. */
  headroomPct: number;
  /** Minutes of work the target can absorb, when measurable. */
  minutesOfWorkLeft: number | null;
  reason: string;
}

/**
 * Ranks providers by how much room is left in their tightest window, so the
 * handoff suggestion is grounded in live quota rather than a guess. Providers
 * at warning severity or worse are excluded - handing work to the next wall
 * just moves the problem.
 */
export function rankHandoffTargets(risks: QuotaRisk[], excludeProvider: ProviderId): HandoffTarget[] {
  const tightestByProvider = new Map<ProviderId, QuotaRisk>();
  for (const risk of risks) {
    const current = tightestByProvider.get(risk.window.provider);
    if (!current || risk.window.pctUsed > current.window.pctUsed) {
      tightestByProvider.set(risk.window.provider, risk);
    }
  }

  const targets: HandoffTarget[] = [];
  for (const [provider, risk] of tightestByProvider) {
    if (provider === excludeProvider) { continue; }
    if (SEVERITY_RANK[risk.severity] >= SEVERITY_RANK.warning) { continue; }
    const headroomPct = Math.max(0, 100 - risk.window.pctUsed);
    targets.push({
      provider,
      headroomPct,
      minutesOfWorkLeft: risk.minutesOfWorkLeft,
      reason: `${risk.window.label} at ${risk.window.pctUsed.toFixed(0)}% used`,
    });
  }

  return targets.sort((a, b) => b.headroomPct - a.headroomPct);
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export function formatMinutes(minutes: number): string {
  if (minutes < 1) { return 'under a minute'; }
  if (minutes < 60) { return `${Math.round(minutes)} min`; }
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatWindowLength(windowMinutes: number): string {
  if (windowMinutes % 10080 === 0) { return `${windowMinutes / 10080}w`; }
  if (windowMinutes % 1440 === 0) { return `${windowMinutes / 1440}d`; }
  if (windowMinutes % 60 === 0) { return `${windowMinutes / 60}h`; }
  return `${windowMinutes}m`;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) { return 0; }
  return Math.min(100, Math.max(0, value));
}

/**
 * Anthropic's reset headers have been seen as both ISO strings and unix
 * seconds, so both are accepted and anything else degrades to `null` (which
 * simply means "no reset time known", not an error).
 */
function parseResetHeader(value: string | null): string | null {
  if (!value) { return null; }
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1_000_000_000) {
    return new Date(asNumber * 1000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
