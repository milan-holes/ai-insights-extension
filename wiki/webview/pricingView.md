# pricingView.ts

Static reference screen showing official GitHub Copilot model pricing.

## Source

[`src/webview/pricingView.ts`](../../src/webview/pricingView.ts)

## Purpose

Gives users a quick reference for how AI credits are spent per model, grouped by provider.  
Data is read from [`src/data/modelPricing.json`](../../src/data/modelPricing.json) at build time.

## What's displayed

| Column | Notes |
|---|---|
| Model name + ID | `displayName` and JSON key |
| Status badge | `✓ Official` (green) if `copilotOfficial: true`, else `other` (muted) |
| Input $/1M | Uncached prompt tokens |
| Cached input $/1M | Cache-hit prompt tokens |
| Cache write $/1M | Cache creation; shown only for Anthropic models |
| Output $/1M | Completion tokens |
| Input credits/1M | `inputCostPerMillion / 0.01` |
| Output credits/1M | `outputCostPerMillion / 0.01` |
| Tier | Category badge (Powerful / Versatile / Lightweight / Legacy) |

Models are grouped by provider (`openai → anthropic → google → xai`) and sorted: official first, then by ascending input rate.

## Credit formula

```
credits = (input × input_$/1M + cache_read × cached_$/1M
         + cache_write × write_$/1M + output × output_$/1M) / 1,000,000 / 0.01
```

## Real Quota & Budget Planner (added 2026-08-25)

`PricingViewProvider.createPanel`/`getHtml` now also accept an optional `copilotQuota: CopilotQuotaView` (from [copilotQuota.ts](../core/copilotQuota.md), the same object already used by the dashboard's Copilot provider card) - previously **not passed to this screen at all**, so the dedicated Copilot screen showed only the token-derived estimate, never GitHub's real remaining/entitlement/reset numbers.

When present, a new "🐙 Real Quota & Budget Planner" section renders:
- A card with real remaining/entitlement, % left, and reset countdown (same styling as the dashboard's quota card).
- A **Budget Planner**: model-cost-multiplier chips (`0.33×`/`1×`/`3×` + custom input) and a reserve-credits input, feeding [`computeBudgetPlan()`](../core/copilotQuota.md#budget-planner-computebudgetplan) to show sustainable requests/day and /week until reset.

Config (`{ modelMultiplier, reserveCredits }`) is persisted in `context.globalState` under `aiInsights.copilotBudgetPlanner`. The `setPlannerConfig` webview message updates it and re-renders the panel in place (full `panel.webview.html` reassignment - this file has no CSP nonce/partial-update precedent, so it follows its own existing full-reload convention rather than `claudeAccountView.ts`'s surgical `postMessage` pattern). Section is omitted entirely when GitHub isn't connected (`copilotQuota` undefined).

## Navigation

Opened via:
- Command: `AI Insights: Show Copilot Model Pricing` (`aiInsights.showPricing`)
- `💳 Pricing` button in the dashboard nav bar
- Nav buttons inside the screen navigate back to other views

## Official models (as of 2026-05-02)

OpenAI: GPT-4.1, GPT-5 mini, GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex, GPT-5.4, GPT-5.4 mini, GPT-5.4 nano, GPT-5.5  
Anthropic: Claude Haiku 4.5, Claude Opus 4.5 / 4.6 / 4.7  
Google: Gemini 2.5 Pro  
xAI: Grok Code Fast 1

Source: [docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
