# Session: GitHub-style Activity Heatmap on the dashboard - 2026-07-01

## What was done

- Added a "🔥 Activity Heatmap" section to the main dashboard, showing a GitHub-contributions-style calendar grid (trailing ~53 weeks) colored by daily token usage.
- Fully server-rendered (no client-side JS/canvas): built once per dashboard render from `AggregatedMetrics.daily`, same pattern as the other pure-HTML sections.

## Files changed

- [src/webview/dashboard.ts](../../src/webview/dashboard.ts) - new `buildActivityHeatmapHtml(daily: DailyUsage[])` helper: buckets every date in the trailing 371 days (snapped back to the preceding Sunday, GitHub's convention) into weekly columns, maps each day's total tokens to one of 5 shades of `--stage-4` green via quantile thresholds (25th/50th percentile of non-zero days, with the single busiest day always forced to the brightest shade), and renders month labels, Mon/Wed/Fri row labels, and a Less→More legend. Native `title` attributes provide the per-day tooltip (date + token count) - no extra JS needed. Wired in just above the existing "📈 Daily Token Usage" chart section. Added `DailyUsage` and `toLocalDateKey` (from `core/dateUtils.ts`) to the top imports.

## Decisions made

- Used quantiles of the user's own non-zero daily totals (not a fixed global scale) so the coloring adapts to each user's usage distribution, matching how GitHub's own heatmap scales per-account rather than using absolute commit counts.
- Guarded the quantile bucketing so the single highest-usage day always renders as the brightest shade - with few active days, percentile buckets can collapse and the max value would otherwise land in a dim bucket.
- Rendered as plain flex/div grid with inline styles (consistent with the rest of `dashboard.ts`, which has no separate CSS file) instead of `<canvas>`, since a calendar grid of solid-color cells doesn't need a drawing API and native `title` tooltips are simpler than wiring up custom hover JS.
- Placed it as a normal `.section` on the existing single-page dashboard (not a separate nav screen), matching how other one-off widgets (Session Complexity, Workspace Health, Developer Impact) are added.

## Follow-up / known gaps

- The heatmap always spans the fixed trailing 371-day window regardless of how long the user has had the extension installed; early days with no data simply render as empty cells (same as a fresh GitHub profile).

## Update - full-width grid + rescan loading overlay

- Reworked the cell layout from a fixed-pixel flex grid (`width:11px` squares in nested flex columns) to a single CSS Grid: `grid-template-columns: 28px repeat(weeks.length, 1fr)`, with the day-of-week label column, month-label row, and day cells all as children of one grid in row-major order (month row first, then 7 day rows). Day cells use `aspect-ratio:1` with no explicit size, so they stay square while stretching/shrinking to fill the section's full width - fixes the large empty gap that used to sit to the right of the ~53-week grid on wide dashboards.
- The lookback `<select>` lost its inline `onchange` and got `id="lookbackSelect"` instead; a new listener in the existing "Navigation loading feedback" IIFE (`dashboard.ts`, next to the refresh-button handler) shows the dashboard's existing full-screen `#navOverlay`/`#navOverlayText` (same one used for nav-tab clicks) with the message "Rescanning N days of session history…" before posting `setSessionLookbackDays` - previously the page gave no feedback during the few seconds `aiInsights.refresh` takes to re-scan provider files, since `showDashboard` only shows a loading state on the very first load (`latestMetrics` is null).
- Reused the existing overlay/`clearAllLoading()` mechanism rather than building a new one, for visual consistency with the other nav-loading buttons; fallback auto-clear timeout bumped to 15s (vs. 4-5s for simple nav) since a session re-scan is slower than a plain screen switch.
- Fixed a slight grid overflow past the card's right/bottom edge: `1fr` is shorthand for `minmax(auto, 1fr)`, and the `aspect-ratio:1` cells' content-derived automatic minimum size could push the summed column widths a couple pixels past the container. Changed to `minmax(0, 1fr)` for the week columns and added `overflow:hidden` on the grid.

## Update - distinguish "not analyzed" from "zero activity"

- The heatmap always renders the full trailing 371-day grid, but `daily` (`AggregatedMetrics.daily`) only has entries back to `aiInsights.sessionLookbackDays` (30 by default) - `extension.ts`'s `refresh()` never scans session files older than `getSessionCutoff()`. Previously every day outside that window looked identical to an in-window day with genuinely zero usage (`var(--bg-surface-high)`, level 0), so with the default 30-day window almost the entire year-long grid looked like "no activity" even though it simply hadn't been scanned.
- Added an `analyzed: boolean` flag per day, computed the same way as `getSessionCutoff()` in `extension.ts` (`today - lookbackDays`, read from the same `aiInsights.sessionLookbackDays` setting already used for the dropdown). Days before the cutoff now render in a much dimmer `rgba(255,255,255,0.03)` (nearly invisible against the card background) with a tooltip explaining they're outside the analyzed range and to widen it via the dropdown; days within the window keep the normal 5-shade quantile scale, including true zero-activity days at level 0.

## Update - 2026-07-07 - all 7 day-of-week labels

- `dayRowLabels` previously only labeled alternating rows (`['', 'Mon', '', 'Wed', '', 'Fri', '']`), GitHub's own convention to reduce label clutter. Changed to `['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']` so every row of the grid shows its day name. No layout change needed - the 28px label column already fit "Wed"/"Thu" at 9px font, and all seven abbreviations are the same 3-character width.
