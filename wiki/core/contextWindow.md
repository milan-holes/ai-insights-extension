# contextWindow — Per-Model Context Window Resolution

| Item | Value |
| ---- | ----- |
| File | [src/core/contextWindow.ts](../../src/core/contextWindow.ts) |
| Data | `contextWindowTokens` in [src/data/modelPricing.json](../../src/data/modelPricing.json) |
| Setting | `aiInsights.context.limitTokens` |

## Purpose

Single source of truth for "how big is this session's context window". Every
context metric needs a denominator; before this module each site hardcoded
`200_000`, which was wrong for the 1M-window Claude models and wrong for every
non-Claude provider the extension tracks.

## Resolution order

| Order | Source | `source` value |
| ----- | ------ | -------------- |
| 1 | `aiInsights.context.limitTokens` (if ≥ 1000) | `override` |
| 2 | `contextWindowTokens` for the model, via `findModelPricingEntry()` | `model` |
| 3 | `DEFAULT_CONTEXT_WINDOW_TOKENS` (128 000) | `default` |

## API

| Export | Purpose |
| ------ | ------- |
| `resolveSessionContextWindow(session)` | Window governing a session — prefers the **most recent** turn's model, falls back to the widest window across `session.models` |
| `resolveContextWindow(model)` | Window for a single model name |
| `getModelContextWindow(model)` | Raw table lookup; `null` when unpublished or `<synthetic>` |
| `contextFillPct(tokens, limit)` | Fill %, clamped 0–100 |
| `setContextWindowOverride(tokens)` | Applies the setting; `0`/`NaN`/`undefined` clears it |
| `getContextWindowOverride()` | Current override, for passing into webviews |

`setContextWindowOverride` is module state rather than a `vscode` import so the
analysis core stays UI-free and testable. `extension.ts` calls it on activation
and from `onDidChangeConfiguration`.

## Why the override exists

A model's maximum window is not always the window a given user gets: the **1M
window on Claude Sonnet / Opus is a gated opt-in**, and nothing in the session
logs records whether it is active (`message.context_management` is present in
the JSONL schema but null in practice). Resolving from the model ID alone would
over-report headroom for users who are not on it, so the model table is the
default and the setting is the escape hatch.

## Data provenance

| Provider | Source of `contextWindowTokens` |
| -------- | ------------------------------- |
| `anthropic` | [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview) — 1M for Fable/Mythos 5, Opus 4.6+ and 5.x, Sonnet 4.6/5.x; 200K for Haiku 4.5 and the 3.5 / 4 / 4.5 generations |
| `openai`, `xai` | Long-context **tier thresholds** in [GitHub Copilot models & pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing). A base/long-context SKU pair is one model billed two ways, so both carry the same window |
| `google` | 1 048 576, carried over from the token calculator's prior table |
| `github`, `microsoft`, `moonshot`, `goldeneye` | **No published window** — field omitted, resolution falls back to the default |

Copilot's page documents the billing threshold, not the model maximum, so the
OpenAI and xAI numbers are the right order of magnitude but are not vendor
context-window figures. Verify against the vendor's own API docs before relying
on them for anything but a fill percentage.

## Consumers

| Consumer | Uses it for |
| -------- | ----------- |
| [[contextRot]] | `contextRunway`, `lostInMiddleRisk`, the context-pressure score term, the `large_static_context` signal |
| [[liveContextTracker]] | Status-bar `ctx: N (P%)` and tooltip |
| [webview/replayView.ts](../../src/webview/replayView.ts) | Context fill bar denominator |
| [webview/tokenCalculator.ts](../../src/webview/tokenCalculator.ts) | Per-model fill % (via `window.TC_CONTEXT`) |

## Adding a model

Add `contextWindowTokens` next to the model's prices in `modelPricing.json`.
Nothing else needs touching — the calculator reads it over `window.TC_PRICING`,
and key order in that file stays load-bearing for lookup (see
[[costEstimation]]).

## Related

- [[costEstimation]] — owns `findModelPricingEntry()` and `normalizeModelName()`
- [[contextRot]] — largest consumer
- [[liveContextTracker]] — status-bar live mode
