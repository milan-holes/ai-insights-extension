# Session: Context Rot Identifier - 2026-05-10

## What was done

- Created `src/core/contextRot.ts` — pure function `computeContextRotScore(session)` that derives a 0–10 rot score and `healthy / warning / stale` label from static session fields
- Added `contextRot: ContextRotScore` field to `SessionRow` in `sessionsView.ts`; computed in `toRows()` using the full `Session` object
- Added **Context Health** column to the sessions table (positioned between Cost and Interactions)
- Added CSS classes `.ctx-badge`, `.ctx-healthy`, `.ctx-warning`, `.ctx-stale`, `.ctx-na` for colored pills
- Added `contextHealthCell(s)` JS renderer in the webview with a tooltip showing score/turns/age/bloat/output-trend breakdown
- Updated `CHANGELOG.md` with the new feature entry

## Files changed

- `src/core/contextRot.ts` — new module, scoring logic
- `src/webview/sessionsView.ts` — import, SessionRow type, toRows(), CSS, JS renderer, table header + row
- `CHANGELOG.md` — feature entry under 2026-05-10

## Decisions made

- Computed at `toRows()` time (TypeScript layer), not inside the webview JS — keeps scoring logic typed and testable
- Score derived entirely from already-available `Session` fields (interactions array, token counts, timestamps) — no new data collection needed
- Sessions with < 3 turns always show "—" to avoid misleading scores on single-prompt sessions
- Input bloat and output decline compare first-third vs last-third of interaction list (requires ≥ 6 turns to activate)

## Follow-up / known gaps

- No sortable "Context Health" column yet (would require numeric sort key on `contextRot.score`)
- Accept rate degradation signal (from `AcceptanceTracker`) is not yet wired — would be the strongest real-time signal
- Repetition detection (cosine similarity of adjacent responses) not implemented — needs response text in session data
