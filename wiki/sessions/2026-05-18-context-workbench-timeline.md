# Session: Context Workbench — Timeline & Blank-Screen Fix - 2026-05-18

## What was done

- Fixed Claude Code tool call extraction — parser was reading `entry.tool_calls` (never present) instead of `message.content[].type === "tool_use"`. Tool names and file paths now correctly populated; this also fixes heavy-tool / pattern detection.
- Added `fileAccesses?: Array<{tool,path}>` to the `Interaction` type to carry per-turn file access data from the parser.
- Fixed blank screen when clicking "Analyze" in Sessions view — the JS `init()` was calling `renderScoreRing`/`renderTimelineChart` before `buildWorkbenchHtml` had run, so `wbMain` stayed as the loading placeholder.
- Added **Context Size** panel: peak context, last-turn context, cache hit rate (%), total tokens read from cache. Stacked bar shows full-session input / output / thinking split.
- Added **Interaction Timeline** panel: per-turn rows with timestamp, mode badge, truncated prompt preview, tool call badges, and token pills (↑ input, ↓ output, ⚡ cache read, thinking, ✍ cache write). Shows last 20 turns; skipped turns shown as count.
- Removed now-unused server-side `buildWorkbenchContent()` function; initial `wbMain` content is replaced immediately by `render()` on page load.
- Added `__DETAIL__` JS variable containing full interaction arrays (model, mode, tokens, toolCalls, promptPreview) for all sessions.

## Files changed

- [`src/types.ts`](../../src/types.ts) — added `fileAccesses` optional field to `Interaction`
- [`src/providers/claudeCode.ts`](../../src/providers/claudeCode.ts) — fixed tool call extraction; added file path extraction from tool inputs
- [`src/webview/contextWorkbench.ts`](../../src/webview/contextWorkbench.ts) — workbench rewrite + Files in Context section
- `CHANGELOG.md` — unreleased entries added

## Decisions made

- Kept the existing Chart.js timeline chart (aggregate per-turn bars) and added the detailed row-by-row timeline below it — both serve different zoom levels.
- `__DETAIL__` serialises only the fields needed for the webview (not full `Session` objects) to keep payload size down.
- Show last 20 interactions in the timeline; a "N earlier turns" chip appears when the session is longer.

## Follow-up / known gaps

- "Files in context" can't be derived from current `Interaction` type — would need the provider parser to track which files were passed in each turn's context.
- Cache write tokens are shown but not yet explained (tooltip would help).
