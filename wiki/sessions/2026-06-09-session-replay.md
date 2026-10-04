# Session: Session Replay Feature - 2026-06-09

## What was done

- Added a "Replay" button to every session row in the Sessions view
- Created a new `ReplayViewProvider` panel (`src/webview/replayView.ts`) that renders a full turn-by-turn interactive replay UI
- Registered `aiInsights.showSessionReplay` command in extension.ts
- Extended `NavTab` type and `NAV_COMMANDS` in navShared.ts

## Files changed

- `src/webview/replayView.ts` — new file; full replay panel (~350 lines TypeScript + inline HTML/CSS/JS)
- `src/webview/navShared.ts` — added `'replay'` to `NavTab`; added `showSessionReplay` to `NAV_COMMANDS`
- `src/extension.ts` — import `ReplayViewProvider`; register `aiInsights.showSessionReplay(sessionId)`
- `src/webview/sessionsView.ts` — `replaySession()` JS function + `window.replaySession`; `replayBtn` variable in row builder; `replaySession` message handler calling `aiInsights.showSessionReplay`
- `CHANGELOG.md` — Unreleased entry added
- `wiki/webview/replayView.md` — new wiki doc
- `wiki/README.md` — index entry added

## Decisions made

- **All data embedded in HTML** — `ReplayTurn[]` serialised as a JSON literal in the `<script>` block with `</` escaped to `<\/`. No back-channel requests needed after panel load; avoids latency and keeps the panel self-contained.
- **Per-turn cost computed at build time** — `calculateCost()` called in `buildHtml()` so JS can display it without importing pricing data into the webview.
- **Peak context as denominator** — the context-window fill bar uses `session.peakEffectiveContextTokens` as the 100% ceiling rather than a hardcoded model limit; accurate regardless of provider.
- **Replay is modal, not a nav tab** — launched from the Sessions view, not added to the main nav bar. The `'replay'` NavTab type is registered for completeness but no tab entry was added.
- **Context bar colour progression** — blue → yellow → orange → red at 50/75/90% fill to visually communicate context pressure increasing.

## Follow-up / known gaps

- Timeline blocks have a minimum width of 3px; for sessions with 200+ turns the individual blocks will be very narrow. A future improvement could group turns into buckets when width < threshold.
- Playback speed is in turns/sec, not real-time proportional. A "real time" mode (replaying at actual elapsed speed) could be added.
- The panel re-uses the existing webview panel instance; opening a second session replaces the content of the existing tab.
