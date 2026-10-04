# contextReferences — Context-Anchoring Detection

| Item | Value |
| ---- | ----- |
| File | [src/core/contextReferences.ts](../../src/core/contextReferences.ts) |
| Exports | `extractContextRefs(text)`, `computeContextEngagement(sessions)` |

## Purpose

Detects explicit context-anchoring syntax within a user prompt - chat variables/participants (`#file`, `@workspace`, ...) that deliberately point the model at specific context, as opposed to relying on ambient/injected context. Inspired by GitHub Copilot Chat's `#`/`@` variable syntax.

## Detected tokens

| Token | Type key |
| ----- | -------- |
| `#file` | `file` |
| `#selection` | `selection` |
| `#codebase` | `codebase` |
| `#changes` | `changes` |
| `#terminalLastCommand` | `terminalLastCommand` |
| `#terminalSelection` | `terminalSelection` |
| `#problems` | `problems` |
| `@workspace` | `workspace` |
| `@terminal` | `terminal` |
| `@vscode` | `vscode` |

## extractContextRefs(text)

`(text: string | undefined | null) => Record<string, number> | undefined`

Counts occurrences of each token type in a single prompt's full text. Returns `undefined` when no text or no matches, so `Interaction.contextRefs` stays absent (not an empty object) for the common case.

Must be called with the **full** prompt text, before providers truncate it to `Interaction.promptPreview` (only ~200 chars) - `promptPreview` is not sufficient input since anchoring tokens can appear anywhere in a longer prompt.

## computeContextEngagement(sessions)

Rolls up `Interaction.contextRefs` across every session/interaction into `ContextEngagement`:

```ts
interface ContextEngagement {
  totalRefs: number;               // all context-reference tokens found, all types
  byType: Record<string, number>;  // per-type counts
  interactionsWithRefs: number;    // interactions with >=1 context ref
  refRate: number;                 // interactionsWithRefs / interactions with prompt text available
}
```

Compaction-synthetic interactions (`isCompactionEvent`) are excluded. `refRate`'s denominator only counts interactions where prompt text was available at all (`promptPreview` or `contextRefs` set) - providers/branches with no captured text (e.g. Copilot's older flat event format, Antigravity's synthetic fallback turns) don't get counted against the rate.

## Where it's called

Each provider calls `extractContextRefs()` inline, at the point in its parse loop where it still holds the full (untruncated) prompt text - see the "Context references" section of each provider's own wiki page. `sessionAggregator.ts`'s `aggregateSessions()` calls `computeContextEngagement()` once and attaches the result to `AggregatedMetrics.contextEngagement`; `buildDailyUsage()` also sums `contextRefs` per day into `DailyUsage.contextRefs`.

## Surfaces

"Context Anchoring" section on the Workspace Analysis page ([usageAnalysis.ts](../../src/webview/usageAnalysis.ts)) - total references, anchoring rate, and a per-type breakdown table. Also feeds the `low-context-anchoring` insight rule in [insightsEngine.ts](./insightsEngine.md).
