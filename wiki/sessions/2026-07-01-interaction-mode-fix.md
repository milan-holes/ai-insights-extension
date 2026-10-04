# Session: Interaction Modes widget always showing 100% CLI - 2026-07-01

## What was done

- Diagnosed why the "Interaction Modes" dashboard widget showed all interactions under `CLI` and 0 everywhere else, even for a user who was actively using Ask mode and editing code.
- Root cause: `normalizeMode()` in `sessionAggregator.ts` force-mapped **every** Claude Code interaction to `'cli'` regardless of how it was used, and `ClaudeCodeProvider` never captured the JSONL fields (`entrypoint`, `permissionMode`) needed to tell terminal usage apart from IDE-hosted ask/edit/agent/plan usage.
- Added `classifyMode()` to `ClaudeCodeProvider`, using `entrypoint` (host surface) + `permissionMode` (carried forward from the last `user` entry) + whether the turn made tool calls, to bucket each interaction into `cli` / `ask` / `edit` / `agent` / `plan`.
- Updated `normalizeMode()` to pass through the provider's own classification for `claudeCode` instead of hardcoding `cli`.

## Files changed

- `src/providers/claudeCode.ts` - track `entrypoint` / `permissionMode` per JSONL line; added `classifyMode()`; interaction `mode` field now reflects actual usage instead of the message role (`assistant`/`user`).
- `src/core/sessionAggregator.ts` - `normalizeMode()` no longer force-maps `claudeCode` to `cli`; passes through `ask`/`edit`/`agent`/`plan` from the provider, falling back to `cli` for raw terminal sessions and unrecognized values (e.g. `compaction`).
- `wiki/providers/claudeCode.md` - documented the new fields and classification rules.
- `wiki/core/sessionAggregator.md` - documented `normalizeMode()` behavior per provider.

## Decisions made

- Sessions with no `entrypoint` field (pre-dating Claude Code's IDE integrations) default to `cli`, since that's what raw terminal usage looked like before entrypoint tracking existed.
- Mode is inferred per-turn (not per-session), since a user can switch between plan/default/acceptEdits within one conversation - `permissionMode` only appears on `user`-type JSONL entries, so it's carried forward to the following `assistant` entries.
- `default` permission mode with tool calls is classified as `agent` (autonomous, approval-per-action) rather than `ask`, since it still executes tools; turns with zero tool calls are `ask` regardless of permission mode.

## Follow-up / known gaps

- No automated tests were added/run for this change - `npm test` currently fails locally because `node_modules/.bin/jest` isn't installed in this environment (unrelated pre-existing issue).
- Verified the new classification against real local session data in `~/.claude/projects/`, which produced a realistic split across `agent`/`ask`/`edit` (previously 100% `cli`).
