# sessionAggregator

**File**: [src/core/sessionAggregator.ts](../../src/core/sessionAggregator.ts)

Merges `Session[]` from all providers into a single `AggregatedMetrics` object.

## Public API

```ts
function aggregateSessions(sessions: Session[]): AggregatedMetrics;
```

## Time windows

| Key             | Definition                                            |
| --------------- | ----------------------------------------------------- |
| `today`         | Sessions whose `startTime` date == today (UTC)        |
| `last30Days`    | Sessions within the last 30 × 24 h                    |
| `lastMonth`     | Sessions within the previous calendar month           |
| `projectedYear` | `last30Days` × 12.17 (= 365 / 30)                     |
| `byProvider`    | Metrics per provider over all time                    |
| `daily`         | One `DailyUsage` entry per calendar day, all sessions |

## buildMetrics(sessions)

Computes a `ProviderMetrics` record:

- Sums `totalTokens`, `inputTokens`, `outputTokens`, `thinkingTokens`
- Calls `calculateCost()` per interaction and sums cost
- Calls `calculateEnvironmentalImpact(totalTokens)` for CO₂/water
- Builds `modelBreakdown`, `providerBreakdown`, `toolCalls`, `repositories` maps
- `cacheTokensEstimated: sessions.some(sess => sess.cacheTokensEstimated)` - true if *any* session in the group has cache numbers from Copilot's turn-diffing heuristic rather than real telemetry (see [providers/copilot.md](../providers/copilot.md)). UI code (`dashboard.ts`, `pricingView.ts`) uses this flag - not `cacheReadTokens > 0` - to decide whether to show a "(calc.)" / "calculated, not measured" disclaimer, since real per-call telemetry from `debug-logs/{sessionId}/main.jsonl` also produces non-zero cache token counts.

## buildDailyUsage(sessions)

Groups sessions by ISO date string, accumulating token counts, session/interaction counts, model breakdown, tool call counts, estimated cost, repository breakdown, and (per-day) context-reference counts (`DailyUsage.contextRefs`). Returns sorted ascending by date.

## contextEngagement and sessionHygiene

`aggregateSessions()` also computes two rollups, attached directly to `AggregatedMetrics`:

- `contextEngagement` - via [contextReferences.ts](./contextReferences.md)'s `computeContextEngagement()`. Rolls up how often prompts anchor context explicitly (`#file`, `@workspace`, ...) across all interactions.
- `sessionHygiene` - via [sessionHygiene.ts](./sessionHygiene.md)'s `computeSessionHygieneSummary()`. Rolls up manual/auto compaction counts, tokens reclaimed by compaction, and marathon-session counts.

Both reuse existing per-interaction/session data rather than introducing new parsing - see their own wiki pages for details.

## normalizeMode(mode, provider)

Maps each interaction's raw `mode` string into the fixed set of dashboard buckets (`ask`, `edit`, `agent`, `plan`, `customAgent`, `cli`):

- `codex` → always `agent`; `antigravity` → always `ask` (these providers don't expose finer-grained modes).
- `claudeCode` → passes through `ask` / `edit` / `agent` / `plan` as already classified by [ClaudeCodeProvider.classifyMode()](../providers/claudeCode.md#interaction-mode-classification); anything else (e.g. `compaction`, or unrecognized values) falls back to `cli`.
- All other providers (Copilot, etc.) → lowercased `mode` mapped directly to `edit` / `agent` / `plan` / `customAgent`, else `ask`.

## Notes

- `projectedYear` fields are computed by simple multiplication - no seasonality or trend adjustment.
- `repositories` key is the last path segment of `sess.workspace` (basename).
