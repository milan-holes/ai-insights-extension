# PromptHistoryStore

Source: [src/core/promptHistory.ts](../../src/core/promptHistory.ts)

## Purpose

Groups session interactions into **user-prompt-level records**. A single user message to an agentic AI triggers multiple internal turns (tool calls, thinking, sub-calls) — this module collapses them into one row so cost/token data reflects the full agent response to each prompt.

## Grouping algorithm

Interactions within the same session are sorted by timestamp, then split into groups whenever the gap between consecutive interactions exceeds `PROMPT_GAP_MS` (2 minutes). Each group = one `PromptRecord`.

**Why 2 minutes?** Agentic tool-call chains fire within seconds of each other. A user reading the response and typing a new message typically takes longer. The threshold is intentionally generous to handle slow I/O or large file reads.

## PromptRecord interface

| Field | Type | Description |
|---|---|---|
| `timestamp` | `Date` | First interaction's timestamp |
| `provider` | `ProviderId` | Which AI provider |
| `sessionId` | `string` | Parent session ID |
| `model` | `string` | Model with the most output tokens in this group |
| `inputTokens` | `number` | Sum across all turns |
| `outputTokens` | `number` | Sum across all turns |
| `cachedTokens` | `number` | Sum of `cacheReadTokens` across all turns |
| `cost` | `number` | Sum of `calculateCost` per turn (each uses its own model pricing) |
| `responseMs` | `number` | Time from first to last turn (agent "thinking" time); 0 if single turn |
| `fileContext` | `string` | Session workspace path |
| `turnCount` | `number` | Number of individual agent turns in this group |

## PromptHistoryStore class

| Method | Description |
|---|---|
| `update(sessions)` | Rebuilds the full grouped record list |
| `getRecent(n = 10)` | Returns the `n` most recent records |
| `getAll()` | Returns the full sorted list |
| `size` | Number of stored prompt records |

## When it runs

Called in `refresh()` in `extension.ts` after `aggregateSessions`, keeping the store in sync with the session cache.
