# Session: Provider Switcher + GitHub Copilot Screen - 2026-05-11

## What was done

- Added a provider switcher bar to the dashboard (Overall | GitHub Copilot | Claude Code | Codex | Antigravity)
- Per-provider card sets generated server-side (`buildProvCards(id)`), shown/hidden client-side via JS
- Per-provider daily chart data computed server-side (`allChartDataJson`) keyed by provider id; chart re-renders on switch
- "Usage by Provider" all-time table hidden when a specific provider is selected
- Copilot credits pill added (fixed position, conditional on `githubUser`)
- Renamed dashboard nav button from "💳 Copilot Pricing" to "🐙 GitHub Copilot"
- Moved GitHub Copilot widgets (budget widget, alert banners, model breakdown, credits summary) to `pricingView.ts`
- Removed "🔧 Tool Usage" section from Usage Analysis Tools & MCP tab
- Removed "📁 Repository Cost Attribution" from Usage Analysis Cost & Impact tab; repo cost now appears in dashboard

## Files changed

- [`src/webview/dashboard.ts`](../../src/webview/dashboard.ts) — computation section rewritten, HTML section overhauled with switcher + per-provider cards + allChartDataJson + provider switching JS; copilot-specific tables removed
- [`src/webview/pricingView.ts`](../../src/webview/pricingView.ts) — complete rewrite; receives metrics + githubUser; shows Copilot usage data when connected; renamed to "GitHub Copilot"
- [`src/webview/usageAnalysis.ts`](../../src/webview/usageAnalysis.ts) — removed Tool Usage section and Repo Cost Attribution section
- [`src/extension.ts`](../../src/extension.ts) — `showPricing` made async, passes `latestMetrics` and `connectedGitHubUser`

## Decisions made

- Server-side HTML generation for per-provider cards (vs. pure client-side DOM): avoids passing full metrics JSON to the webview; keeps the existing pattern of the codebase
- `allChartDataJson` computed for all 5 provider keys (including `overall`) so switching requires no additional data fetch
- Copilot pill uses fixed positioning so it's always visible without scrolling

## Follow-up / known gaps

- Per-provider card sets for codex/antigravity show minimal data when those providers have no sessions — could add a "no data" empty state
- Provider switcher state is lost on dashboard refresh (always resets to Overall)
