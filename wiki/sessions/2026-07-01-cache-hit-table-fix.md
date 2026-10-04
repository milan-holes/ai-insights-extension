# Session: Usage by Provider cache-hit fix - 2026-07-01

## What was done

- Fixed the "Cache Hit" column in the "🤖 Usage by Provider" dashboard table showing percentages way over 100% (e.g. 44486%) for Claude Code.
- Providers that structurally never report cache data (GitHub Copilot, Antigravity) now render "-" with an explanatory tooltip instead of a misleading "0%".

## Files changed

- [src/webview/dashboard.ts](../../src/webview/dashboard.ts) - `byPeriodAndProvider()` now computes `cacheHitPct` as `cacheReadTokens / (inputTokens + cacheReadTokens)` instead of `cacheReadTokens / inputTokens`, and adds a `cacheTrackable` flag per provider (`CACHE_TRACKING_SUPPORTED = new Set(['claudeCode', 'codex'])`). `updateProviderTable()` renders `-` with a `title` tooltip when `cacheTrackable` is false.

## Decisions made

- The old formula divided cache-read tokens by raw input tokens. In cached sessions `inputTokens` can be as low as 1-3 tokens per turn (the cached portion isn't counted as "input"), so the ratio routinely exceeded 100%. The fix mirrors the formula already used for the top-level Cache Hit Rate card in `computeCacheMetrics()` (`src/core/budgetManager.ts`): `cacheReadTokens / (inputTokens + cacheReadTokens)`.
- "Cannot evaluate" is determined by a static per-provider capability set, not by checking whether the current period's cache tokens happen to be zero - a provider with genuinely zero cache reads (e.g. a new Claude Code user) should still show `0%`, not `-`. Copilot and Antigravity were picked because their provider adapters hardcode `cacheReadTokens`/`cacheWriteTokens` to `0` in every code path (see [providers/copilot.md](../providers/copilot.md), [providers/antigravity.md](../providers/antigravity.md)) - they can never produce real cache data, unlike Claude Code and Codex which parse real cache-read/write counts from their session logs.

## Follow-up / known gaps

- `jetbrainsAI` and `visualStudio` providers also hardcode cache tokens to 0 but aren't part of this specific table (`provOrder` only lists `copilot`, `claudeCode`, `codex`, `antigravity`), so they weren't added to `CACHE_TRACKING_SUPPORTED` exclusion checks here - revisit if this table's provider list is ever extended.
