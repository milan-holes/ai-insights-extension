---
name: update-model-pricing
description: Update per-token pricing for one or more individual AI models in src/data/modelPricing.json. Use when the user says "update pricing for <model>", "add model <model>", "refresh prices", "the price of <model> changed", or asks to sync pricing with GitHub Copilot / Anthropic / OpenAI / Google / xAI's published rates.
---

# Update Model Pricing

Update or add pricing for specific models in [src/data/modelPricing.json](../../../src/data/modelPricing.json), the single source of truth consumed by [src/core/costEstimation.ts](../../../src/core/costEstimation.ts), [src/webview/pricingView.ts](../../../src/webview/pricingView.ts), and [src/webview/tokenCalculator.ts](../../../src/webview/tokenCalculator.ts).

This skill updates **individual models**, not the whole catalog. If the user wants a full refresh across every model, repeat the steps below per model instead of guessing numbers.

## 1. Identify the model(s) and provider

Map the requested model name to a `provider` value used in the file: `openai`, `anthropic`, `google`, `xai`, `github`, `microsoft`.

Check whether the model already exists as a key in `pricing`:

```bash
grep -n "\"<model-key>\"" src/data/modelPricing.json
```

- If found, this is a **price update** - edit rates in place.
- If not found, this is a **new model** - add an entry (see §4) using the shortest unambiguous prefix of the model ID as the key (e.g. `claude-sonnet-4`, not a full datestamped ID) - this is how `findModelPricing()`'s prefix-match fallback works.

## 2. Fetch the canonical source for that provider

Do not guess numbers or rely on training-data prices - always fetch current data first.

| Provider | Source | Gives you |
|----------|--------|-----------|
| Any Copilot-available model (openai, anthropic, google, github, microsoft, xai) | https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing | Per-token Copilot rates, and whether the model is officially listed (→ `copilotOfficial`) |
| anthropic | https://platform.claude.com/docs/en/about-claude/pricing | Direct Anthropic API rates: input, output, 5m/1h cache write, cache read |
| anthropic | https://platform.claude.com/docs/en/about-claude/models/overview | Current/valid Claude model IDs |

If the user gives you a different source (e.g. a direct OpenAI/Google pricing page) for a non-Copilot rate, use that instead - the table above covers this project's default sources, not the only valid ones.

GitHub Copilot prices are in "AI credits" where 1 credit = $0.01 USD; convert credits/request to $ per 1M tokens using the per-model token ratio shown on that page.

## 3. Convert to the file's rate fields

All rates are **USD per 1,000,000 tokens**:

- `inputCostPerMillion`
- `outputCostPerMillion`
- `cachedInputCostPerMillion` (cache read / hit rate)
- `cacheCreationCostPerMillion` (Anthropic only - cache write rate; omit for other providers)

Anthropic-specific ratios if only the base input rate is published: 5-min cache write = 1.25× input, 1-hour cache write = 2× input, cache read = 0.1× input.

## 4. Edit the JSON

For an existing model, edit only the changed fields in place. For a new model, add an entry following this shape (see existing entries in the file for examples):

```json
"model-key": {
  "displayName": "Human Readable Name",
  "provider": "anthropic",
  "copilotOfficial": true,
  "inputCostPerMillion": 3.00,
  "outputCostPerMillion": 15.00,
  "cachedInputCostPerMillion": 0.30,
  "cacheCreationCostPerMillion": 3.75,
  "category": "Versatile"
}
```

`category` is one of the existing values used in the file (`Lightweight`, `Versatile`, `Powerful`, `Legacy`) - pick by comparing cost to sibling models from the same provider, don't invent a new category.

Update `metadata.lastUpdated` to today's date, and add to `metadata.sources` if you used a URL not already listed there.

Validate the JSON parses:

```bash
node -e "JSON.parse(require('fs').readFileSync('src/data/modelPricing.json','utf8'))"
```

## 5. Update CHANGELOG.md (mandatory per this repo's CLAUDE.md)

Add an entry under the current/next unreleased version describing the pricing change, e.g.:

```
- Updated pricing for Claude Opus 4.8 to match Anthropic's published rates
```

or for a new model:

```
- Added pricing for GPT-5.6 mini
```

## 6. Skip the wiki unless the lookup logic changed

A pure data update to `modelPricing.json` does not need a new `wiki/` file or session log - `wiki/core/costEstimation.md` already documents the schema and lookup rules generically. Only touch the wiki if you changed `findModelPricing()`'s matching behavior, the JSON schema (new fields), or added/removed a provider - in that case follow the normal wiki + session-log rules from the root `CLAUDE.md`.

## 7. Report back

Summarize: which model(s) changed, old → new rates, and the source URL used.
