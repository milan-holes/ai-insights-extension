# Session: Copilot Session Snapshot Store - 2026-05-19

## What was done

- Created `SessionSnapshotStore` — a new core module that persists parsed Copilot sessions to disk in VS Code's extension global storage
- Integrated the store into the `refresh()` loop in `extension.ts`: saves a snapshot after every Copilot parse, then merges persisted snapshots for any sessions whose source files no longer exist
- Added developer guidance wiki (`wiki/developer-guide.md`) explaining `/clear` and `/compact` behaviour across providers
- Added technical wiki doc (`wiki/core/sessionSnapshotStore.md`)
- Updated `wiki/README.md` and `CHANGELOG.md`

## Files changed

- `src/core/sessionSnapshotStore.ts` — new file; `SessionSnapshotStore` class
- `src/extension.ts` — import + instantiate `SessionSnapshotStore`; snapshot Copilot sessions in refresh loop; merge snapshots for deleted files; prune on each refresh
- `wiki/core/sessionSnapshotStore.md` — new technical wiki doc
- `wiki/developer-guide.md` — new developer guide on session management
- `wiki/README.md` — added two new table entries
- `CHANGELOG.md` — added unreleased entry

## Decisions made

- **Only snapshot Copilot** — Claude Code is append-only and safe; snapshotting it would be redundant I/O.
- **globalStorageUri, not globalState** — `globalState` has a size limit and poor large-object ergonomics. A flat JSON file in `globalStorageUri` is simpler and can hold 2 000 sessions without issue.
- **Max data-loss window = one refresh interval** — if a Copilot session is cleared between two refresh cycles, interactions added in that gap are lost. Documented clearly in the developer guide. Users can mitigate by running manual refresh before clearing.
- **Prune on every refresh** — keeps the snapshot file aligned with the same `sessionLookbackDays` window used for live files. No separate maintenance job needed.
- **Silent write failures** — analytics degrade gracefully rather than crashing the extension if the storage directory is unwritable.

## Follow-up / known gaps

- The snapshot file is a single JSON blob; for very large histories (thousands of sessions over 400 days) it may grow several MB. Could switch to per-session files or SQLite if this becomes a problem.
- No UI indicator that a session is being shown from a snapshot vs. a live file. Could add a "(restored)" badge in the Sessions view.
