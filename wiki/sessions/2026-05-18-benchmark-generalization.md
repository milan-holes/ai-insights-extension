# Session: Benchmark generalization - 2026-05-18

## What was done

- Replaced all 5 hardcoded benchmark tasks (which referenced `sessionAggregator`, `BaseProvider`, `CacheManager`, etc.) with 5 generic tasks that work against any target repository
- Rewrote the synthetic ROT_HISTORY conversation turns to remove every reference to this extension's internal files and modules
- Made the Memory Bank technique's `createFiles` a function of `RepoScan` so the injected memory-bank files reflect the actual target repo (language, README summary, type/test file list) rather than hard-describing this extension
- Added union type to `Technique.createFiles` in `types.ts` to support both static arrays and `(scan: RepoScan) => Array<{path, content}>` factory functions
- Updated `setupWorktree` in `worktree.ts` to accept a `scan` parameter and resolve `createFiles` at runtime
- Passed `scan` through from `runBenchmark` to `setupWorktree` in `runner.ts`

## Files changed

- [`src/benchmark/tasks.ts`](../../src/benchmark/tasks.ts) — 5 new generic tasks (K1-project-overview, K2-main-modules, G1-utility-function, D1-stale-data, R2-contradiction)
- [`src/benchmark/runner.ts`](../../src/benchmark/runner.ts) — generic ROT_HISTORY; pass `scan` to `setupWorktree`
- [`src/benchmark/worktree.ts`](../../src/benchmark/worktree.ts) — accept `scan` param; resolve `createFiles` at runtime
- [`src/benchmark/techniques.ts`](../../src/benchmark/techniques.ts) — replaced 3 hardcoded memory-bank constants with `buildMemoryBankFiles(scan)` factory function
- [`src/benchmark/types.ts`](../../src/benchmark/types.ts) — `Technique.createFiles` now accepts `| ((scan: RepoScan) => ...)` union

## Decisions made

- Task ground truth stays static (not scan-derived) — the LLM judge evaluates qualitatively and can handle broad facts; the heuristic fallback gives approximate scores, which is acceptable since it is only used when no API key is available
- The `R2-contradiction` rot-stress task injects the false claim ("no external dependencies") via the `critical` ROT_HISTORY turn, not the task prompt itself — matches the original design where context rot is part of the conversation history
- Memory bank content is generated from `RepoScan.readmeExcerpt`, `primaryLanguage`, `typeFiles`, and `testFiles` — enough to describe any project without hard-coding anything

## Follow-up / known gaps

- Task K2 (main modules) asks for specific names but has no way to validate them without knowing the target repo; LLM judge will handle this, heuristic scoring will be approximate
- The contradiction in `R2` ("no external dependencies") will score correctly only when the target repo actually has third-party dependencies, which is true for nearly all real projects
