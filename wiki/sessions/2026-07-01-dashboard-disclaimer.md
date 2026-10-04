# Session: Dashboard data-accuracy disclaimer - 2026-07-01

## What was done

- Added an "About This Data" section to the bottom of the main dashboard explaining the local-only nature of the extension's metrics.
- Added a matching "⚠️ Accuracy & Limitations" section to the README.
- Researched online whether GitHub Copilot's local session logs can expose real prompt-cache token usage; confirmed they cannot today, and documented this as a 4th disclaimer bullet plus corrected the misleading empty-state note in the existing Copilot Cache Efficiency widget.
- Found and fixed a pre-existing bug while investigating: the Copilot Cache Efficiency widget was reading aggregated all-provider cache metrics instead of a Copilot-only slice.
- Documented all three changes in `CHANGELOG.md` under `[Unreleased]`.

## Files changed

- [src/webview/dashboard.ts](../../src/webview/dashboard.ts) - new disclaimer `.section` rendered just above the page footer, styled like the existing alert/info blocks; added a 4th bullet about Copilot cache tracking; reworded the empty-state note inside `copilotCacheSection` to explain *why* cache data is always empty for Copilot instead of implying the user needs to "enable" caching; imported `computeCacheMetrics` from `../core/budgetManager` and changed `const ch = m.cache` to `const ch = computeCacheMetrics(m.currentMonthByProvider.copilot)` so the widget is actually scoped to Copilot.
- [README.md](../../README.md) - new "Accuracy & Limitations" section between "Cost Estimation" and "Install", with a matching Copilot-cache bullet and source links.
- [CHANGELOG.md](../../CHANGELOG.md) - three new entries under `[Unreleased]`.

## Decisions made

- Called out four specific accuracy caveats since they're not obvious from the UI: (1) usage from the same subscription on another machine isn't visible (local-log-only architecture), (2) clearing/deleting session history removes it from future totals, (3) provider-side system prompts / tool instructions aren't always captured in local logs, partially compensated for by the existing `aiInsights.providers.copilot.inputTokenMultiplier` setting, (4) GitHub Copilot cache token usage can't be tracked locally at all.
- Reused the existing `.section` / alert color conventions instead of introducing a new component, to keep the addition low-risk and consistent with the rest of the dashboard.
- Verified the Copilot cache gap via two community-filed upstream issues rather than assuming: [github/copilot-sdk#1073](https://github.com/github/copilot-sdk/issues/1073) (`assistant.usage.cacheReadTokens`/`cacheWriteTokens` always report `0`, all models) and [microsoft/vscode#311186](https://github.com/microsoft/vscode/issues/311186) (chat debug file logging folds cache reads into the combined input-token count, no separate field). Also confirmed via GitHub's own docs that cached tokens *are* billed separately (cheaper) - the gap is purely in what's exposed to local log readers, not in whether GitHub tracks it server-side.
- Fixed the labeling bug found while investigating: `copilotCacheSection` in `dashboard.ts` was reading `m.cache` (`computeCacheMetrics()` over the aggregated *all-provider* current-month metrics), so if another provider (e.g. Claude Code) had real cache reads, they'd show under the Copilot tab even though Copilot itself always reports zero. Reused the existing `computeCacheMetrics()` from `budgetManager.ts` against `m.currentMonthByProvider.copilot` instead of duplicating the calculation inline.

## Follow-up / known gaps

- The `inputTokenMultiplier` mitigation currently only exists for Copilot JSON sessions; other providers (Claude Code, Codex, Antigravity) don't have an equivalent knob if their logs ever under-report context.
