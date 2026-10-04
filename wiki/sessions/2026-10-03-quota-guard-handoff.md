# Session: Quota Guard, safe-stop checkpoints & session handoff - 2026-10-03

## Problem

When a provider's credits or rate-limit window run out mid-session, the agent run just stops - often with a half-written refactor on disk that no longer compiles. The extension already *knew* about the limits that killed the run, but did nothing actionable with that knowledge.

## What was done

Three layers, all built on signals that already existed:

1. **Quota Guard** - normalized Copilot / Claude / Codex quota into one risk model expressed as *minutes of work left at the current burn rate*, with real notifications and status-bar escalation.
2. **Safe-stop checkpoints** - non-invasive git snapshots so half-finished work is always recoverable.
3. **Session handoff** - a brief describing the unfinished work, plus delegation to a provider that still has quota.

Plus a free win found along the way: **Codex already records real quota data in its own session logs**, on the very entries [providers/codex.md](../providers/codex.md) was already parsing. It was being discarded.

## Files changed

| File | Change |
| --- | --- |
| `src/core/quotaGuard.ts` | **New.** Cross-provider quota normalization, burn-rate history, risk assessment, handoff-target ranking. See [core/quotaGuard.md](../core/quotaGuard.md) |
| `src/core/sessionCheckpoint.ts` | **New.** Temp-index git snapshots + recovery instructions. See [core/sessionCheckpoint.md](../core/sessionCheckpoint.md) |
| `src/core/handoffBuilder.ts` | **New.** Pure brief/prompt generation from parsed interactions. See [core/sessionHandoff.md](../core/sessionHandoff.md) |
| `src/core/handoffCoordinator.ts` | **New.** Checkpoint + write brief + delegation routes |
| `src/providers/codex.ts` | Parse `payload.rate_limits` into `Session.rateLimits`; also set `promptPreview` per interaction (was never populated) |
| `src/types.ts` | `SessionRateLimits` / `SessionRateLimitWindow`; `Session.rateLimits` |
| `src/extension.ts` | `evaluateQuotaGuard()` on each refresh, notification gating, status-bar escalation, 4 new commands |
| `src/benchmark/adapters.ts` | Exported `findClaudeBin` / `findCodexBin` for reuse by delegation |
| `package.json` | 4 commands, 7 `quotaGuard.*` settings |

## Decisions made

**Minutes of work, not percent.** A percentage can't answer "can I finish this refactor?" - 90% used is harmless at the end of a window and fatal at the start. Burn rate comes from a new rolling per-window utilization history, kept separate from `copilotQuota`'s store (that one tracks remaining *requests* per login at daily granularity; this needs *percent* per window at minute granularity).

**Temp index instead of `git stash` or a WIP commit.** Both move state a still-running agent may rely on - stash reverts the tree, a WIP commit moves `HEAD`. Writing a commit object through `GIT_INDEX_FILE` leaves `git status` byte-identical while still capturing untracked files, which `git stash create` drops (and which are usually the most important part of unfinished work). Verified: status, `HEAD`, index and branch list all unchanged after a checkpoint; `git restore --source=<sha>` recovers the interrupted state.

**Auto-checkpoint on by default.** The snapshot has to exist *before* the wall hits, including when nobody is at the keyboard. Only defensible because the mechanism is non-invasive by construction.

**No claim of mid-turn failover.** This extension observes logs; it has no way to pause or inject into a running agent. Delegation therefore means "relaunch the remainder somewhere with headroom", not "transfer the live session". Building the honest version beat shipping a seamless-looking one that silently drops context.

**False-alarm suppression over sensitivity.** A warning system that gets ignored is worse than none: `resetsBeforeExhaustion` forces severity to `ok` when the window rolls over before quota runs out, burn-rate averaging skips across window resets, and stale readings are discarded (see below).

**Prompt chain, not last message.** Follow-ups are routinely fragments ("also add the Session class") meaningless without the request they refine, so the handoff prompt carries the recent chain and always keeps the first prompt when trimming.

## Bugs found and fixed during verification

- **Stale session-log quota reported as current.** The newest Codex `rate_limits` in the local logs was three months old with a `resets_at` already in the past, yet surfaced as live 95%-used quota - which would have fired a bogus warning. Added staleness bounds: 60 min for session-log readings, 30 min for cached live-API readings, plus discarding windows whose reset time has passed.
- **`for-each-ref --format=%(refname)` mangled by the shell.** `listCheckpoints()` silently returned `[]` because the format string's parentheses were interpreted by the shell. Converted every git call in `sessionCheckpoint.ts` from `execSync` with a command string to `execFileSync` with an argument array - also fixes `HEAD^{tree}`.
- **Handoff prompt quoted the wrong request** as the goal (newest instead of the original). Fixed via `selectPrompts()`.

## Verification

No test harness exists in this repo (`npm test` points at jest, which isn't a dependency), so verification was done with standalone esbuild-bundled scripts against real data:

- Codex parsing across all 18 local rollout logs - 18/18 produced `rateLimits`.
- Burn-rate math including the window-reset case (0.667 %/min and 0.500 %/min as expected, never negative).
- Severity transitions across 7 scenarios incl. `resetsBeforeExhaustion` and exhausted.
- 9 staleness cases (fresh / 3-months-stale / reset-in-past / 2h-stale / no-reset-time, Claude age bounds, unix-seconds reset header).
- 15 checkpoint invariants in a scratch repo, incl. status/HEAD/index/branch unchanged, untracked captured, ignored excluded, and restore actually recovering the work.
- 13 end-to-end `prepareHandoff()` assertions with a stubbed `vscode` module.

`npm run compile` (tsc + esbuild) clean.

## Follow-up / known gaps

- **Evaluation cadence follows `aiInsights.refreshIntervalMinutes`** (5 min default). Fine for the 15-min default threshold, but a tighter lead time needs a lower refresh interval. A dedicated faster timer was considered and rejected: Copilot's endpoint has no client-side throttle, so a 60s guard timer would hammer GitHub.
- **No per-model premium-request multiplier** for Copilot - a 3x model burns the window 3x faster than the request count implies. Pre-existing gap, also noted in [core/copilotQuota.md](../core/copilotQuota.md).
- **Checkpoints are never pruned.** `deleteCheckpoint()` exists but nothing calls it on a schedule.
- **Copilot sessions have no `promptPreview`**, so a Copilot handoff leans on git state rather than the stated goal. Codex now populates it; Claude Code already did.
- **No webview surface.** Everything runs through notifications, quick-picks and the status bar. A "Session continuity" panel showing quota windows and checkpoint history would be the natural next step.
- **`npm run lint` is broken repo-wide** - ESLint 8.57 finds no config file (no `.eslintrc*` or `eslint.config.*` exists). Pre-existing, untouched here.
- **Unsaved editor buffers aren't captured** by checkpoints, which read the tree from disk.
