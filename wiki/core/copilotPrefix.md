# copilotPrefix

**File**: [src/core/copilotPrefix.ts](../../src/core/copilotPrefix.ts)

Attributes the **fixed** part of every Copilot request: the system prompt and the tool
catalog, resent on every turn of a session.

## Data source

Next to `debug-logs/<session>/main.jsonl` Copilot writes, per request index:

| File | Contents |
| --- | --- |
| `tools_N.json` | `{"content": "<JSON array of tool definitions>"}` |
| `system_prompt_N.json` | `{"content": "<system prompt text>"}` |

The lowest-numbered pair is used - index 0 is the prefix the session was established
with; later indices differ only when the toolset changed mid-session.

Sidecars are written for only **some** sessions (3 of 11 session dirs on the measured
machine), so `readPromptPrefix()` returns `null` when neither is present rather than
reporting zeros as a measurement.

## Why it matters

It separates *"your context is large"* from *"your context is mostly tool schemas you
never invoke"*. Measured on this machine:

| Session | Prefix | Tools offered | Called | Unused schema | Share of a typical request |
| --- | ---: | ---: | ---: | ---: | ---: |
| `2603a5da` | 27,707 tok | 86 | 4 | 18,803 tok | 78% |
| `48bab48b` | 27,644 tok | 84 | 6 | 17,093 tok | 5% |
| `f2513405` | 30,687 tok | 88 | 6 | 16,736 tok | 19% |

Across the three: 90 distinct tools offered, **8 ever called**, ~17.5K tokens per
request of schema the model could not use.

## Public API

```ts
function readPromptPrefix(
  mainJsonlPath: string,
  calledTools: Iterable<string>,
  meanInputTokens?: number,
): PromptPrefixBreakdown | null;
```

`PromptPrefixBreakdown` ([src/types.ts](../../src/types.ts)) carries
`toolCatalogTokens`, `systemPromptTokens`, `totalTokens`, `definedTools`, `usedTools`,
`unusedTools`, `unusedToolTokens` and `shareOfMeanInput`.

Rolled up across sessions by `computePromptPrefixSummary()` in [[sessionAggregator]]
into `AggregatedMetrics.promptPrefix`, and rendered as the dashboard's **Fixed Prompt
Overhead** section (Copilot view only).

## Design notes

| Decision | Why |
| --- | --- |
| "Used" is read from the log's `tool_call` events, not just the caller's `Interaction.toolCalls` | One Copilot session is written to several files (`chatSessions/`, `transcripts/`), only some of which yield tool calls, and whichever variant survives `dedupeSessions()` decides what `toolCalls` holds. Before this, a session's 86 tools could all be reported never-used because the winning duplicate had none. The two sources are **unioned** - used is easy to establish, never-used is the claim that should be hard to make. |
| The whole catalog *file* is charged, not the sum of named tool definitions | Array punctuation and any entry we failed to name still cost money. |
| A tool is never-used only when **no** session that offered it called it | One session's narrow task should not condemn a tool another session relies on. |
| Token counts are `chars / 4` | Copilot writes these files as text and never reports their token count, so every figure here is an estimate by construction and is labelled as such in the UI. |

## Known limits

- `shareOfMeanInput` compares the prefix against the session's *mean* input, so a
  session whose later turns grew large shows a smaller share than its first turn had.
- Only the first sidecar pair is read; a session that changed toolsets mid-way is
  described by the toolset it started with.
- "Unused in the sessions we could read" is not "safe to remove" - a tool used rarely,
  or used in a session without sidecars, appears as never-used. The UI says so.
