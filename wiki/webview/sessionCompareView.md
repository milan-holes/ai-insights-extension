# sessionCompareView

**File**: [`src/webview/sessionCompareView.ts`](../../src/webview/sessionCompareView.ts)

## Purpose

Side-by-side comparison panel for 2–6 sessions. Triggered from the sessions list by selecting sessions with checkboxes and clicking "Compare Sessions".

## Entry point

```typescript
SessionCompareProvider.createPanel(context: vscode.ExtensionContext, sessions: Session[])
```

## Data flow

1. `createPanel` calls `prepareData(session)` for each session → `CompareSessionData[]`
2. Array serialized as `window.__DATA__` JSON in the HTML
3. Client JS renders all sections from this data

## CompareSessionData fields

| Field | Source |
|-------|--------|
| Token counts (all 5 types) | `session.total*Tokens` |
| `estimatedCostUsd` | `session.estimatedCostUsd` |
| `durationMinutes` | `(endTime - startTime) / 60000` |
| `cacheHitRate` | `cacheRead / (cacheRead + cacheWrite)` |
| `outputInputRatio` | `outputTokens / inputTokens` |
| `costPerInteraction` | `cost / interactions` |
| `toolBreakdown` | aggregated from `interaction.toolCalls[]` |
| `commandBreakdown` | aggregated from `interaction.commandRuns[]` |
| `modeBreakdown` | aggregated from `interaction.mode` |
| `compactionEvents` | count of `isCompactionEvent === true` turns |
| `contextRotScore` / `contextRotLabel` | `computeContextRotScore(session)` |

## Panel sections

| Section | Chart/widget |
|---------|-------------|
| Token Usage | Grouped bar chart (Chart.js) + bar-track comparison per token type |
| Cost & Efficiency | Table: cost, cost/interaction, tokens/interaction, cache hit rate, output/input ratio, duration, compactions. Best value highlighted with ★ |
| Activity | Table: interactions, tool calls, commands, file reads/edits, unique files |
| Tool Usage | Per-tool count table across all sessions + row total |
| Shell Commands | Per-command count table (top 30) |
| Interaction Modes | Grouped bar chart + bar-track rows |
| Context Health | Health badge, rot score (lower = better), models used |

## Session colors

Up to 6 sessions; colors assigned positionally:
`#007AFF` `#34C759` `#FF9F0A` `#BF5AF2` `#FF3B30` `#00C7BE`
