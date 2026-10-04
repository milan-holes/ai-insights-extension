# Session: Prompt-Level Cost History - 2026-05-10

## What was done

- Created `src/core/promptHistory.ts` — `PromptRecord` interface and `PromptHistoryStore` class
- Created `src/webview/promptHistoryView.ts` — `PromptHistoryViewProvider` with sparkline, summary cards, and filterable prompt table
- Updated `src/extension.ts` — instantiates `PromptHistoryStore`, calls `store.update()` in `refresh()`, registers `aiInsights.showPromptHistory` command
- Updated `package.json` — added `aiInsights.showPromptHistory` command contribution
- Updated `CHANGELOG.md`

## Files changed

- `src/core/promptHistory.ts` — new module
- `src/webview/promptHistoryView.ts` — new module
- `src/extension.ts` — added store + command
- `package.json` — added command

## Decisions made

- `PromptRecord` is co-located with `PromptHistoryStore` in `core/promptHistory.ts` rather than `types.ts` to keep related concerns together
- Duration is the gap to the next interaction (or `session.endTime`); when interactions share the same timestamp (file-mtime fallback), duration is 0 and shown as "—"
- `fileContext` uses `session.workspace` since per-interaction active-file data is not available in the log format
- Sparkline always shows the last 50 records regardless of the limit selector, giving a stable visual reference
- Records are serialized at panel-build time (no live polling); user hits Refresh to see new data

## Follow-up / known gaps

- Duration accuracy is limited for sessions where interactions share the file-mtime fallback timestamp
- `fileContext` cannot be tied to the specific file open at prompt time without hooking into the editor API at prompt-time (not possible retroactively from logs)
