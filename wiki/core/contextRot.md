# contextRot — Context Rot Scorer

| Item | Value |
| ---- | ----- |
| File | [src/core/contextRot.ts](../../src/core/contextRot.ts) |
| Export | `computeContextRotScore(session: Session): ContextRotScore` |

## Purpose

Derives a **context health score** from static, already-available session data — no live instrumentation required. Surfaces in the Sessions table as a colored "Context Health" badge per session.

## Scoring model

| Signal | Condition | Points |
| ------ | --------- | ------ |
| Turn count | > 80 turns | +2 |
| Turn count | > 40 turns | +1 |
| Session age | > 120 min | +2 |
| Session age | > 60 min | +1 |
| Input bloat (last-third / first-third avg) | > 4× | +3 |
| Input bloat | > 2× | +2 |
| Input bloat | > 1.5× | +1 |
| Output decline (last-third / first-third avg) | < 0.4× | +2 |
| Output decline | < 0.65× | +1 |
| Context pressure (peak effective context / resolved window) | > 80 % | +2 |
| Context pressure | > 40 % | +1 |

Score is capped at 10.

The context-pressure term is a **fraction of the session's resolved context
window** ([[contextWindow]]), not an absolute token count. The former absolute
160K / 80K constants were 80 % / 40 % of a 200K window, so on a 1M-window model
they fired at 16 % / 8 % full and on a 200K-window Haiku session they were
unchanged.

## Thresholds

| Score | Label | Badge |
| ----- | ----- | ----- |
| 0–3 | `healthy` | 🟢 Healthy |
| 4–6 | `warning` | 🟡 Warn |
| 7–10 | `stale` | 🔴 Stale |

Sessions with < 3 turns show `—` (insufficient data).

## ContextRotScore interface

```typescript
interface ContextRotScore {
  score: number;               // 0–10
  label: 'healthy' | 'warning' | 'stale';
  turnsCount: number;
  sessionAgeMinutes: number;
  inputBloatFactor: number;    // last-third avg input / first-third avg input
  outputDeclineFactor: number; // last-third avg output / first-third avg output
  contextRunway: number | null; // estimated turns before context limit
  contextWindowTokens: number;  // denominator for every context metric
  contextWindowSource: 'override' | 'model' | 'default';
  cacheEfficiencyRate: number;  // 0–100 %
  contextQualityScore: number;  // 0–100 CQ score
}
```

## Tier-1 metrics (new)

| Metric | How computed | Surface |
| ------ | ------------ | ------- |
| `contextRunway` | Linear regression (slope) on last 6 turns vs the resolved window ([[contextWindow]]) | Row badge tooltip, overlay header chip |
| `growthCurve` | `plateau` / `linear` / `spike` / `exponential` by variance + half-growth-rate comparison | Overlay header |
| `cacheEfficiencyRate` | `totalCacheReadTokens / totalInputTokens × 100` | Overlay budget section, row badge tooltip |
| `cacheThrashDetected` | `cacheWriteTokens > cacheReadTokens × 2` → `cache_thrash` signal | Overload signals |
| `thinkingEfficiencyTrend` | `rising` / `stable` / `falling` / `none` by thinking/output ratio first-third vs last-third | Overlay efficiency grid, `thinking_overload` signal |

## Tier-3 metrics (new)

| Metric | How computed | Surface |
| ------ | ------------ | ------- |
| `contextBudgetAllocation` | Breakdown of all tokens into: cached input, fresh input, output, thinking, cache writes | Donut chart in overlay |
| `lostInMiddleRisk` | 0 if <60K tokens; scales 0–100 from 60K→the resolved window; ×1.2 if >30 turns; ×0.8 if cache >60% | Efficiency grid, `lost_in_middle` signal when >60 |
| `contextQualityScore` | cache(30) + tool overhead(20) + growth curve(30) + LIM inverse(20) = 0–100 | CQ card in overlay header, row badge tooltip |
| `sessionSiblings` | Same workspace, same first-prompt prefix (≥40 chars), within 24 h | Groundhog-day banner in overlay |

## Overload signal types (full list)

| Type | Condition |
| ---- | --------- |
| `high_input_output_ratio` | input/output > 8× |
| `long_turn_chain` | > 40 or > 80 turns |
| `large_static_context` | peak effective context > 40 % (medium) or > 80 % (high) of the resolved window |
| `output_collapse` | outputDeclineFactor < 0.65 |
| `tool_loop` | single tool called > 5 times |
| `repeated_tool_failures` | defined, detection pending |
| `cache_thrash` | cacheWrites > cacheReads × 2 |
| `thinking_overload` | thinking/output ratio rising across thirds |
| `lost_in_middle` | lostInMiddleRisk > 60 |

## Reused by sessionHygiene

[sessionHygiene.ts](./sessionHygiene.md) reuses `computeContextRotAnalysis()`'s `long_turn_chain` overload signal (rather than redefining the >40/>80-turn or >180-min thresholds) to count "marathon sessions" across a period.

## Failure modes detected

| Type | Signal used |
| ---- | ----------- |
| Context Distraction | High turn count + session age |
| Context Poisoning (proxy) | Input bloat + output decline together |
| Context Confusion | Large total input tokens |
| Cache inefficiency | Cache thrash, low cache efficiency rate |
| Middle-context loss | Lost-in-middle risk for large contexts |
| Session restart churn | Session sibling detection (groundhog-day) |
