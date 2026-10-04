# sessionHygiene — Compaction & Marathon-Session Accounting

| Item | Value |
| ---- | ----- |
| File | [src/core/sessionHygiene.ts](../../src/core/sessionHygiene.ts) |
| Export | `computeSessionHygieneSummary(sessions: Session[]): SessionHygieneSummary` |

## Purpose

Rolls up two existing-but-previously-unsurfaced signals across a period: how much context compaction happened (and whether it was manual or automatic), and how many sessions ran long enough to be flagged as "marathon" sessions.

## SessionHygieneSummary

```ts
interface SessionHygieneSummary {
  manualCompactions: number;
  autoCompactions: number;
  tokensReclaimed: number;      // sum of (preCompactionTokens - postCompactionTokens)
  marathonSessions: number;
  longestMarathonMinutes: number;
}
```

## How it's computed

- **Compaction counts / tokens reclaimed**: iterates every `Interaction` with `isCompactionEvent: true` (currently only emitted by [claudeCode.ts](../providers/claudeCode.md) from `{type:'system', subtype:'compact_boundary'}` JSONL events) and buckets by `compactionTrigger` (`'manual'` vs anything else = auto). No other provider currently emits compaction events.
- **Marathon sessions**: calls [contextRot.ts](./contextRot.md)'s `computeContextRotAnalysis(session)` per session and checks whether its `overloadSignals` include a `long_turn_chain` entry (fires at >40/>80 turns or >180 min wall-clock) - the existing thresholds are reused rather than redefined here.

## Note: no "truncation" signal

Unlike compaction, no current provider's raw session log exposes an explicit context-truncation event - only Claude Code's compaction boundary carries pre/post token counts. `sessionHygiene.ts` deliberately does not fabricate a truncation detector; if a provider adds one, extend `SessionHygieneSummary` rather than inferring it from other signals.

## Where it's used

`sessionAggregator.ts`'s `aggregateSessions()` calls this once and attaches the result to `AggregatedMetrics.sessionHygiene`. Surfaced in the dashboard's "🧹 Session Hygiene" card (mini-cards: manual/auto compactions, tokens reclaimed, marathon session count + longest). Also feeds the `marathon-sessions` and `compaction-heavy` insight rules in [insightsEngine.ts](./insightsEngine.md).
