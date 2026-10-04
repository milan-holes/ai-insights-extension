# Session: Remove the Coach tab - 2026-08-25

## What was done

- Removed the Coach panel and everything wired to it. The feature was added earlier the same day (see [2026-08-25-quota-planner-and-coach.md](2026-08-25-quota-planner-and-coach.md)) and never shipped in a tagged release, so it was reverted rather than deprecated.
- Deleted the detector engine, the webview panel, the nav tab, the command contribution, the shared types, and both wiki pages.
- Dropped the `Added: Coach panel` bullet from `CHANGELOG.md`'s `[Unreleased]` section instead of adding a `Removed` entry - no released version ever exposed the tab.

## Files changed

- `src/core/coach.ts` - deleted (trend + finding detectors)
- `src/webview/coachView.ts` - deleted (panel)
- [`src/types.ts`](../../src/types.ts) - dropped `CoachSeverity` / `CoachFinding` / `CoachWeeklyPoint` / `CoachTrend` / `CoachReport`
- [`src/webview/navShared.ts`](../../src/webview/navShared.ts) - dropped the `coach` nav tab, its `NavTab` union member, and the `showCoach` entry in `NAV_COMMANDS`
- [`src/extension.ts`](../../src/extension.ts) - dropped both imports, the `aiInsights.showCoach` registration, and `showCoach()`
- [`package.json`](../../package.json) - dropped the `aiInsights.showCoach` command contribution
- [`README.md`](../../README.md) - dropped the `🧭 Coach` feature section and the command-table row
- [`CHANGELOG.md`](../../CHANGELOG.md) - dropped the unreleased Coach bullet
- `wiki/core/coach.md`, `wiki/webview/coachView.md` - deleted; rows removed from [`wiki/README.md`](../README.md)

## Decisions made

- `docs/next-feature-analysis.md` still discusses a waste-detector/coach view as a *candidate* feature. Left untouched: it is a research/planning doc, not documentation of shipped behavior.
- The 2026-08-25 session log that introduced Coach was kept as a historical record, with a note at the top pointing here.

## Follow-up / known gaps

- None. `npx tsc --noEmit` is clean and no `coach` references remain in `src/`, `package.json`, `README.md`, or `CHANGELOG.md`.
