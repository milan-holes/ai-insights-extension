# ClaudeCodeProvider

**File**: [src/providers/claudeCode.ts](../../src/providers/claudeCode.ts)  
**Provider ID**: `claudeCode`

Reads Claude Code session logs from `~/.claude/projects/`.

## Log format

Claude Code writes one **JSONL** file per conversation under:

```
~/.claude/projects/<encoded-path>/<session-id>.jsonl
```

Each line is a JSON object. The provider reads these fields:

| Field                                        | Purpose                                        |
| -------------------------------------------- | ---------------------------------------------- |
| `timestamp` / `createdAt`                    | Interaction timestamp                          |
| `usage.input_tokens`                         | New uncached input token count (often ~1-3)    |
| `usage.output_tokens`                        | Output token count                             |
| `usage.thinking_tokens`                      | Extended thinking tokens                       |
| `usage.cache_read_input_tokens`              | Cache read tokens (history served from cache)  |
| `usage.cache_creation_input_tokens`          | Cache write tokens (newly cached content)      |
| `usage.server_tool_use.web_search_requests`  | Web search calls made by server-side tools     |
| `usage.server_tool_use.web_fetch_requests`   | Web fetch calls made by server-side tools      |
| `model` / `message.model`                    | Model ID (e.g. `claude-sonnet-4-6`)            |
| `entrypoint`                                 | Host surface (`cli`, `claude-vscode`, ...) — used to derive interaction mode |
| `permissionMode`                             | Permission mode (`default`, `plan`, `acceptEdits`, `bypassPermissions`), only present on `user` entries; carried forward to subsequent `assistant` entries |
| `tool_calls` / `toolCalls`                   | Tool names used                                |
| `attachment.deferred_tools_delta.addedNames` | MCP tool names (parsed for server identifiers) |

Lines with zero tokens in all fields (input, output, cache read, cache write) and no model identifier are skipped.

**Deduplication**: Claude Code stores the same assistant message multiple times across conversation branches (via `parentUuid` chains). The parser deduplicates by `entry.message.id`, counting each unique API call exactly once.

**Token counting**: `totalTokens` for each interaction includes `input_tokens + output_tokens + thinking_tokens + cache_read_input_tokens + cache_creation_input_tokens`. This reflects the full context processed by the model, which is the conventional way usage is reported.

### Why `input_tokens` ≠ context size

For Claude Code sessions with prompt caching, `usage.input_tokens` is the count of **newly uncached** tokens added in that turn — typically just the raw user message (often 1-3 tokens for a "yes" reply). The actual context window size at any turn is:

```
effectiveContextTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

All context-size analysis in `contextRot.ts` uses `effectiveContextTokens` and `peakEffectiveContextTokens`. Using `totalInputTokens` alone would show 261 tokens for a 226-turn session with 155K peak context.

### MCP server tracking

When Claude Code activates MCP servers, it writes `attachment` entries with `type: "deferred_tools_delta"` containing tool names like `mcp__claude_ai_Gmail__authenticate`. The provider extracts the server name (middle segment) and stores unique server names in `session.activeMcpServers`.

### Base context overhead

The **first** `cache_creation_input_tokens` in a session approximates the static overhead contributed by: system prompt, CLAUDE.md, global instructions, and MCP tool schemas — before any conversation history accumulates. Stored as `session.estimatedBaseContextTokens`.

### Interaction mode classification

Claude Code doesn't report a discrete ask/edit/agent mode the way other providers do — only a permission mode and a host `entrypoint`. `classifyMode()` derives the dashboard's "Interaction Modes" bucket per turn:

- `entrypoint` missing or `'cli'` → **`cli`** (raw terminal usage, or older sessions predating the `entrypoint` field).
- Otherwise (IDE-hosted, e.g. `claude-vscode`):
  - `permissionMode === 'plan'` → **`plan`**
  - No tool calls in the turn → **`ask`** (pure chat, no code touched)
  - `permissionMode === 'acceptEdits'` → **`edit`**
  - Anything else (`default`, `bypassPermissions`) with tool calls → **`agent`**

Previously every Claude Code interaction was force-mapped to `cli` in `sessionAggregator.ts::normalizeMode`, regardless of how it was actually used — the "Interaction Modes" dashboard widget always showed 100% CLI even for IDE-based ask/edit/agent sessions. See [wiki/sessions/2026-07-01-interaction-mode-fix.md](../sessions/2026-07-01-interaction-mode-fix.md).

## Workspace extraction

`extractProject(filePath)` finds the `projects/` segment in the path and returns the next directory component - this is the encoded workspace path Claude Code uses as a project identifier.

## Key properties

- Provides **exact** token counts (no estimation needed).
- Supports cache token tracking (read vs. write), enabling accurate cost calculation when prompt caching is active.
- Walks up to 4 directory levels deep inside `~/.claude/projects/`.
