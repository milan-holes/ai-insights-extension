# Session: Technique Benchmark - 2026-05-16

## What was done

- Designed and implemented a full technique benchmark system integrated into the ai-insights extension
- Added `src/benchmark/` module with 6 files: types, techniques, tasks, worktree manager, runner, judge
- Added `src/webview/benchmarkView.ts` — the "Benchmark" tab panel
- Wired into nav system, extension.ts, and package.json
- Installed `@anthropic-ai/sdk` as a runtime dependency
- Created `docs/benchmark/` design documentation (5 files)

## Files changed

- `src/benchmark/types.ts` — all benchmark types (Technique, BenchmarkTask, RunResult, etc.)
- `src/benchmark/techniques.ts` — 8 built-in techniques across 5 families
- `src/benchmark/tasks.ts` — 5 built-in tasks (K1 knowledge, K2 data flow, G1 codegen, D1 debug, R2 rot-stress)
- `src/benchmark/worktree.ts` — git worktree create/teardown + context file loader + size measurer
- `src/benchmark/runner.ts` — orchestrates (technique × task × rot × runs) matrix via Anthropic streaming API
- `src/benchmark/judge.ts` — LLM-as-judge scoring (hallucination + task success) against ground truth
- `src/webview/benchmarkView.ts` — full webview panel: config sidebar + results in 3 tabs
- `src/webview/navShared.ts` — added `benchmark` NavTab + `showBenchmark` command
- `src/extension.ts` — registered `aiInsights.showBenchmark` command
- `package.json` — added command contribution + `@anthropic-ai/sdk` dependency
- `CHANGELOG.md` — added Unreleased section
- `docs/benchmark/` — 5 design docs (README, techniques, context-engineering, prompts, providers, architecture)

## Decisions made

- **git worktree isolation**: each technique runs in `/tmp/ai-bench/{repo}/{technique}` on a throwaway branch — original repo never touched. Worktrees are always cleaned up in `finally` blocks.
- **Anthropic-only for MVP**: full token visibility (including cache_creation/cache_read tokens) makes Anthropic the only provider with exact measurements. Copilot would require estimation.
- **Judge uses Haiku**: judge model is `claude-haiku-4-5-20251001` (cheap, fast) while benchmark runs use Sonnet by default. This keeps judge cost negligible.
- **Rot simulation via history injection**: synthetic prior conversation turns injected into the message array simulate fresh/warm/bloated/critical context states without requiring real long sessions.
- **API key in SecretStorage**: never stored in settings or workspace state — VS Code SecretStorage only.
- **Context cap at 30 wiki files**: wiki-all loader reads max 30 files to keep context manageable and avoid overwhelming the model.

## Provider adapter refactor (same session)

Replaced mandatory Anthropic API key with a multi-provider adapter system:
- `src/benchmark/adapters.ts` — `ClaudeCodeCliAdapter`, `CopilotAdapter` (vscode.lm), `AnthropicApiAdapter`
- Provider selector in sidebar replaces the API key field as the primary input
- Claude Code CLI adapter: runs `claude -p` in the worktree so CLAUDE.md is picked up automatically — no manual context injection, most realistic test
- Copilot adapter: uses `vscode.lm.selectChatModels()` — no key needed, uses existing subscription
- Anthropic API key is now optional (only required for direct API adapter or LLM judge scoring)
- `checkAdapter` message lets the webview verify availability before running

## Follow-up / known gaps

- Copilot AI credits reporting (estimated tokens × model rate) not yet surfaced in results view
- Export results to JSON not yet implemented
- RAG/selective-wiki context loader not yet implemented
- Custom task definition via UI not yet implemented
- Results not persisted across panel reloads (in-memory only for MVP)
- Claude Code CLI token counts fall back to estimation if JSONL project path doesn't match expected encoding
