# Session: Session analysis precision — 2026-06-05

## What was done

- Identified that all context-size signals in `contextRot.ts` used `session.totalInputTokens` which equals the sum of raw uncached `input_tokens` per turn (typically 1-3 tokens per turn for Claude Code cached sessions). A 226-turn session with 155K peak context showed `totalInputTokens = 261`, making `large_static_context`, `lostInMiddleRisk`, `contextRunway`, and the rot score's size penalty completely inert.
- Added `effectiveContextTokens = inputTokens + cacheReadTokens + cacheWriteTokens` field to `Interaction`, computed per turn in every provider.
- Added `peakEffectiveContextTokens` (session-level max) to `Session`.
- Fixed all broken context-size signals in `contextRot.ts` to use `peakEffectiveContext`.
- Fixed `cacheEfficiencyRate` denominator: previously `cacheRead / (input + cacheRead)` which inflated to ~100% always; now `cacheRead / (input + cacheRead + cacheWrite)`.
- Fixed `contextRunway` growth estimation to use effective context per turn instead of raw `inputTokens`.
- Fixed `classifyGrowthCurve` to use effective context as the growth variable.
- Added MCP server tracking: parse `attachment.deferred_tools_delta.addedNames` entries in JSONL to extract MCP server names (e.g. `claude_ai_Gmail`), stored as `session.activeMcpServers`.
- Added `session.estimatedBaseContextTokens` = first-turn cache write ≈ system prompt + CLAUDE.md + MCP schemas overhead.
- Added `webSearchRequests` / `webFetchRequests` per `Interaction`, sourced from `usage.server_tool_use`.
- Updated wiki `providers/claudeCode.md` with full explanation of `input_tokens` vs context size.

## Files changed

- [src/types.ts](../../src/types.ts) — `effectiveContextTokens` on `Interaction`; `activeMcpServers`, `estimatedBaseContextTokens`, `peakEffectiveContextTokens` on `Session`; `webSearchRequests`/`webFetchRequests` on `Interaction`
- [src/providers/claudeCode.ts](../../src/providers/claudeCode.ts) — parse MCP servers, web requests, base context tokens, `effectiveContextTokens`, `peakEffectiveContextTokens`
- [src/providers/antigravity.ts](../../src/providers/antigravity.ts) — add `effectiveContextTokens` to all interaction pushes
- [src/providers/codex.ts](../../src/providers/codex.ts) — add `effectiveContextTokens`
- [src/providers/copilot.ts](../../src/providers/copilot.ts) — add `effectiveContextTokens` to all five interaction push sites
- [src/core/contextRot.ts](../../src/core/contextRot.ts) — fix `cacheEfficiencyRate`, score check, `large_static_context`, `lostInMiddleRisk`, `contextRunway`, `classifyGrowthCurve`
- `wiki/providers/claudeCode.md` — explain token semantics, MCP tracking, base context overhead
- `CHANGELOG.md` — v0.1.10 entry

## Decisions made

- `effectiveContextTokens` is a **required** field on `Interaction` (not optional) so TypeScript enforces that every provider sets it — prevents future providers from silently falling back to wrong values.
- For non-Claude-Code providers (Copilot, Antigravity, Codex), caching is minimal so `effectiveContextTokens = inputTokens + cacheReadTokens + cacheWriteTokens ≈ inputTokens`. No semantic change for those providers.
- `large_static_context` thresholds changed from 200K/80K (on `totalInputTokens`) to 160K/80K (on peak effective context). 160K is chosen because 200K is the model limit and a peak that high means very little headroom.
- `inputBloatFactor` still uses raw `i.inputTokens` (user prompt length growth) — unchanged because that signal measures something different (are user prompts getting longer?). A separate context-growth signal isn't needed since `large_static_context` and `lostInMiddleRisk` now cover the context-size dimension correctly.
- MCP server names stored as the middle `__`-segment (e.g. `mcp__claude_ai_Gmail__authenticate` → `claude_ai_Gmail`). This avoids tool-level granularity while identifying the distinct server.

## Follow-up / known gaps

- `activeMcpServers` is parsed but not yet surfaced in the Sessions view or Context Workbench UI.
- `estimatedBaseContextTokens` is stored but not shown in any panel yet.
- `webSearchRequests`/`webFetchRequests` tracked per interaction but not aggregated in `ProviderMetrics` or shown in dashboard.
- Cost calculation does not yet distinguish 1h vs 5m cache tiers (`cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens`), but Anthropic prices both tiers identically so no cost impact.
