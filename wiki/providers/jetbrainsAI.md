# GitHub Copilot for JetBrains Provider

Source: [src/providers/jetbrainsAI.ts](../../src/providers/jetbrainsAI.ts)  
Schema was reverse-engineered from real JetBrains session files; the field-by-field shape this parser relies on is documented under "Session file format" below.

## Purpose

Reads conversation history written by the **GitHub Copilot plugin for JetBrains IDEs** (IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, CLion, PhpStorm, RubyMine, DataGrip, …).

## File location

```
~/.copilot/jb/{conversationId}/partition-{n}.jsonl
```

Same path on all platforms (Windows, macOS, Linux). Each conversation is a UUID-named subdirectory; each partition is an append-only JSONL file. Multi-partition conversations produce multiple sessions in AI Insights (one per partition file). Empty files (size 0) are skipped.

## JSONL event stream

Each line is one JSON event with envelope `{ type, data, id, timestamp, parentId }`.

| Event type | Key fields | Role |
|---|---|---|
| `partition.created` | `data.conversationId`, `data.source` | Session header |
| `user.message` | `data.content`, `data.turnId` | Raw user input |
| `user.message_rendered` | `data.renderedMessage`, `data.turnId` | Full prompt with injected file context — supersedes `user.message` for the same `turnId` |
| `assistant.turn_start` | `data.model` (optional) | Turn boundary |
| `assistant.message` | `data.text` or `data.content`, `data.thinking.text` | Streamed response / thinking |
| `tool.execution_start` | `data.toolName`, `data.toolCallId` | Agent tool call |
| `tool.execution_complete` | `data.toolCallId`, `data.success`, `data.result.result[]` | Tool result |
| `assistant.turn_end` | — | Turn boundary |

## Parsing logic

- Pre-scan collects all `user.message_rendered` turnIds before processing.
- When a rendered version exists for a turn, the bare `user.message` text is skipped.
- One `Interaction` is created per `user.message` event (flushed on `assistant.turn_end` or next `user.message`).
- Assistant output accepts both `data.text` and `data.content`; JetBrains/Copilot builds have used both shapes.
- `tool.execution_complete` result blocks are added to `outputText` for the current turn.

## Token counting

Estimated at 0.25 tokens/char. No actual API counts are exposed by the plugin.

- Input = rendered prompt (`user.message_rendered.data.renderedMessage`) when present, otherwise raw `user.message.data.content`.
- Output = assistant message text/content plus text blocks from `tool.execution_complete.data.result.result[].value`.
- Thinking = `assistant.message.data.thinking.text`.
- Cache read/write tokens are always `0`; this format does not expose cache telemetry.

## Mode detection

Any `tool.execution_start` event in a partition → `mode: 'agent'`; otherwise `mode: 'ask'`.

## Model detection (best-effort)

1. `assistant.turn_start.data.model` (not present in all JetBrains builds)
2. `tool.execution_start.data.toolCallId` prefix:
   - `toolu_*` → `claude` (Anthropic; `toolu_bdrk_*` = Bedrock)
   - `call_*` → `gpt` (OpenAI)
3. Fallback: `'copilot'`

## Session ID

`jb-{conversationId}-{partition-n}`

## Configuration

```json
"aiInsights.providers.jetbrainsAI.enabled": true
```
