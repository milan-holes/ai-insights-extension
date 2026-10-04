# AI Insights - Wiki

Auto-maintained documentation for the `ai-insights` VS Code extension.  
This wiki is written and kept up-to-date by AI assistants (Claude Code, GitHub Copilot, Antigravity, Codex) as part of the **llm-wiki** approach. See [llm-wiki-setup.md](llm-wiki-setup.md) for how it works.

## Contents

| Path                                                                                                     | Description                                                                                    |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                                                                       | System overview, data flow, module map                                                         |
| [standalone-electron.md](standalone-electron.md)                                                         | Standalone Electron host - separate build, storage, service, and host-boundary rules            |
| [providers/base.md](providers/base.md)                                                                   | `BaseProvider` abstract class                                                                  |
| [providers/claudeCode.md](providers/claudeCode.md)                                                       | Claude Code JSONL adapter                                                                      |
| [providers/antigravity.md](providers/antigravity.md)                                                     | Antigravity (Gemini) adapter                                                                   |
| [providers/copilot.md](providers/copilot.md)                                                             | GitHub Copilot adapter                                                                         |
| [providers/codex.md](providers/codex.md)                                                                 | Codex rollout JSONL adapter                                                                    |
| [providers/jetbrainsAI.md](providers/jetbrainsAI.md)                                                     | GitHub Copilot for JetBrains JSONL adapter (~/.copilot/jb/)                                    |
| [providers/visualStudio.md](providers/visualStudio.md)                                                   | Visual Studio Copilot Chat MessagePack adapter (.vs/**/copilot-chat/, WSL2-aware)              |
| [core/sessionAggregator.md](core/sessionAggregator.md)                                                   | Session merging & metrics                                                                      |
| [core/costEstimation.md](core/costEstimation.md)                                                         | Cost calculation & pricing lookup                                                              |
| [core/contextWindow.md](core/contextWindow.md)                                                           | Per-model context window resolution — model table + `aiInsights.context.limitTokens` override  |
| [core/environmentalImpact.md](core/environmentalImpact.md)                                               | CO₂ / water / tree estimates                                                                   |
| [core/cacheManager.md](core/cacheManager.md)                                                             | File modification cache                                                                        |
| [core/sessionSnapshotStore.md](core/sessionSnapshotStore.md)                                             | Persistent Copilot session snapshot store — survives chat clears                               |
| [core/repositoryHygiene.md](core/repositoryHygiene.md)                                                   | Repository AI config file scanner                                                              |
| [core/promptHistory.md](core/promptHistory.md)                                                           | Per-prompt record store — PromptHistoryStore + PromptRecord                                    |
| [core/contextRot.md](core/contextRot.md)                                                                 | Context rot scorer — 0–10 health score per session from static signals                         |
| [core/diffTracker.md](core/diffTracker.md)                                                               | Copilot code-diff outcome tracker — accepted / updated / declined counts                       |
| [core/usageHealthScore.md](core/usageHealthScore.md)                                                     | Composite 0-100 AI Health score — 5 weighted components, plain-language `rule` per component   |
| [core/contextReferences.md](core/contextReferences.md)                                                   | Context-anchoring detection — #file/@workspace token counting + rollup                         |
| [core/sessionHygiene.md](core/sessionHygiene.md)                                                         | Compaction accounting (manual/auto, tokens reclaimed) + marathon-session rollup                |
| [core/insightsEngine.md](core/insightsEngine.md)                                                         | Rule-based insights/nudge catalog — dismissable/snoozable, replaces static recommendations      |
| [webview/security.md](webview/security.md)                                                                | Webview threat model — escaping helpers, CSP + nonce rules, vendored libraries                  |
| [webview/designSystem.md](webview/designSystem.md)                                                       | Shared design tokens for all webviews — Replay blue-slate palette, usage rules                 |
| [webview/promptHistoryView.md](webview/promptHistoryView.md)                                             | Prompt History panel — sparkline, summary cards, per-prompt table                              |
| [webview/sessionsList.md](webview/sessionsList.md)                                                       | Sessions list panel v1 - per-session table with filters                                        |
| [webview/sessionsView.md](webview/sessionsView.md)                                                       | Sessions view panel v2 - postMessage-based, no esbuild injection issues                        |
| [proposed-metrics.md](proposed-metrics.md)                                                               | Proposed new metrics - driven by Copilot's June 2026 usage-based billing shift                 |
| [sessions/2026-04-29-wsl2-workspace-resolution.md](sessions/2026-04-29-wsl2-workspace-resolution.md)     | WSL2 workspace path resolution fixes across all three providers                                |
| [sessions/2026-05-01-changelog-instructions.md](sessions/2026-05-01-changelog-instructions.md)           | Added automatic CHANGELOG update instructions for Claude, Copilot, and Antigravity             |
| [sessions/2026-05-01-llm-wiki-all-providers.md](sessions/2026-05-01-llm-wiki-all-providers.md)           | Expanded llm-wiki setup and instructions to cover Claude, Copilot, Antigravity, and Codex      |
| [sessions/2026-05-01-sessions-screen-empty-fix.md](sessions/2026-05-01-sessions-screen-empty-fix.md)     | Fixed sessions screen always empty: stale allSessions + esbuild base64 evaluation bug          |
| [sessions/2026-05-02-sessions-view-postmessage.md](sessions/2026-05-02-sessions-view-postmessage.md)     | New Sessions v2 panel using postMessage instead of template injection                          |
| [sessions/2026-05-02-sessions-table-improvements.md](sessions/2026-05-02-sessions-table-improvements.md) | Title column, AI credits, scroll fix, Antigravity date bug fix, v1 removal                     |
| [sessions/2026-05-02-copilot-pricing-screen.md](sessions/2026-05-02-copilot-pricing-screen.md)           | New Pricing screen with official Copilot model pricing; modelPricing.json metadata added       |
| [sessions/2026-05-02-sessions-improvements.md](sessions/2026-05-02-sessions-improvements.md)             | Daily attribution fix, Codex titles, credits/cost split, open session, export CSV             |
| [sessions/2026-05-02-acceptance-rate.md](sessions/2026-05-02-acceptance-rate.md)                         | Acceptance Rate quality-proxy metric: AcceptanceTracker, Quality tab in Usage Analysis         |
| [webview/pricingView.md](webview/pricingView.md)                                                         | Pricing reference screen - official Copilot model rates grouped by provider                    |
| [webview/claudeAccountView.md](webview/claudeAccountView.md)                                             | Claude Account panel — API key connect, live rate limits, local usage stats                    |
| [core/quotaGuard.md](core/quotaGuard.md)                                                                 | Cross-provider quota risk - "minutes of work left" model, burn rate, false-alarm rules          |
| [core/sessionCheckpoint.md](core/sessionCheckpoint.md)                                                   | Non-invasive git snapshots of interrupted work - temp-index commit, never touches tree/HEAD     |
| [core/sessionHandoff.md](core/sessionHandoff.md)                                                         | Handoff brief for quota-interrupted work + delegation to a provider with headroom               |
| [sessions/2026-10-03-quota-guard-handoff.md](sessions/2026-10-03-quota-guard-handoff.md)                 | Quota Guard, safe-stop checkpoints, session handoff; Codex rate_limits parsing                  |
| [sessions/2026-10-03-copilot-quota-burn-rate.md](sessions/2026-10-03-copilot-quota-burn-rate.md)       | Copilot quota exhaustion estimate from cycle-to-date usage                                      |
| [sessions/2026-10-03-startup-performance.md](sessions/2026-10-03-startup-performance.md)                 | 19.7s activation traced to sync provider I/O; discovery caches, persisted parse cache, deferred refresh |
| [performance.md](performance.md)                                                                         | **Mandatory** rules for the activation/refresh path: budgets, yielding, syscall patterns, how to measure |
| [core/budgetManager.md](core/budgetManager.md)                                                           | Budget, cache, ROI, anomaly & session-complexity metric computations                           |
| [core/githubAuth.md](core/githubAuth.md)                                                                 | GitHub OAuth — detect Copilot plan and auto-set budget                                         |
| [core/copilotQuota.md](core/copilotQuota.md)                                                             | Real GitHub Copilot quota fetch (remaining/entitlement/reset) + local history + burn-rate prediction |
| [sessions/2026-05-04-sessions-date-range-pagination.md](sessions/2026-05-04-sessions-date-range-pagination.md) | Sessions date range fix (400-day lookback) + 50-per-page pagination |
| [sessions/2026-05-10-context-rot-identifier.md](sessions/2026-05-10-context-rot-identifier.md)               | Context rot identifier: per-session health badge in Sessions table |
| [sessions/2026-05-11-provider-switcher-copilot-screen.md](sessions/2026-05-11-provider-switcher-copilot-screen.md) | Provider switcher on dashboard + GitHub Copilot screen migration |
| [webview/tokenCalculator.md](webview/tokenCalculator.md)                                                         | Token Calculator panel — workspace file picker + prompt token estimator |
| [core/liveSessionMonitor.md](core/liveSessionMonitor.md)                                                         | Live session detection, burn rate, budget projection, and alert generation |
| [core/liveContextTracker.md](core/liveContextTracker.md)                                                         | File-system watcher → real-time context health for the status bar (Claude Code only) |
| [core/liveTokenCounter.md](core/liveTokenCounter.md)                                                             | Live status bar token counter — selection/doc count, model cycling, token highlighting |
| [sessions/2026-05-16-live-monitor-context-workbench.md](sessions/2026-05-16-live-monitor-context-workbench.md)   | Live Monitor + Context Workbench — v0.1.7 |
| [sessions/2026-05-16-technique-benchmark.md](sessions/2026-05-16-technique-benchmark.md)                         | Technique Benchmark — worktree-isolated context technique comparison |
| [sessions/2026-05-18-context-workbench-timeline.md](sessions/2026-05-18-context-workbench-timeline.md)           | Context Workbench: blank-screen fix + Context Size + Interaction Timeline panels |
| [sessions/2026-05-18-benchmark-generalization.md](sessions/2026-05-18-benchmark-generalization.md)               | Benchmark tasks and ROT_HISTORY made generic — works on any installed repository, not just ai-insights |
| [developer-guide.md](developer-guide.md)                                                                 | /clear and /compact behaviour per provider — when data is safe vs. at risk                     |
| [webview/sessionCompareView.md](webview/sessionCompareView.md)                                           | Session comparison panel — side-by-side token, cost, tool, mode, and context health metrics    |
| [webview/replayView.md](webview/replayView.md)                                                           | Session Replay panel — turn-by-turn scrubber with context fill, token breakdown, and cost meter |
| [core/sessionTagsStore.md](core/sessionTagsStore.md)                                                     | Persistent tag store — maps sessionId → tags[], stored as JSON in globalStorageUri             |
| [sessions/2026-06-04-session-compare-and-tags.md](sessions/2026-06-04-session-compare-and-tags.md)       | Session comparison panel + session tags with filtering                                         |
| [sessions/2026-06-05-session-analysis-precision.md](sessions/2026-06-05-session-analysis-precision.md)   | Session precision: effectiveContextTokens, MCP tracking, fixed cacheEfficiencyRate & rot signals |
| [sessions/2026-06-09-session-replay.md](sessions/2026-06-09-session-replay.md)                           | Session Replay feature — turn-by-turn interactive playback of any session |
| [sessions/2026-06-09-stats-sharing.md](sessions/2026-06-09-stats-sharing.md)                             | Stats sharing via local HTTP server — Share button, ShareServer, LAN URL with token |
| [sessions/2026-06-11-webview-design-system.md](sessions/2026-06-11-webview-design-system.md)             | Unified all webviews on shared design tokens (designSystem.ts), Replay palette as default |
| [core/repoAnalyzer.md](core/repoAnalyzer.md)                                                             | Static TS analysis engine — dependency graph & agent handoff document generator                |
| [sessions/2026-07-01-dashboard-disclaimer.md](sessions/2026-07-01-dashboard-disclaimer.md)                | Dashboard "About This Data" disclaimer + README Accuracy & Limitations section                 |
| [sessions/2026-07-01-activity-heatmap.md](sessions/2026-07-01-activity-heatmap.md)                        | GitHub-style Activity Heatmap section added to the main dashboard                              |
| [sessions/2026-07-01-interaction-mode-fix.md](sessions/2026-07-01-interaction-mode-fix.md)                | Fixed Interaction Modes widget always showing 100% CLI for Claude Code sessions                |
| [core/aiStructureAnalyzer.md](core/aiStructureAnalyzer.md)                                               | Repository panel — providers, instruction scope, skills, agents & MCP servers for the open workspace |
| [sessions/2026-07-01-ai-structure-webview.md](sessions/2026-07-01-ai-structure-webview.md)               | New "AI Setup" panel (later renamed "Repository"): repository AI-structure analysis            |
| [sessions/2026-07-01-cache-hit-table-fix.md](sessions/2026-07-01-cache-hit-table-fix.md)                 | Fixed "Usage by Provider" Cache Hit % overflow bug + "-" for untrackable providers              |
| [sessions/2026-07-01-nav-reorg-and-heatmap-lookback.md](sessions/2026-07-01-nav-reorg-and-heatmap-lookback.md) | Renamed/reordered "Repository" tab, hid Benchmark tab, added lookback-days control to heatmap |
| [sessions/2026-07-01-dashboard-inline-script-syntax-fix.md](sessions/2026-07-01-dashboard-inline-script-syntax-fix.md) | Fixed SyntaxError in dashboard inline script that broke period selector, dynamic tables & share panel |
| [sessions/2026-07-03-copilot-real-cache-tokens.md](sessions/2026-07-03-copilot-real-cache-tokens.md)     | Real Copilot cache/token data from debug-logs + transcripts/ discovery (previous "unavailable" finding was a discovery bug) |
| [sessions/2026-07-04-copilot-cache-estimated-label-fix.md](sessions/2026-07-04-copilot-cache-estimated-label-fix.md) | Fixed dashboard/pricing views mislabeling real Copilot cache telemetry as "(calc.)" |
| [sessions/2026-07-04-copilot-cache-investigation.md](sessions/2026-07-04-copilot-cache-investigation.md) | Why older sessions lack cache estimates; corrected transcripts/ version claim; fixed Remote-WSL real-data correlation bug |
| [sessions/2026-07-05-copilot-cache-docs-and-dashboard-button.md](sessions/2026-07-05-copilot-cache-docs-and-dashboard-button.md) | Documented debug-log setting's effect on cache data + added dashboard "Enable Real Cache Data" button |
| [core/abTesting.md](core/abTesting.md)                                                                   | A/B test one prompt across provider/model variants, each in its own git worktree               |
| [sessions/2026-07-05-ab-test-prompts.md](sessions/2026-07-05-ab-test-prompts.md)                         | New A/B Test Prompts panel + nav bar entry + tokens/code-produced/time recap stats               |
| [webview/diagnosticsView.md](webview/diagnosticsView.md)                                                 | Settings panel (formerly "Diagnostics") — all-settings editor, reordered sections, last nav tab |
| [sessions/2026-07-05-settings-panel-reorg.md](sessions/2026-07-05-settings-panel-reorg.md)                | Diagnostics → Settings rename/reorg: editable settings table, providers moved to bottom, version bug fix |
| [sessions/2026-07-05-custom-session-folders-all-providers.md](sessions/2026-07-05-custom-session-folders-all-providers.md) | additionalSessionPaths generalized to all 6 providers; Antigravity multi-root refactor + cross-root metadata bug fix |
| [sessions/2026-07-08-copilot-quota.md](sessions/2026-07-08-copilot-quota.md)                             | Real GitHub Copilot quota fetch (remaining/entitlement/reset, burn-rate prediction) via GitHub's internal `copilot_internal/user` endpoint |
| [core/claudeQuota.md](core/claudeQuota.md)                                                               | Real Claude Code plan-quota (5h/7d %) via OAuth token reuse — zero-config, no API key entry |
| [sessions/2026-08-25-quota-planner-and-coach.md](sessions/2026-08-25-quota-planner-and-coach.md) | Claude live plan-quota, Copilot budget planner, and Coach — three ranked feature gaps closed |
| [sessions/2026-08-25-remove-coach-tab.md](sessions/2026-08-25-remove-coach-tab.md) | Removal of the Coach tab, its detectors, types and docs |
| [sessions/](sessions/)                                                                                   | Per-session coding logs                                                                        |
| [sessions/2026-08-25-webview-security-hardening.md](sessions/2026-08-25-webview-security-hardening.md) | Settings scope, output escaping, CSP + nonces, vendored Chart.js/Mermaid (SEC-01..04) |
| [sessions/2026-10-03-pricing-refresh.md](sessions/2026-10-03-pricing-refresh.md) | modelPricing.json refresh: GPT-5.6 Sol correction, GPT-6/Claude x.5/Kimi K3 additions, Copilot delistings, key-order fix |
| [sessions/2026-10-03-configurable-context-window.md](sessions/2026-10-03-configurable-context-window.md) | Configurable per-model context window (issue #1) - model table + override setting      |
| [core/copilotBillingCalibration.md](core/copilotBillingCalibration.md)                                     | `copilotUsageNanoAiu` as a ground-truth oracle - per-model rate factor measured from real billed requests |
| [core/copilotPrefix.md](core/copilotPrefix.md)                                                             | Fixed prompt prefix from Copilot's sidecars - system prompt + tool catalog, and the schema never called |
| [sessions/2026-10-03-copilot-billed-cost-and-prefix.md](sessions/2026-10-03-copilot-billed-cost-and-prefix.md) | Exact billed cost, pricing calibration to 0.0009%, cost provenance labels, prompt-prefix attribution |
| [copilot-billing-calibration.md](copilot-billing-calibration.md)                                           | `copilotUsageNanoAiu` as ground truth — Copilot's billing formula reverse-engineered to 0.0009%, and the two biases in our estimator |
| [sessions/2026-10-03-wiki-scope-separation.md](sessions/2026-10-03-wiki-scope-separation.md)             | Wiki scope split: product docs only; research about other projects moved out, rule 6 / 1d codified |
| [sessions/2026-10-03-standalone-electron-host.md](sessions/2026-10-03-standalone-electron-host.md)       | Standalone Electron host, shared standalone service, separate build scripts                     |
| [sessions/2026-10-03-local-model-pricing.md](sessions/2026-10-03-local-model-pricing.md) | Local / own-key models in VS Code Chat: $0 or vendor list rate, "Local" tags, whole-name price matching |
| [llm-wiki-setup.md](llm-wiki-setup.md)                                                                   | LLM-wiki approach & AI instructions                                                            |

## Quick facts

- **Package name**: `ai-insights` (`AI Insights - Token Tracker`)
- **Version**: 0.1.17
- **Providers**: GitHub Copilot · Antigravity (Gemini) · Claude Code · Codex · Copilot (JetBrains) · Visual Studio
- **Extension entry point**: `src/extension.ts`
- **Electron entry point**: `src/electron/main.ts`
- **Extension build**: `npm run compile` → `dist/extension.js` via esbuild
- **Standalone build**: `npm run electron:compile` → `dist/electron/*` via esbuild
