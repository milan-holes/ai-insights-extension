# quotaGuard

**File**: [src/core/quotaGuard.ts](../../src/core/quotaGuard.ts)

Normalizes the three providers' incompatible quota signals into one risk model whose headline number is **minutes of work left at the current burn rate**, and decides when that warrants warning the user.

## Why it exists

The ingredients were already here but never connected to the thing that actually interrupts work:

| Already existed                                                                      | Gap it left                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [copilotQuota.md](copilotQuota.md) - real premium-request remaining                  | rendered as a dashboard tile; nothing acted on it                                                      |
| Claude 5h/7d utilization headers (see [claudeAccountView.md](../webview/claudeAccountView.md)) | same - display only                                                                                    |
| [liveSessionMonitor](../../src/core/liveSessionMonitor.ts)'s `rate_limit_imminent` alert | computed from `LiveBudgetConfig.limitTokens`, a **user-typed token budget** - not the real provider wall |
| Codex `rate_limits` in its own rollout log                                           | parsed past and discarded entirely                                                                     |

So a session could be killed by a limit the extension already knew about, while the only alert that existed fired off a made-up number and rendered somewhere nobody looks mid-session. This module supplies the real signal; `extension.ts`'s `evaluateQuotaGuard()` consumes it.

## Normalized signals

| Provider    | Signal                                                   | Unit     | Source        |
| ----------- | -------------------------------------------------------- | -------- | ------------- |
| Copilot     | `copilot_internal/user` premium-request remaining        | requests | live API      |
| Claude Code | `anthropic-ratelimit-unified-5h/-7d-utilization` headers | percent  | live API      |
| Codex       | `rate_limits` on `token_count` entries                   | percent  | session log   |

Codex quota needs **no network call** - the CLI records it next to the token counts [codex.md](../providers/codex.md) already reads.

## Why "minutes of work", not percent

A percentage can't answer "can I finish this refactor?" - 90% used is harmless at the end of a window and fatal at the start. `minutesOfWorkLeft = (100 - pctUsed) / burnPctPerMin`, where burn comes from `QuotaWindowHistoryStore`'s rolling per-window utilization samples.

Distinct from [copilotQuota.md](copilotQuota.md)'s `QuotaHistoryStore`, which tracks remaining *requests* per GitHub login at daily granularity for long-range predictions. This one tracks *percent* per window at minute granularity, which is what an in-session warning needs.

## Avoiding false alarms

Three rules keep this from crying wolf - a warning system that is ignored is worse than none:

1. **`resetsBeforeExhaustion`** - if the window rolls over before quota runs out, severity is forced to `ok` however alarming the percentage looks.
2. **Burn rate ignores resets** - any drop in utilization means the window rolled over, so only samples after the most recent drop are averaged. Averaging across a reset badly understates the current rate.
3. **Staleness bounds** - a session-log reading is a *recording*, not a reading. Snapshots older than 60 min, and windows whose `resetsAt` has already passed, are discarded rather than reported as current (without this, a months-old rollout log showing 95% used raises a warning about a window that rolled over long ago). Cached live-API readings expire at 30 min, so a run of failed fetches can't warn off an hours-old number.

## Severity

```
reachedLimit / pctUsed >= 100 / remainingUnits <= 0  -> exhausted
resetsBeforeExhaustion                               -> ok
minutesOfWorkLeft <= criticalMinutesOfWork (5)       -> critical
minutesOfWorkLeft <= warnMinutesOfWork (15)          -> warning
no burn data yet: pctUsed >= 95 / >= 85              -> critical / warning
```

## API

```ts
toCopilotQuotaWindow(view?: CopilotQuotaView): QuotaWindow | null
toClaudeQuotaWindows(snapshot: ClaudeRateLimitSnapshot | null, now?: Date): QuotaWindow[]
toCodexQuotaWindows(sessions: Session[], now?: Date): QuotaWindow[]

assessQuotaRisk(window, burnPctPerMin, thresholds?, now?): QuotaRisk
computeBurnPctPerMin(samples: QuotaSample[], now?): number | null
worstRisk(risks: QuotaRisk[]): QuotaRisk | null
rankHandoffTargets(risks: QuotaRisk[], excludeProvider: ProviderId): HandoffTarget[]
formatMinutes(minutes: number): string

class QuotaWindowHistoryStore {
  constructor(globalState: vscode.Memento)
  record(windowId: string, pctUsed: number, now?: Date): void   // skips no-op repeats
  samples(windowId: string): QuotaSample[]
  burnPctPerMin(windowId: string, now?: Date): number | null
}
```

`rankHandoffTargets()` is what makes the handoff suggestion data-driven rather than a guess: it ranks providers by remaining headroom in their tightest window and excludes any already at warning severity, since handing work to the next wall just moves the problem.

## Settings

| Setting                                        | Default | Purpose                                     |
| ---------------------------------------------- | ------- | ------------------------------------------- |
| `aiInsights.quotaGuard.enabled`                | `true`  | Master switch                               |
| `aiInsights.quotaGuard.warnMinutesOfWork`      | `15`    | Warning threshold                           |
| `aiInsights.quotaGuard.criticalMinutesOfWork`  | `5`     | Critical threshold                          |
| `aiInsights.quotaGuard.warnPercentUsed`        | `85`    | Fallback before burn rate is measurable     |
| `aiInsights.quotaGuard.criticalPercentUsed`    | `95`    | Fallback before burn rate is measurable     |

## Known limitations

- **Evaluation cadence follows `aiInsights.refreshIntervalMinutes`** (5 min default), adding no polling of its own. The 15-minute default warning threshold sits comfortably above that, but a tighter lead time needs a lower refresh interval too.
- **Burn rate needs two samples ≥ 2 min apart** within a 90-minute lookback. A session that starts and exhausts a window inside one refresh interval falls back to the percent thresholds.
- **No per-model premium-request multiplier** for Copilot - a 3x model burns the window 3x faster than the request count suggests. Same gap [copilotQuota.md](copilotQuota.md) documents.

## Related

- [sessionCheckpoint.md](sessionCheckpoint.md) - the snapshot taken when a warning fires
- [sessionHandoff.md](sessionHandoff.md) - the brief and delegation built on top
- [copilotQuota.md](copilotQuota.md), [codex.md](../providers/codex.md)
