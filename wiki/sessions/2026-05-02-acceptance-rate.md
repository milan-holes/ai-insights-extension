# Session: Acceptance Rate (Quality Proxy) - 2026-05-02

## What was done

- Added `AcceptanceMetrics` interface to `src/types.ts` — `triggered`, `accepted`, `acceptanceRate`, `since`.
- Created `src/core/acceptanceTracker.ts` — `AcceptanceTracker` class that hooks into two VS Code APIs:
  - `vscode.languages.onDidAcceptCompletionItem` (guarded with `as unknown as Record` because the API is proposed and not yet in `@types/vscode@1.116.0`) → counts popup completion acceptances.
  - `vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' })` returning `{ items: [] }` → counts debounced inline-completion triggers as a proxy for "ghost text shown" (750 ms debounce collapses rapid keystrokes into one event per pause).
- Wired into `src/extension.ts` — module-level `acceptanceTracker` instance, registered in `activate()`, stats passed to `showUsageAnalysis()`.
- Added `🎯 Quality` tab to `src/webview/usageAnalysis.ts` — `buildAcceptanceSection()` renders three mini-cards (rate, accepted, triggered), a progress bar, and an explanatory note. Tab button added to the tab bar between "My Activity" and "Tools & MCP".

## Files changed

- [`src/types.ts`](../../src/types.ts) — `AcceptanceMetrics` interface
- [`src/core/acceptanceTracker.ts`](../../src/core/acceptanceTracker.ts) — new module
- [`src/extension.ts`](../../src/extension.ts) — import + instantiate + register + pass to webview
- [`src/webview/usageAnalysis.ts`](../../src/webview/usageAnalysis.ts) — `buildAcceptanceSection`, Quality tab panel, updated `getHtml`/`createPanel` signatures

## Decisions made

- **Proposed API guard**: `onDidAcceptCompletionItem` is absent from `@types/vscode@1.116.0`; accessed via `(vscode.languages as unknown as Record<string, unknown>)['onDidAcceptCompletionItem']` with a `typeof === 'function'` guard. Silently skips on VS Code builds that don't have it — `accepted` stays 0 in that case.
- **No-op inline provider**: returning `{ items: [] }` means we never add suggestions and never delay Copilot's rendering. The provider is called before ghost text is rendered, so its call count is a close proxy for "times ghost text was triggered".
- **750 ms debounce**: VS Code calls the provider on every keystroke. A 750 ms debounce collapses a burst of keystrokes into one "shown" event, matching typical Copilot ghost-text latency.
- **Resets on reload**: acceptance metrics are in-memory only. Persisting them to `globalState` would require tracking date boundaries; for now, the live-session signal is the intended use-case.

## Follow-up / known gaps

- `onDidAcceptCompletionItem` counts ALL IntelliSense acceptances (TypeScript, Python, etc.), not only AI ones. Future: filter by `item.detail` or provider identity when the API stabilises.
- The trigger count inflates if the editor is open in a language with aggressive completion triggers. Consider a per-language filter.
- No per-provider breakdown yet — all providers share one counter.
