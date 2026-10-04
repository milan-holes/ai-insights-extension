# Session: Live Monitor and Context Workbench — 2026-05-16

## What was done

- Added **Live Session Monitor** panel (Feature 1)
- Added **Context Efficiency Workbench** panel (Feature 2)
- Expanded `ContextRotAnalysis` type and `computeContextRotAnalysis()` function
- Added two new nav tabs (Live, Context) to the shared navigation bar
- Added "Analyze" button on every session row in Sessions view

## Files changed

- `src/types.ts` — added `LiveBudgetConfig`, `LiveBudgetType`, `LiveAlert`, `LiveSessionState`, `RateLimitEvent`, `LiveMonitorCalibration`, `ContextTimelinePoint`, `OverloadSignal`, `OverloadSignalType`, `FreshSessionBrief`, `ContextRotAnalysis`
- `src/core/contextRot.ts` — rewrote to export `computeContextRotAnalysis()` (full analysis) and keep `computeContextRotScore()` as a lightweight wrapper; added timeline builder, overload signal detector, rehydration checklist generator, fresh session brief builder
- `src/core/liveSessionMonitor.ts` — new: detects live sessions by file mtime (<3 min) or last interaction timestamp, computes burn rate over 10-min window, projects exhaustion, emits alerts
- `src/webview/liveMonitorView.ts` — new: live session cards with burn rate gauge and budget bar, manual calibration form, rate-limit event log, 30-s auto-refresh
- `src/webview/contextWorkbench.ts` — new: split-panel layout; left sidebar session list with score dots; right panel with score ring, restart banner, timeline Chart.js chart, signal grid, fresh brief, checklist, patterns
- `src/webview/navShared.ts` — added `liveMonitor` and `contextWorkbench` NavTab types, two new NAV_TABS entries, two new NAV_COMMANDS entries
- `src/webview/sessionsView.ts` — added `analyzeSession()` handler and "Analyze" button per row that opens Context Workbench focused on that session
- `src/extension.ts` — imported new modules, loaded liveBudgetConfig and rateLimitEvents from globalState, registered four new commands (`showLiveMonitor`, `showContextWorkbench`, `logRateLimitHit`, `saveLiveBudgetConfig`)
- `package.json` — added two command entries (`showLiveMonitor`, `showContextWorkbench`)
- `CHANGELOG.md` — added v0.1.7 entry

## Decisions made

- **Live detection uses file mtime + last interaction timestamp** (not process polling) — keeps the extension read-only with no OS process visibility
- **3-minute liveness threshold** — short enough to be responsive; if a session file isn't touched in 3 min it's considered idle
- **Burn rate windowed to last 10 minutes** — smooths over thinking pauses; falls back to whole-session average for short sessions (<2 interactions in window)
- **`computeContextRotScore` preserved as a thin wrapper** over `computeContextRotAnalysis` — zero breaking changes to sessionsView badge
- **Context Workbench renders all analyses server-side** (pre-computed in `buildHtml`) and passes them as JSON to the webview, letting the client switch sessions without round-trips
- **Rate limit events capped at 100** in globalState to avoid unbounded growth

## Follow-up / known gaps

- Live burn rate projections assume current burn rate continues; a smarter predictor would weight recent interactions more heavily
- File path extraction from tool calls is not possible with the current normalized `Interaction` type (tool calls are names, not paths) — "changed files" in the brief comes from tool name heuristics only
- Provider-specific rate-limit thresholds (Claude Pro, Copilot Premium, etc.) are not yet encoded; budget limits require manual calibration
- Context Workbench does not yet detect "stale instructions" (system prompt / CLAUDE.md content that hasn't changed but keeps repeating)
