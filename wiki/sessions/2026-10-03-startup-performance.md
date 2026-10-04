# Session: startup & refresh performance - 2026-10-03

## What was done

Activation was measured at **19 673 ms** in the Extensions view. Profiling showed the cost was
not CPU and not webview rendering - it was synchronous filesystem I/O in the provider layer,
run on the extension host thread without ever yielding.

CPU profile of one full refresh (8 569 ms total):

| Syscall      | Self time | Share |
| ------------ | --------- | ----- |
| `existsSync` | 3 175 ms  | 37 %  |
| `readFileUtf8` | 2 068 ms | 24 % |
| `stat`       | 1 203 ms  | 14 %  |
| `readdir`    | 1 065 ms  | 12 %  |
| **all fs**   | **~7.5 s** | **87 %** |
| JSON/parse logic | <500 ms | 6 % |

`fs` calls attributed to their call site (before):

| Call site                            | Calls | Time    |
| ------------------------------------ | ----- | ------- |
| `CopilotProvider.parseSessionFile` (readFileSync) | 95 | 2 103 ms |
| `CopilotProvider.addSessionFilesFromDir` (existsSync) | 546 | 2 031 ms |
| `CopilotProvider.findDebugLogPath` (existsSync) | 1 950 | 1 217 ms |
| `CopilotProvider.getFileFallbackDate` (statSync) | 95 | 666 ms |
| `VisualStudioProvider.scanForVsDirs` (readdirSync) | 142 | 604 ms |
| `CopilotProvider.extractWorkspace` (readFileSync) | 49 | 315 ms |

## Results

Measured by alternating before/after runs of the full discover+parse pass (`hrtime`, WSL2,
~220 session files / ~43 MB):

| Scenario                            | Before    | After    |
| ----------------------------------- | --------- | -------- |
| Full refresh (3 alternating rounds) | 13.1-17.2 s | 7.1-7.5 s |
| Cold refresh, empty parse cache     | -         | 8.0 s    |
| Warm refresh, parse cache on disk   | -         | **2.4 s** |
| `existsSync` calls per refresh      | 2 566 (~3.5 s) | 556 (14 ms) |
| `VisualStudioProvider.discover`     | 746-1 474 ms | 16 ms  |

Activation itself no longer includes any of this: the first refresh is deferred out of
`activate()` and yields to the event loop every 20 files.

## Files changed

- `src/providers/copilot.ts` - per-scan caches (`dirExistsCache`, `dirListCache`, `statCache`,
  `workspaceCache`, `debugLogIndex`) behind a new `beginScan()`; `findDebugLogPath` rewritten
  from a per-file O(files x roots) probe into a one-pass index; workspace discovery now does one
  `readdir` of the workspace root instead of 13 blind `existsSync` probes; `extractWorkspace`
  reads each `workspace.json` once per hash dir; `getFileFallbackDate` reuses the caller's stat.
- `src/providers/visualStudio.ts` - the depth-7 home-tree scan is gated on evidence that Visual
  Studio is present (its Copilot Chat log dir exists, or the user configured explicit roots) and
  throttled to once per 30 min, with results reused in between.
- `src/providers/base.ts` - `beginScan()` hook (default no-op) and optional `stats` parameter on
  `parseSessionFile`.
- `src/providers/claudeCode.ts`, `src/providers/codex.ts`, `src/providers/jetbrainsAI.ts` -
  dropped `existsSync` guards that preceded a `readdirSync` already inside a `try/catch`.
- `src/core/cacheManager.ts` - disk persistence (`load()` / `flush()` / `pruneMissing()`),
  `mtimeMs` parameters so callers can avoid a second stat.
- `src/core/sessionSnapshotStore.ts` - `beginScan()` / `flush()`; mutations are batched in memory
  instead of rewriting the whole file per saved session.
- `src/extension.ts` - `refresh()` deferred out of `activate()`, split into a re-entrancy-guarded
  wrapper plus `runRefresh()`, one stat per file threaded through, `yieldToHost()` every 20 files,
  cache load at activation and flush at `deactivate()`. Dead `wasFileModifiedSince()` removed.
- `src/benchmark/judge.ts` - `import type` for `Anthropic` (it is only used in a type position).

## Decisions made

- **`findDebugLogPath` became an index, not a memoized probe.** Memoizing `existsSync` would not
  have helped: the 1 950 calls were all for *distinct* paths. One `readdir` per debug-logs root
  that actually exists replaces the whole O(files x roots) probe.
- **Blind candidate-path probing replaced by listing the parent.** Probing 13 fixed subpaths per
  workspace costs 13 syscalls whether or not they exist; listing the workspace root costs one and
  answers all 13. Simply deleting the `existsSync` guards was measured to be *worse* than the
  original in the discovery path - a missing directory then costs a failed `readdirSync` plus a
  thrown exception rather than one cheap `stat`. The guards were only removed where the caller
  already knows the directory exists.
- **Explicit `setImmediate` yields.** Every provider method is declared `async` but has a fully
  synchronous body, so `await` only drains microtasks and never returns to the event loop -
  verified directly: ten awaited sync-body calls spanning 300 ms did not let a pending
  `setImmediate` run. The `async` signatures were buying nothing.
- **A re-entrancy guard was added with the yields.** Before, `refresh()` could not overlap itself
  because it never yielded. Now that it does, the 5-minute timer could stack on an in-flight pass,
  so `refresh()` returns the in-flight promise instead of starting a second one.
- **Null parse results are now cached.** 45 of 95 Copilot files parse to `null` and were being
  re-read on every refresh; `CacheEntry.sessionData` was already typed `Session | null`.
- **Webview modules were left eagerly imported.** Measured ceiling for lazy-loading all of them is
  ~27 ms (full bundle require 106 ms vs 79 ms with every webview module stubbed), against
  run-to-run noise of 34-144 ms. Not worth restructuring the static `SessionsViewProvider._addTag`
  wiring and 14 command handlers for 0.14 % of the original 19.7 s.
- **The `@anthropic-ai/sdk` type-only import was kept despite no measurable win.** It is correct
  either way (the symbol is only used as a type), but it did not move require time.

## Verification

- Discovery and parse output diffed before/after across all six providers: identical file lists
  and identical sessions (id, total tokens, workspace, interaction count). The only difference was
  this session's own Claude Code log, which grew while the comparison ran.
- `npm test` - 17/17 pass. `npm run package` builds clean.

## Follow-up / known gaps

- The remaining ~2.4 s warm refresh is almost entirely discovery (`readdir`/`stat`) on the WSL
  `/mnt/c` 9p mount. Moving discovery to async `fs.promises` with bounded concurrency would
  overlap that latency; it is no longer on the activation path, so it was left alone.
- Each VS Code window still runs its own independent refresh and keeps its own copy of the
  parse cache; the two windows do not share work.
- `SessionsViewProvider.pushUpdate` still replaces the entire webview HTML every 30 s while the
  Sessions panel is open. Not a startup cost, so out of scope here, but it re-parses ~100 KB of
  HTML and resets scroll position on a timer.
