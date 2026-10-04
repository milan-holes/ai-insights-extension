# Architecture

## Overview

AI Insights has two hosts over the same local analytics engine:

- a VS Code extension with status bar, commands, and webview panels
- a standalone Electron app for local analytics without installing the extension

Both hosts read **local AI session log files** from multiple providers, normalise them into a unified data model, and aggregate metrics. No prompt/session data is uploaded by the local analytics path.

## Data flow

```
~/.claude/projects/**/*.jsonl          (Claude Code)
~/.gemini/antigravity/brain/**/overview.txt  (Antigravity)
~/.config/github-copilot/**/*.json     (Copilot)
          │
          ▼
    Provider.discoverSessionFiles()
    Provider.parseSessionFile()  ──→  Session[]
          │
          ▼
      CacheManager / SessionSnapshotStore
          │
          ▼
    aggregateSessions()  ──→  AggregatedMetrics
          │
          ├──→ VS Code status bar + webviews
          └──→ Electron dashboard + sessions + settings
```

## Module map

```
src/
├── extension.ts            Extension lifecycle, command registration, refresh loop
├── types.ts                Shared interfaces (Session, Interaction, AggregatedMetrics, …)
├── standalone/
│   ├── config.ts           Standalone defaults, storage, provider list
│   └── service.ts          Host-neutral refresh loop for the Electron app
├── electron/
│   ├── main.ts             Electron main process and IPC handlers
│   ├── preload.ts          Context-isolated renderer API
│   ├── renderer.ts         Standalone dashboard/sessions/settings UI
│   └── index.html          Static Electron document
├── providers/
│   ├── base.ts             BaseProvider - token estimator, shared helpers
│   ├── claudeCode.ts       ClaudeCodeProvider - JSONL parser
│   ├── antigravity.ts      AntigravityProvider - Gemini overview.txt parser
│   └── copilot.ts          CopilotProvider - GitHub Copilot log parser
├── core/
│   ├── sessionAggregator.ts  aggregateSessions() - builds AggregatedMetrics
│   ├── costEstimation.ts     calculateCost() - per-model pricing lookup
│   ├── environmentalImpact.ts  calculateEnvironmentalImpact() - CO₂/water
│   └── cacheManager.ts     CacheManager - mtime-based file cache
├── data/
│   ├── modelPricing.json   Per-model $/1M token rates
│   └── tokenEstimators.json  Chars-per-token ratios for text estimation
└── webview/
    ├── dashboard.ts        Token/cost summary panel
    ├── charts.ts           Daily usage charts (Chart.js)
    └── diagnostics.ts      Diagnostic report panel
```

## Host boundaries

- `src/extension.ts` is the extension host and may use `vscode`.
- `src/electron/*` is the Electron host and may use Electron APIs.
- `src/standalone/*`, `src/providers/*`, and host-neutral `src/core/*` must not import `vscode` or Electron.
- Extension behavior is not reduced for standalone support; Electron gets separate replacements for editor-only features as they are built.

## Key design decisions

- **Read-only, local-only**: providers only call `fs.readFileSync`; no writes to user data.
- **Lazy cache**: `CacheManager` uses `fs.statSync` mtime - a file is only re-parsed if it changed since the last run. Max 1 000 entries with 25 % LRU eviction. Persisted to `<globalStorage>/session-parse-cache.json`, so a restart does not re-parse everything.
- **Activation does no I/O**: the first `refresh()` is deferred out of `activate()` and yields to the event loop every 20 files. Provider methods are `async` but synchronous inside, so `await` alone never yields - only an explicit `setImmediate` does.
- **Unified `Session` type**: all providers normalise to the same interface so `aggregateSessions` is provider-agnostic.
- **Separate host builds**: `npm run compile` builds only `dist/extension.js`; `npm run electron:compile` builds `dist/electron/*`.
- **Estimation fallback**: Antigravity logs don't expose raw token counts, so `BaseProvider.estimateTokens()` counts characters with a per-language chars/token ratio.
- **Yearly projection**: multiplies the 30-day total by `12.17` (365 / 30).

## Refresh cycle

1. `activate()` schedules the first `refresh()` on a `setTimeout(..., 0)` rather than running it inline, then starts a `setInterval` (default 5 min, configurable). Running it inline put the whole provider scan on the activation timer and blocked the extension host while other extensions were still starting.
2. Config changes restart the timer with the new interval.
3. Each `refresh()` calls `beginScan()` on every provider and on `SessionSnapshotStore`, iterates all enabled providers, stats each file **once** (for the lookback cutoff, the cache freshness check, and the provider's own timestamp fallback), parses only changed files, then rebuilds `AggregatedMetrics` and updates the status bar.
4. The loop yields with `setImmediate` every 20 parsed files so the host stays responsive mid-refresh.
5. `refresh()` is re-entrancy guarded: a call made while a pass is in flight returns that pass's promise instead of starting a second one. This matters only because the loop now yields - before, it could not overlap itself.
6. Parse cache and Copilot snapshots are flushed once at the end of the pass, not per file.

Measured on WSL2 with ~220 session files: a full refresh went from 13.1-17.2 s to 7.1-7.5 s cold, and to ~2.4 s once the parse cache is warm. See [sessions/2026-10-03-startup-performance.md](sessions/2026-10-03-startup-performance.md).
